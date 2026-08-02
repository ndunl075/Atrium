/**
 * Getting context, tier 2 (see ARCHITECTURE.md §4): on-demand full-text search
 * over the room's working directory.
 *
 * No embeddings, no vector store, by design: most rooms hold a few hundred
 * files, and at that size FTS beats semantic search on both precision and
 * setup cost. Add embeddings later if a real room proves this wrong, not
 * before.
 *
 * The index is built fresh, in memory, on every call rather than kept on disk
 * between calls. Rooms are small enough that walking the directory is cheap,
 * and a stale index quietly giving a wrong answer is a worse failure than
 * spending a few milliseconds rebuilding one. This also means there is no
 * on-disk index to keep in sync with writes, leases, or deletes.
 *
 * Rebuilding per call does mean one query costs work proportional to the room,
 * and `search_artifacts` is a tool any member can call in a loop. Measured on
 * the development machine it runs about 0.4ms per file: a few hundred files —
 * the size this is designed for — is tens of milliseconds, but ten thousand is
 * over four seconds of CPU and tens of megabytes of churn, per call, from one
 * small request. So the walk stops at a ceiling.
 *
 * The ceiling is not a cache, deliberately. Caching would need an invalidation
 * signal, and the only cheap one available is the log — which does not see a
 * file edited on disk by hand, something this search reads and the log never
 * records. That is precisely the stale wrong answer the paragraph above
 * refuses. Bounding the work keeps every answer current and makes the cost of
 * one call predictable; what it gives up is completeness in a room larger than
 * the ceiling, which is reported rather than hidden (`IndexStats.truncated`)
 * and can be raised or narrowed with `pathPrefix`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Db, openDb } from "./db.js";
import { InvalidError } from "./errors.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";

export interface SearchHit {
  path: string;
  /** Higher is a better match. Derived from SQLite's bm25(), sign-flipped so
   * "higher is better" holds without callers needing to know FTS5 internals. */
  score: number;
  excerpt: string;
  bytes: number;
}

/** Bounds on how much of a room one call will read. See the module header. */
export interface IndexLimits {
  /** Largest single file to index, in bytes. Bigger ones are skipped. */
  maxBytes?: number;
  /** Most files to index in one call. */
  maxFiles?: number;
  /** Most bytes to index in one call, summed across files. */
  maxTotalBytes?: number;
}

export interface SearchOptions extends IndexLimits {
  limit?: number;
  /** Limit matches to this artifact path, or to files beneath it. */
  pathPrefix?: string;
}

export type IndexOptions = IndexLimits;

export interface IndexStats {
  files: number;
  skipped: number;
  /**
   * Whether a ceiling stopped the walk before the room ran out. When true,
   * `files` counts what was indexed, not what is there, and a search can only
   * have looked at that much — so "no results" does not mean "not present".
   */
  truncated: boolean;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Ceilings for one call. Set well above the few hundred files this is designed
 * for, so an ordinary room never meets them, and low enough that the worst case
 * stays under about a second rather than growing with whatever a member decided
 * to write. Both are raisable per call for a room that genuinely is larger.
 */
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Directory names never walked into, wherever they appear in the tree. */
const SKIPPED_DIRS = new Set([".atrium", "node_modules", ".git", "dist"]);

/** How many leading bytes to check for a null byte when guessing binary. */
const BINARY_SNIFF_BYTES = 8000;

export function searchArtifacts(
  room: Room,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new InvalidError("limit must be a whole number, zero or more.");
  }
  const limits = resolveLimits(options);
  const pathPrefix =
    options.pathPrefix === undefined
      ? undefined
      : toArtifactPath(
          room.dir,
          resolveArtifact(room.dir, options.pathPrefix),
        );

  // Extracting only word-ish tokens, rather than trying to escape whatever the
  // caller sent, is what makes this safe against arbitrary input. Queries come
  // from language models: quotes, parens, `AND`/`OR`/`NOT`, bare `*`, anything.
  // None of those characters ever reach the FTS5 MATCH string because none of
  // them are word characters, so there is no escaping function to get subtly
  // wrong. A query with no word characters in it (empty, or only punctuation)
  // has nothing to search for, so it is answered with no results up front
  // rather than by asking FTS5 to parse something that isn't a query.
  const matchQuery = buildMatchQuery(query);
  if (!matchQuery || limit === 0) return [];

  const { db, files } = buildIndex(room, limits);
  try {
    if (files === 0) return [];

    const pathClause =
      pathPrefix === undefined
        ? ""
        : " AND (path = ? OR substr(path, 1, ?) = ?)";
    const params: Array<string | number> = [matchQuery];
    if (pathPrefix !== undefined) {
      const subtree = `${pathPrefix}/`;
      params.push(pathPrefix, subtree.length, subtree);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT path, bytes, bm25(docs) as rank,
                snippet(docs, 1, '', '', ' … ', 12) as excerpt
         FROM docs WHERE docs MATCH ?${pathClause}
         ORDER BY bm25(docs) LIMIT ?`,
      )
      .all<{ path: string; bytes: number; rank: number; excerpt: string }>(
        ...params,
      );

    return rows.map((row) => ({
      path: row.path,
      score: -row.rank,
      excerpt: row.excerpt,
      bytes: row.bytes,
    }));
  } finally {
    db.close();
  }
}

/**
 * Walks the room and reports how much of it is searchable, without running a
 * query. Exposed mainly so a caller can tell "no results" apart from "nothing
 * was indexed" (e.g. an empty room, everything over maxBytes, or a room big
 * enough that a ceiling stopped the walk — `truncated`).
 */
export function indexRoom(room: Room, options: IndexOptions = {}): IndexStats {
  const { db, files, skipped, truncated } = buildIndex(room, resolveLimits(options));
  db.close();
  return { files, skipped, truncated };
}

function buildIndex(
  room: Room,
  limits: Required<IndexLimits>,
): { db: Db; files: number; skipped: number; truncated: boolean } {
  const { maxBytes, maxFiles, maxTotalBytes } = limits;
  const db = openDb(":memory:");
  // `bytes` is UNINDEXED: it rides along for the SearchHit shape but has no
  // business being tokenized and searched.
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(path, body, bytes UNINDEXED)");
  const insert = db.prepare(
    "INSERT INTO docs (path, body, bytes) VALUES (?, ?, ?)",
  );

  let files = 0;
  let skipped = 0;
  let totalBytes = 0;
  let truncated = false;

  // Entries are walked in a stable order so that a truncated index is at least
  // the same truncated index next time, rather than a different arbitrary
  // subset per call.
  const walk = (dir: string): void => {
    if (truncated) return;
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

    for (const entry of entries) {
      if (truncated) return;
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, etc: not artifacts

      const bytes = statSync(abs).size;
      if (bytes > maxBytes) {
        skipped++;
        continue;
      }

      // Checked before reading, not after: the point is to stop doing work,
      // and by the time a file is in memory the work is already done.
      if (files >= maxFiles || totalBytes + bytes > maxTotalBytes) {
        truncated = true;
        return;
      }

      const buf = readFileSync(abs);
      if (looksBinary(buf)) {
        skipped++;
        continue;
      }

      insert.run(toArtifactPath(room.dir, abs), buf.toString("utf8"), bytes);
      files++;
      totalBytes += bytes;
    }
  };

  walk(room.dir);
  return { db, files, skipped, truncated };
}

/** Fills in the ceilings, validating anything the caller set. */
function resolveLimits(options: IndexLimits): Required<IndexLimits> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  validateMaxBytes(maxBytes);
  for (const [name, value] of [
    ["maxFiles", maxFiles],
    ["maxTotalBytes", maxTotalBytes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new InvalidError(`${name} must be a whole number, zero or more.`);
    }
  }
  return { maxBytes, maxFiles, maxTotalBytes };
}

function looksBinary(buf: Buffer): boolean {
  const scanLength = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < scanLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new InvalidError("maxBytes must be a whole number, zero or more.");
  }
}

/** A run of letters or digits, allowing internal `-`/`_`/`'` (e.g. "test-case"). */
const WORD_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

/**
 * Turns free text into an FTS5 MATCH string, or null if there is nothing in it
 * worth searching for.
 *
 * Every extracted token is individually double-quoted, which makes it a
 * phrase to FTS5 rather than an operator or a syntax character, and OR'd
 * together so a multi-word query is forgiving about which of its words a
 * document actually contains.
 */
function buildMatchQuery(raw: string): string | null {
  const tokens = raw.match(WORD_TOKEN);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
