/**
 * The only file that talks to SQLite directly.
 *
 * Atrium uses the `node:sqlite` module built into Node 22, which means no
 * native module to compile and no dependency to install. That module is still
 * marked experimental, so everything it touches is kept behind this wrapper:
 * moving to `better-sqlite3` later is a change to one file, not to the codebase.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * Loaded through `createRequire` rather than a plain import on purpose.
 *
 * Node keeps `sqlite` out of `builtinModules` while it is experimental, so
 * tools that decide what is built in by consulting that list — Vite and
 * therefore Vitest among them — do not recognise `node:sqlite`, strip the
 * prefix, and go looking for a package called `sqlite` on disk. Going through
 * `createRequire` hands the specifier straight to Node and behaves the same
 * under the test runner, under plain node, and under any bundler.
 */
interface SqliteStatement {
  run(
    ...params: SqlValue[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqlite {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

silenceSqliteExperimentalWarning();

/**
 * `node:sqlite` is reached through `require` rather than a static import
 * because it is still flagged experimental and a static import makes Node
 * print a warning before this file can silence it.
 *
 * Which `require` depends on how this code was loaded. Run normally it is an
 * ES module, so there is no `require` and one is built from `import.meta.url`.
 * Bundled into a single executable it is CommonJS, where `require` exists and
 * `import.meta` does not — and the bundler quietly compiles `import.meta.url`
 * to an empty object rather than failing, so getting this wrong would not
 * break the build. It would produce a binary that dies the first time anybody
 * opened a room, which is a worse way to find out.
 */
const requireSqlite: NodeRequire =
  typeof require === "function" ? require : createRequire(import.meta.url);

const { DatabaseSync } = requireSqlite("node:sqlite") as NodeSqlite;

export interface Statement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = Record<string, SqlValue>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, SqlValue>>(...params: SqlValue[]): T[];
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /**
   * Runs `fn` inside a write transaction and returns what it returned. If `fn`
   * throws, nothing it did is kept.
   *
   * The outermost call opens with BEGIN IMMEDIATE, which takes the database's
   * write lock up front. That is what makes read-then-write safe when the
   * readers are separate agent processes: checking whether a task is claimed and
   * recording the claim happen with nobody able to slip in between. Nested calls
   * use savepoints so helpers can compose.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly path: string;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // busy_timeout goes first, and the order is the whole point rather than a
  // tidiness preference.
  //
  // Setting the journal mode takes a lock on the database. Every other room in
  // this project is opened by several processes at once — that is what §6's
  // atomic claim exists for — so another process holding that lock at this
  // moment is ordinary, not exceptional. With no busy timeout in effect yet,
  // the WAL pragma failed immediately with "database is locked", and a room
  // that could not be *opened* took down whatever was opening it: a worker, or
  // `atrium serve` dying before it answered a single message.
  //
  // The timeout was always here. It was simply set one line too late to cover
  // the one statement most likely to meet a lock.
  db.exec("PRAGMA busy_timeout = 5000");

  // Readers never block the writer, and a writer that finds the lock held now
  // waits a few seconds instead of failing on the spot.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  let depth = 0;

  return {
    path,

    exec(sql) {
      db.exec(sql);
    },

    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          const r = stmt.run(...params);
          return {
            changes: Number(r.changes),
            lastInsertRowid: Number(r.lastInsertRowid),
          };
        },
        get(...params) {
          return stmt.get(...params) as never;
        },
        all(...params) {
          return stmt.all(...params) as never;
        },
      };
    },

    transaction<T>(fn: () => T): T {
      const outermost = depth === 0;
      const savepoint = `atrium_sp_${depth}`;

      if (outermost) db.exec("BEGIN IMMEDIATE");
      else db.exec(`SAVEPOINT ${savepoint}`);
      depth++;

      try {
        const result = fn();
        depth--;
        if (outermost) db.exec("COMMIT");
        else db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        depth--;
        try {
          if (outermost) {
            db.exec("ROLLBACK");
          } else {
            db.exec(`ROLLBACK TO ${savepoint}`);
            db.exec(`RELEASE ${savepoint}`);
          }
        } catch {
          // The rollback itself failing would otherwise hide the real error.
        }
        throw err;
      }
    },

    close() {
      db.close();
    },
  };
}

/**
 * Node prints "SQLite is an experimental feature" the first time the module is
 * used. Depending on it is a deliberate choice, so that one warning is dropped
 * and every other warning is left alone.
 */
function silenceSqliteExperimentalWarning(): void {
  const original = process.emit.bind(process);
  process.emit = function (
    this: NodeJS.Process,
    name: string | symbol,
    ...args: unknown[]
  ) {
    const warning = args[0];
    if (
      name === "warning" &&
      warning instanceof Error &&
      warning.name === "ExperimentalWarning" &&
      warning.message.includes("SQLite")
    ) {
      return false;
    }
    return original(name as never, ...(args as never[]));
  } as typeof process.emit;
}
