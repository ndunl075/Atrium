/**
 * What happens when several processes use one room at once.
 *
 * Atrium is built for this — §6's atomic claim exists precisely because two
 * agents in two processes go for the same task — but every test until now
 * drove a room from a single process, so nothing exercised the parts that
 * only break when two of them meet. Three bugs lived there undisturbed, and
 * all three were found by a flaky CI job rather than by this suite:
 *
 *   1. Opening a room could fail outright with "database is locked", because
 *      `PRAGMA busy_timeout` was set one line *after* the pragma most likely
 *      to meet a lock.
 *   2. `writeJson` wrote every update through the same `.tmp` filename, so two
 *      writers raced and the loser died with ENOENT — the atomic-rename dance
 *      made the write less safe than doing it in place.
 *   3. Joining read, changed and rewrote the token file with no lock, so a
 *      second join could silently drop the first member's credential.
 *
 * Real processes rather than promises: all three needed two OS processes and
 * a shared file, and none of them reproduce in a single one.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Room } from "./room.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repo, "dist", "index.js").replace(/\\/g, "/");

/** Generous: these spawn real processes on whatever CI machine is going. */
const TIMEOUT_MS = 60_000;

/**
 * Enough contention to make the bugs show up rather than sometimes show up.
 *
 * This number was measured, not guessed. With the `busy_timeout` ordering bug
 * put back, five concurrent joiners passed on this machine and twelve failed
 * on the first run — so five would have been a test that watched the bug go
 * past. Contention bugs are probabilistic; a regression test for one has to
 * push hard enough that the probability stops mattering.
 */
const JOINERS = 12;

let workspace: string;
let joiner: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "atrium-concurrent-"));
  joiner = join(workspace, "join.mjs");

  // A whole process whose only job is to join a room, so the contention is
  // between real processes competing for real file and database locks.
  writeFileSync(
    joiner,
    [
      `import { Room } from "file:///${entry}";`,
      "const room = Room.open(process.argv[2]);",
      "const joined = room.join({ name: process.argv[3], role: 'worker' });",
      "console.log(JSON.stringify({ name: process.argv[3], token: joined.token }));",
      "room.close();",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

function room(): string {
  const dir = join(workspace, `room-${Math.random().toString(36).slice(2)}`);
  Room.create(dir).close();
  return dir;
}

function joinInOwnProcess(dir: string, name: string): Promise<{ name: string; token: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [joiner, dir, name]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code !== 0) return rej(new Error(err.trim() || `joiner exited ${code}`));
      res(JSON.parse(out.trim()));
    });
  });
}

describe("several processes using one room at once", () => {
  it(
    "lets every one of them open the room",
    async () => {
      const dir = room();

      // Before the busy_timeout ordering fix this rejected with "database is
      // locked" — a room that could not be opened, which took down whatever
      // was opening it.
      const joined = await Promise.all(
        Array.from({ length: JOINERS }, (_, i) => i + 1).map((n) =>
          joinInOwnProcess(dir, `w${n}`),
        ),
      );

      expect(joined).toHaveLength(JOINERS);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps every token that every join handed out",
    async () => {
      const dir = room();

      const joined = await Promise.all(
        Array.from({ length: JOINERS }, (_, i) => i + 1).map((n) =>
          joinInOwnProcess(dir, `w${n}`),
        ),
      );

      // The failure this catches is quiet: the member is on the roster and
      // their credential is gone, so it only surfaces much later as "that
      // session token is not valid".
      const open = Room.open(dir);
      try {
        for (const { name, token } of joined) {
          expect(() => open.authenticate(token), `${name}'s token was lost`).not.toThrow();
        }
        expect(open.roster()).toHaveLength(JOINERS);
      } finally {
        open.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "leaves no temporary files behind in .atrium",
    async () => {
      const dir = room();
      await Promise.all([1, 2, 3, 4].map((n) => joinInOwnProcess(dir, `w${n}`)));

      const { readdirSync } = await import("node:fs");
      const leftovers = readdirSync(join(dir, ".atrium")).filter((f) => f.includes(".tmp"));

      // `atrium gc` sweeps stray temporaries in the object store; nothing
      // sweeps these, so a write that fails to clean up leaves them forever.
      expect(leftovers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "writes a token file that is still valid JSON afterwards",
    async () => {
      const dir = room();
      await Promise.all([1, 2, 3].map((n) => joinInOwnProcess(dir, `w${n}`)));

      const raw = readFileSync(join(dir, ".atrium", "tokens.json"), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(Object.keys(JSON.parse(raw))).toHaveLength(3);
    },
    TIMEOUT_MS,
  );
});
