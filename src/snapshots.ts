/**
 * Content history for artifacts: a content-addressed blob store sitting under
 * the log's coat-tails.
 *
 * `artifact.written` has always recorded a sha256 of what was written, but
 * only ever kept the hash — the bytes themselves lived nowhere but the
 * working directory, where the next write overwrote them. That made replay
 * half a feature: `atrium replay 12` could show what the board looked like,
 * but not what a document actually said at that point. This module closes
 * that gap by storing every write's bytes under `.atrium/objects/<hash
 * prefix>/<hash rest>`, keyed by the hash the log already carries.
 *
 * Content-addressing is what keeps this cheap: the path a blob lives at is a
 * pure function of its contents, so a rewrite that changes nothing (or a
 * revert back to an earlier version) finds the blob already on disk and does
 * not write it again. Two different artifacts that happen to hold identical
 * bytes share the same blob, too. This is deliberately not a VCS — there is
 * no tree, no commit graph, no merge — it is a flat store of byte blobs that
 * the event log's own sequence numbers give history to.
 *
 * A write that has since been superseded, or even deleted, is still on disk
 * under its hash, so history and diffs work the same way whether the current
 * state of the path is "here" or "gone".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { InvalidError } from "./errors.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";
import type { MemberId } from "./types.js";

const OBJECTS_DIR = "objects";

/** Where a blob for `hash` lives on disk, mirroring git's fan-out layout so
 * no one directory ends up holding thousands of files. */
function blobPath(room: Room, hash: string): string {
  return join(room.paths.atrium, OBJECTS_DIR, hash.slice(0, 2), hash.slice(2));
}

/**
 * Stores `bytes` under its hash, doing nothing if a blob with that hash is
 * already there. That existence check is the entire dedup story: identical
 * content is written to disk exactly once, no matter how many times or how
 * many paths it is written under.
 */
export function storeBlob(room: Room, hash: string, bytes: Uint8Array): void {
  const dest = blobPath(room, hash);
  if (existsSync(dest)) return;

  mkdirSync(join(room.paths.atrium, OBJECTS_DIR, hash.slice(0, 2)), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
}

/** Loads a blob by hash, or `undefined` if this room never stored one under
 * that hash — which would mean a log entry survived without its content, not
 * something that should happen in ordinary use. */
export function loadBlob(room: Room, hash: string): Buffer | undefined {
  const path = blobPath(room, hash);
  return existsSync(path) ? readFileSync(path) : undefined;
}

// ---------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------

export interface ArtifactVersion {
  /** Log position of this write or delete. */
  seq: number;
  ts: string;
  path: string;
  author: MemberId;
  kind: "written" | "deleted";
  /** Present for a write, absent for a delete. */
  bytes?: number;
  /** Present for a write, absent for a delete. */
  hash?: string;
}

function normalizePath(room: Room, path: string): string {
  return toArtifactPath(room.dir, resolveArtifact(room.dir, path));
}

/** Every write and delete ever recorded for a path, oldest first. This is the
 * whole history, not just what is reachable from the current state — a path
 * that was written, deleted, and never touched again still shows its one
 * version here. */
export function listVersions(room: Room, path: string): ArtifactVersion[] {
  const relPath = normalizePath(room, path);
  const versions: ArtifactVersion[] = [];

  for (const event of room.log.read({ types: ["artifact.written", "artifact.deleted"] })) {
    if (event.type === "artifact.written" && event.data.path === relPath) {
      versions.push({
        seq: event.seq,
        ts: event.ts,
        path: relPath,
        author: event.data.memberId,
        kind: "written",
        bytes: event.data.bytes,
        hash: event.data.hash,
      });
    } else if (event.type === "artifact.deleted" && event.data.path === relPath) {
      versions.push({
        seq: event.seq,
        ts: event.ts,
        path: relPath,
        author: event.data.memberId,
        kind: "deleted",
      });
    }
  }

  return versions;
}

/**
 * The content a path held right after log position `seq` — the same "as of
 * this point in the log" model `atrium replay` uses, applied to bytes
 * instead of the board. `undefined` means the path did not exist at that
 * point, whether because it had never been written yet or because the most
 * recent thing to happen to it by then was a delete.
 *
 * Passing the exact `seq` of one of `listVersions`' entries reads that
 * version directly, which is what makes deleted history still reachable:
 * the version recorded right before a delete reads back fine, even though
 * the path does not exist right now.
 */
export function contentAt(room: Room, path: string, seq: number): Buffer | undefined {
  const relPath = normalizePath(room, path);
  const versions = listVersions(room, relPath).filter((v) => v.seq <= seq);
  const last = versions[versions.length - 1];
  if (!last || last.kind === "deleted") return undefined;
  return loadBlob(room, last.hash!);
}

// ---------------------------------------------------------------------------
// Binary safety
// ---------------------------------------------------------------------------

/**
 * Whether `bytes` is safe to treat as text. Two checks, either one enough to
 * call it binary: a NUL byte anywhere in a leading sample (the same
 * heuristic `git` and most diff tools use, since text encodings never
 * legitimately contain one), and a round-trip check through UTF-8 (decoding
 * and re-encoding should reproduce the exact same bytes; if it does not, the
 * content was never valid UTF-8 to begin with).
 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (sample.includes(0)) return true;

  const buf = Buffer.from(bytes);
  return !Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface DiffResult {
  path: string;
  fromSeq: number;
  toSeq: number;
  /** True when both sides have the same content (including both absent). */
  identical: boolean;
  /** True when either side is not text, so `patch` is a one-line note rather
   * than an attempted line diff. */
  binary: boolean;
  /** Unified diff text, or a "Binary files ... differ" note, or empty when
   * `identical` is true. */
  patch: string;
}

/**
 * A unified diff between what a path held at two log positions.
 *
 * The diff algorithm below is a plain LCS over lines, not Myers' — this
 * project's stated dependency budget is zero, so the diff had to be written
 * rather than pulled in, and an O(n*m) table is the straightforward version
 * of that. Rooms are small working directories, not monorepos, so this is
 * expected to stay fast enough in practice; if a room ever grows artifacts
 * large enough for that to matter, that is the point to reach for something
 * smarter, not before.
 */
export function diffArtifact(room: Room, path: string, fromSeq: number, toSeq: number): DiffResult {
  const relPath = normalizePath(room, path);

  if (!Number.isInteger(fromSeq) || fromSeq < 0 || !Number.isInteger(toSeq) || toSeq < 0) {
    throw new InvalidError("Sequence numbers must be whole numbers, zero or more.", {
      fromSeq,
      toSeq,
    });
  }

  const fromBytes = contentAt(room, relPath, fromSeq);
  const toBytes = contentAt(room, relPath, toSeq);
  const fromLabel = `${relPath}@${fromSeq}`;
  const toLabel = `${relPath}@${toSeq}`;

  if (bytesEqual(fromBytes, toBytes)) {
    return { path: relPath, fromSeq, toSeq, identical: true, binary: false, patch: "" };
  }

  const binary =
    (fromBytes !== undefined && isBinaryContent(fromBytes)) ||
    (toBytes !== undefined && isBinaryContent(toBytes));

  if (binary) {
    return {
      path: relPath,
      fromSeq,
      toSeq,
      identical: false,
      binary: true,
      patch: `Binary files ${fromLabel} and ${toLabel} differ\n`,
    };
  }

  const aLines = splitLines(fromBytes ? fromBytes.toString("utf8") : "");
  const bLines = splitLines(toBytes ? toBytes.toString("utf8") : "");
  const patch = unifiedDiff(aLines, bLines, fromLabel, toLabel);

  return { path: relPath, fromSeq, toSeq, identical: false, binary: false, patch };
}

function bytesEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type LineOp = { type: "eq" | "del" | "add"; line: string };

/** Longest-common-subsequence line diff, backtracked into a flat list of
 * equal/delete/add operations in document order. */
function lcsOps(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..] and b[j..]. Every index used below
  // is within the [0, n] / [0, m] bounds the loops establish, so the
  // non-null assertions are just working around noUncheckedIndexedAccess,
  // not papering over a real possibility of a hole.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j]! });
    j++;
  }
  return ops;
}

const CONTEXT_LINES = 3;

/** Turns a flat op list into unified-diff text: `---`/`+++` headers, then one
 * or more `@@ -a,b +c,d @@` hunks with up to `CONTEXT_LINES` of unchanged
 * lines on either side of each change, merging hunks that would otherwise
 * overlap. */
function unifiedDiff(a: string[], b: string[], aLabel: string, bLabel: string): string {
  const ops = lcsOps(a, b);
  if (ops.every((op) => op.type === "eq")) return "";

  // Cumulative a/b line counts consumed *through* each op, so the line
  // number a hunk starts at is whatever the previous op had reached.
  const throughA: number[] = [];
  const throughB: number[] = [];
  let aCount = 0;
  let bCount = 0;
  for (const op of ops) {
    if (op.type !== "add") aCount++;
    if (op.type !== "del") bCount++;
    throughA.push(aCount);
    throughB.push(bCount);
  }

  const isChange = ops.map((op) => op.type !== "eq");

  // Decide which op indices belong in a hunk: every change, plus up to
  // CONTEXT_LINES of unchanged lines around it, merging runs where the gap
  // between two changes is small enough that their context would overlap.
  const included = new Array<boolean>(ops.length).fill(false);
  let i = 0;
  while (i < ops.length) {
    if (!isChange[i]) {
      i++;
      continue;
    }
    const start = Math.max(0, i - CONTEXT_LINES);
    let end = i;
    let scan = i;
    while (scan < ops.length) {
      if (isChange[scan]) {
        end = scan;
        scan++;
        continue;
      }
      let runEnd = scan;
      while (runEnd < ops.length && !isChange[runEnd]) runEnd++;
      if (runEnd < ops.length && runEnd - scan <= CONTEXT_LINES * 2) {
        // Close enough to the next change to fold into the same hunk.
        scan = runEnd;
        continue;
      }
      break;
    }
    end = Math.min(ops.length - 1, end + CONTEXT_LINES);
    for (let k = start; k <= end; k++) included[k] = true;
    i = end + 1;
  }

  const hunks: number[][] = [];
  let current: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (included[idx]) {
      current.push(idx);
    } else if (current.length > 0) {
      hunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) hunks.push(current);

  const lines: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];

  for (const hunk of hunks) {
    const first = hunk[0]!;
    const beforeA = first === 0 ? 0 : throughA[first - 1]!;
    const beforeB = first === 0 ? 0 : throughB[first - 1]!;

    let hunkACount = 0;
    let hunkBCount = 0;
    for (const idx of hunk) {
      if (ops[idx]!.type !== "add") hunkACount++;
      if (ops[idx]!.type !== "del") hunkBCount++;
    }

    const aStart = hunkACount === 0 ? beforeA : beforeA + 1;
    const bStart = hunkBCount === 0 ? beforeB : beforeB + 1;

    lines.push(`@@ -${aStart},${hunkACount} +${bStart},${hunkBCount} @@`);
    for (const idx of hunk) {
      const op = ops[idx]!;
      const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
      lines.push(`${prefix}${op.line}`);
    }
  }

  return lines.join("\n") + "\n";
}
