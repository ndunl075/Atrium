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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { InvalidError } from "./errors.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";
import type { MemberId } from "./types.js";
import { renameWithRetry } from "./util.js";

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
  renameWithRetry(tmp, dest);
}

/** Loads a blob by hash, or `undefined` if this room never stored one under
 * that hash — which would mean a log entry survived without its content, not
 * something that should happen in ordinary use. */
export function loadBlob(room: Room, hash: string): Buffer | undefined {
  const path = blobPath(room, hash);
  return existsSync(path) ? readFileSync(path) : undefined;
}

// ---------------------------------------------------------------------------
// Reclaiming space
// ---------------------------------------------------------------------------

export interface GcResult {
  /** Blobs still referenced by the log, and so left alone. */
  kept: number;
  /** Files removed from the object store. */
  removed: number;
  /** Bytes those removed files were taking up. */
  bytesReclaimed: number;
  /** Paths removed, relative to the object store. Useful for a dry run. */
  paths: string[];
}

/**
 * Deletes anything in the object store the log does not point at.
 *
 * Be clear about what this does and does not bound. Every `artifact.written`
 * event names a hash, events are never removed, and history is the reason the
 * store exists — so a blob that some version of some path still refers to is
 * live forever by design, and no amount of collecting will shrink it. A room
 * that keeps working keeps growing, and the only way to change that is to
 * throw away history, which is a different decision than this one.
 *
 * What this reclaims is the store's genuine garbage: a `storeBlob` that wrote
 * its temporary file and died before the rename, and — the costlier case — a
 * `writeArtifact` that stored bytes and died before appending the event that
 * would have referred to them. Neither is reachable, neither is ever
 * overwritten, and without a sweep both sit there for the life of the room.
 *
 * Reachability is read from the log itself rather than from any index, so
 * this is safe to run at any time: the worst a concurrent write can do is
 * store a blob after the reference set was read, which leaves that blob for
 * the next sweep rather than deleting a live one.
 */
export function gcBlobs(room: Room, options: { dryRun?: boolean } = {}): GcResult {
  // Both kinds of event that put bytes in the store. `context.written` is
  // easy to forget here and expensive to forget: the brief's blob is the one
  // object in the store that no artifact event mentions, so a sweep that
  // only looked at `artifact.written` would delete every recorded version of
  // the room's brief and call it reclaimed space.
  const referenced = new Set<string>();
  for (const event of room.log.read({ types: ["artifact.written", "context.written"] })) {
    if (event.type === "artifact.written" || event.type === "context.written") {
      referenced.add(event.data.hash);
    }
  }

  const objects = join(room.paths.atrium, OBJECTS_DIR);
  const result: GcResult = { kept: 0, removed: 0, bytesReclaimed: 0, paths: [] };
  if (!existsSync(objects)) return result;

  for (const shard of readdirSync(objects, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(objects, shard.name);

    for (const entry of readdirSync(shardDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;

      // The hash is the shard name plus the file name, which is exactly how
      // blobPath split it. A leftover temporary file carries a `.tmp-` suffix
      // and so reassembles into a hash matching nothing, which is the answer
      // we want anyway.
      if (referenced.has(shard.name + entry.name)) {
        result.kept++;
        continue;
      }

      const path = join(shardDir, entry.name);
      result.removed++;
      result.bytesReclaimed += statSync(path).size;
      result.paths.push(`${shard.name}/${entry.name}`);
      if (!options.dryRun) rmSync(path);
    }
  }

  return result;
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
 * What reading a past version can find, as three outcomes rather than two.
 *
 * The third one is the reason this type exists. Once a retention sweep can
 * drop content (see {@link pruneVersions}), "no bytes here" stops meaning one
 * thing: a path may have not existed at that point, or it may have existed and
 * had its content discarded since. Collapsing those into a single `undefined`
 * makes every caller assert the first when the second is true — reporting a
 * file as never having existed, or diffing a real version against emptiness.
 * Keeping them apart is what lets each caller say what it actually knows.
 */
export type ArtifactContent =
  | { state: "present"; bytes: Buffer }
  /** Never written by that point, or the last thing to happen was a delete. */
  | { state: "absent" }
  /**
   * Written, still listed in the log, but its bytes are not in the store.
   * A retention sweep is the ordinary reason; the log's `artifact.pruned`
   * events say which sweep and when.
   */
  | { state: "pruned"; hash: string; bytes: number };

/**
 * The content a path held right after log position `seq` — the same "as of
 * this point in the log" model `atrium replay` uses, applied to bytes instead
 * of the board.
 *
 * Passing the exact `seq` of one of `listVersions`' entries reads that version
 * directly, which is what makes deleted history still reachable: the version
 * recorded right before a delete reads back fine, even though the path does
 * not exist right now.
 */
export function contentStateAt(room: Room, path: string, seq: number): ArtifactContent {
  const relPath = normalizePath(room, path);
  const versions = listVersions(room, relPath).filter((v) => v.seq <= seq);
  const last = versions[versions.length - 1];
  if (!last || last.kind === "deleted") return { state: "absent" };

  const bytes = loadBlob(room, last.hash!);
  if (bytes === undefined) {
    return { state: "pruned", hash: last.hash!, bytes: last.bytes ?? 0 };
  }
  return { state: "present", bytes };
}

/**
 * The bytes of a past version, or `undefined` if there are none to hand back.
 *
 * This is the convenience form, and it cannot tell "the path did not exist"
 * from "it did, and its content has since been pruned" — both come back
 * `undefined`. Anything that reports what it found to a person or an agent
 * wants {@link contentStateAt} instead, so it does not claim the first when
 * the second is true.
 */
export function contentAt(room: Room, path: string, seq: number): Buffer | undefined {
  const found = contentStateAt(room, path, seq);
  return found.state === "present" ? found.bytes : undefined;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface PrunePlan {
  path: string;
  /** Versions whose content would be, or was, dropped. Oldest first. */
  seqs: number[];
  bytesReclaimed: number;
}

export interface PruneResult {
  /** Versions kept per path, which is what the sweep ran with. */
  retained: number;
  plans: PrunePlan[];
  /** Versions whose content was dropped, across every path. */
  droppedVersions: number;
  bytesReclaimed: number;
}

export interface PruneOptions {
  /**
   * Versions of each path to keep. Defaults to the room's
   * `retainVersionsPerPath`. Must be 1 or more: a path always keeps its most
   * recent version, because that is the file itself.
   */
  retain?: number;
  /** Work out what would go, and touch nothing. */
  dryRun?: boolean;
}

/**
 * Drops the content of all but the most recent `retain` versions of each path.
 *
 * This is the only thing in Atrium that discards history, and it is never
 * automatic — `atrium prune` runs it, a person runs `atrium prune`. What it
 * removes is bytes, not record: every version stays in the log and keeps
 * listing in `atrium history`, and reading one whose content is gone reports
 * that plainly rather than pretending the version never happened.
 *
 * Two things make this less simple than deleting the oldest blobs.
 *
 * The store is content-addressed, so one blob can back several versions —
 * the same content rewritten, or two paths holding identical bytes. A blob is
 * therefore only removed when *no* retained version anywhere still refers to
 * it, which is why the retained set is collected across all paths before
 * anything is deleted. Getting this wrong would delete content still being
 * pointed at from a version that was supposed to be kept.
 *
 * And a version whose blob survives that check is not reported as pruned,
 * because its content is still readable. The result describes what actually
 * became unavailable, which is the only thing worth recording.
 */
export function pruneVersions(room: Room, options: PruneOptions = {}): PruneResult {
  const retain = options.retain ?? room.config.retainVersionsPerPath;
  if (!Number.isInteger(retain) || retain < 1) {
    throw new InvalidError(
      `Retention must be a whole number of versions, 1 or more; got ${retain}. ` +
        `Set retainVersionsPerPath in the room config, or pass --keep.`,
      { retain },
    );
  }

  // Group every recorded write by path, oldest first.
  const byPath = new Map<string, ArtifactVersion[]>();
  for (const event of room.log.read({ types: ["artifact.written"] })) {
    if (event.type !== "artifact.written") continue;
    const list = byPath.get(event.data.path) ?? [];
    list.push({
      seq: event.seq,
      ts: event.ts,
      path: event.data.path,
      author: event.data.memberId,
      kind: "written",
      bytes: event.data.bytes,
      hash: event.data.hash,
    });
    byPath.set(event.data.path, list);
  }

  // Everything the policy says to keep, gathered across every path before a
  // single blob is looked at. A hash in here is live no matter how old the
  // version referring to it happens to be somewhere else.
  const retainedHashes = new Set<string>();
  const candidates: ArtifactVersion[] = [];
  for (const versions of byPath.values()) {
    const cut = Math.max(0, versions.length - retain);
    for (const version of versions.slice(cut)) retainedHashes.add(version.hash!);
    candidates.push(...versions.slice(0, cut));
  }

  const plans = new Map<string, PrunePlan>();
  const removed = new Set<string>();

  for (const version of candidates) {
    // Still pointed at by something being kept, so its content stays readable
    // and there is nothing to report for this version.
    if (retainedHashes.has(version.hash!)) continue;
    // Already handled: several old versions can share one blob too.
    if (removed.has(version.hash!)) continue;

    const blob = blobPath(room, version.hash!);
    if (!existsSync(blob)) continue;

    removed.add(version.hash!);
    const size = statSync(blob).size;
    if (!options.dryRun) rmSync(blob);

    const plan = plans.get(version.path) ?? { path: version.path, seqs: [], bytesReclaimed: 0 };
    plan.seqs.push(version.seq);
    plan.bytesReclaimed += size;
    plans.set(version.path, plan);
  }

  const result: PruneResult = {
    retained: retain,
    plans: [...plans.values()],
    droppedVersions: [...plans.values()].reduce((total, plan) => total + plan.seqs.length, 0),
    bytesReclaimed: [...plans.values()].reduce((total, plan) => total + plan.bytesReclaimed, 0),
  };

  // Recorded as system events, and deliberately without assertUsable: a room
  // that has spent its action budget is exactly one you might need to reclaim
  // space on, and refusing to record a discard that already happened would be
  // worse than the budget going one over.
  if (!options.dryRun) {
    for (const plan of result.plans) {
      room.log.append("system", "artifact.pruned", {
        path: plan.path,
        seqs: plan.seqs,
        bytesReclaimed: plan.bytesReclaimed,
        retained: retain,
      });
    }
  }

  return result;
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
  /**
   * True when either side's content has been pruned, so there is nothing to
   * compare. `patch` says which side, and `identical` is false: the versions
   * are not known to match, and claiming they do would be worse than saying
   * the comparison cannot be made.
   */
  pruned: boolean;
  /** Unified diff text, a "Binary files ... differ" note, a note that content
   * is no longer retained, or empty when `identical` is true. */
  patch: string;
}

/**
 * A unified diff between what a path held at two log positions.
 *
 * The diff algorithm below is a plain LCS over lines, not Myers' — this
 * project's stated dependency budget is zero, so the diff had to be written
 * rather than pulled in, and an O(n*m) table is the straightforward version
 * of that. Rooms are small working directories, not monorepos, so this is
 * expected to stay fast enough in practice. It is not left to trust, though:
 * `lcsOps` trims the common head and tail before building any table and
 * refuses to build one past a fixed cell budget, so an artifact large enough
 * to matter degrades to a coarser patch instead of exhausting memory.
 */
export function diffArtifact(room: Room, path: string, fromSeq: number, toSeq: number): DiffResult {
  const relPath = normalizePath(room, path);

  if (!Number.isInteger(fromSeq) || fromSeq < 0 || !Number.isInteger(toSeq) || toSeq < 0) {
    throw new InvalidError("Sequence numbers must be whole numbers, zero or more.", {
      fromSeq,
      toSeq,
    });
  }

  const from = contentStateAt(room, relPath, fromSeq);
  const to = contentStateAt(room, relPath, toSeq);
  const fromLabel = `${relPath}@${fromSeq}`;
  const toLabel = `${relPath}@${toSeq}`;

  // Checked before anything else, because with a side's bytes gone there is
  // no comparison to make. The tempting shortcuts are both wrong: treating a
  // pruned side as empty invents a patch that deletes a file nobody deleted,
  // and treating two pruned sides as equal reports versions as identical on
  // the strength of knowing nothing about either.
  if (from.state === "pruned" || to.state === "pruned") {
    const which =
      from.state === "pruned" && to.state === "pruned"
        ? `${fromLabel} and ${toLabel}`
        : from.state === "pruned"
          ? fromLabel
          : toLabel;
    return {
      path: relPath,
      fromSeq,
      toSeq,
      identical: false,
      binary: false,
      pruned: true,
      patch: `Cannot diff: the content of ${which} is no longer retained.\n`,
    };
  }

  const fromBytes = from.state === "present" ? from.bytes : undefined;
  const toBytes = to.state === "present" ? to.bytes : undefined;

  if (bytesEqual(fromBytes, toBytes)) {
    return {
      path: relPath,
      fromSeq,
      toSeq,
      identical: true,
      binary: false,
      pruned: false,
      patch: "",
    };
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
      pruned: false,
      patch: `Binary files ${fromLabel} and ${toLabel} differ\n`,
    };
  }

  const aLines = splitLines(fromBytes ? fromBytes.toString("utf8") : "");
  const bLines = splitLines(toBytes ? toBytes.toString("utf8") : "");
  const patch = unifiedDiff(aLines, bLines, fromLabel, toLabel);

  return { path: relPath, fromSeq, toSeq, identical: false, binary: false, pruned: false, patch };
}

function bytesEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

/**
 * One line of a file, plus whether it is a final line with no newline after
 * it. That flag is part of the line's identity, not decoration: a file ending
 * `"...done"` and one ending `"...done\n"` split into the same list of
 * strings, so without it the two compare equal and a real difference in bytes
 * comes back as an empty patch.
 */
interface DiffLine {
  text: string;
  /** True only for the last line of a file that does not end in a newline. */
  noEol: boolean;
}

/** How git marks the same thing, and what `git apply` expects to read. */
const NO_EOL_MARKER = "\\ No newline at end of file";

function splitLines(text: string): DiffLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  // A trailing newline leaves an empty final element, which is a terminator
  // rather than a line. Its absence is what has to be remembered.
  const endsWithNewline = parts[parts.length - 1] === "";
  if (endsWithNewline) parts.pop();
  return parts.map((line, index) => ({
    text: line,
    noEol: !endsWithNewline && index === parts.length - 1,
  }));
}

function sameLine(a: DiffLine, b: DiffLine): boolean {
  return a.text === b.text && a.noEol === b.noEol;
}

type LineOp = { type: "eq" | "del" | "add"; line: DiffLine };

/**
 * Cells the LCS table is allowed to occupy. At four bytes a cell this caps it
 * at about 32 MB, which is far past any artifact a room realistically holds
 * and small enough that a pathological one degrades instead of trying to
 * allocate gigabytes.
 */
const MAX_LCS_CELLS = 8_000_000;

/** Longest-common-subsequence line diff, backtracked into a flat list of
 * equal/delete/add operations in document order. */
function lcsOps(a: DiffLine[], b: DiffLine[]): LineOp[] {
  // An edit to a large file almost always leaves its head and tail alone, and
  // matching those off costs O(n) against the O(n*m) of putting them through
  // the table. Doing it first is both the ordinary speed-up and what keeps
  // realistic edits under the cell budget below.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && sameLine(a[prefix]!, b[prefix]!)) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    sameLine(a[a.length - 1 - suffix]!, b[b.length - 1 - suffix]!)
  ) {
    suffix++;
  }

  const ops: LineOp[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ type: "eq", line: a[i]! });
  ops.push(...middleOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)));
  for (let i = a.length - suffix; i < a.length; i++) ops.push({ type: "eq", line: a[i]! });
  return ops;
}

/** The differing region between the common head and tail, which is the only
 * part the table is ever built over. */
function middleOps(a: DiffLine[], b: DiffLine[]): LineOp[] {
  const n = a.length;
  const m = b.length;

  // Two reasons to skip the table, with the same answer. Either one side is
  // empty, so there is no common subsequence to find; or the table would be
  // over budget, in which case replacing the region wholesale is still a
  // correct unified diff, only a coarser one than the minimal edit. A blunt
  // patch beats both refusing to answer and allocating without a ceiling.
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((line): LineOp => ({ type: "del", line })),
      ...b.map((line): LineOp => ({ type: "add", line })),
    ];
  }

  // dp[i * width + j] = length of the LCS of a[i..] and b[j..], held flat in
  // one typed array rather than an array of arrays: same O(n*m) cells, but
  // four bytes each instead of a boxed number plus per-row object overhead.
  // Every index used below is inside the [0, n] / [0, m] bounds the loops
  // establish, so the non-null assertions are working around
  // noUncheckedIndexedAccess rather than papering over a real hole.
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = sameLine(a[i]!, b[j]!)
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameLine(a[i]!, b[j]!)) {
      ops.push({ type: "eq", line: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
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
function unifiedDiff(a: DiffLine[], b: DiffLine[], aLabel: string, bLabel: string): string {
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
      lines.push(`${prefix}${op.line.text}`);
      // Sits outside the hunk's line counts, the same as in git's output: it
      // annotates the line above rather than being a line of either file.
      if (op.line.noEol) lines.push(NO_EOL_MARKER);
    }
  }

  return lines.join("\n") + "\n";
}
