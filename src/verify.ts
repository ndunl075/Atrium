/**
 * `atrium verify`: does this room still hang together, or has something
 * outside atrium's own tools left it in a state atrium itself would never
 * produce?
 *
 * ARCHITECTURE.md §3.5 makes the log the single source of truth and calls
 * debuggability the actual product feature. That claim is only as good as
 * whoever's word it is that the room is consistent, and until now that word
 * was nobody's: `atrium gc` and `atrium prune` can both remove bytes from a
 * room, and nothing afterwards confirmed that what remains still matches what
 * the log says should be there. The only way to find out was to hit a command
 * that could not produce an answer — `atrium diff` refusing, `read_artifact`
 * reporting `pruned: true` for a version that was never pruned — and even
 * then there was no single place that said "this room has a problem" versus
 * "this room is exactly as expected."
 *
 * The whole difficulty of this module is not finding things that are wrong.
 * It is not reporting things that are *right* as though they were wrong.
 * `pruneVersions` deliberately deletes bytes and records an `artifact.pruned`
 * event saying so; `contentStateAt` exists specifically to keep "written, no
 * longer retained" apart from "never existed" and from "should be here and
 * is not." A verify command that cannot make that same distinction would
 * flag every ordinary pruned version as corruption, and a tool that cries
 * wolf at its own room's normal operation trains people to stop reading its
 * output — which is worse than not having it. So every check below asks not
 * just "is this blob here," but "does the log's own record explain why it
 * might not be."
 *
 * What this checks, and what it deliberately does not:
 *
 * - Every `artifact.written` event's hash either has a blob on disk, or that
 *   exact write was named in a recorded `artifact.pruned` event. Anything
 *   else is a blob that went missing without ever being discarded on purpose
 *   — by definition not something atrium's own tools could have done, since
 *   both of the only two things that remove blobs (`gcBlobs`, `pruneVersions`)
 *   leave a trail this check reads.
 * - Every stored blob's bytes are rehashed and checked against the name it is
 *   filed under. This is the one check that catches corruption rather than
 *   absence — a blob that is *there* but wrong — and content-addressing is
 *   the only reason it is checkable at all: the filename is a claim about the
 *   content, and the content can be asked whether the claim is true. Scoped to
 *   blobs at least one `artifact.written` event still points to, since a
 *   corrupted blob nothing refers to is moot — `atrium gc` will remove it
 *   either way, corrupted or not.
 * - Blobs the log does not point at are reported as reclaimable space, in
 *   their own severity, never mixed in with damage: that is what `gcBlobs`
 *   exists to reclaim, and a healthy, ordinary room can have plenty of it.
 * - The log's sequence numbers start at 1 and never skip, the invariant
 *   `types.ts` documents on `Event.seq`. SQLite's own `AUTOINCREMENT` and the
 *   append-only triggers in `log.ts` make this true by construction through
 *   atrium's own code paths, so a violation here means something reached
 *   `.atrium/log.db` from outside them.
 * - `room.json` parses as JSON and every field it sets is the type
 *   `RoomConfig` declares. A field that is merely absent is not a problem —
 *   `Room.open` layers stored config over `DEFAULT_ROOM_CONFIG` precisely so
 *   an old room missing a newer field still opens — so only fields that are
 *   *present with the wrong type* are findings.
 * - `tokens.json` parses as JSON and every member id it grants a session to
 *   is someone who has actually joined, per the roster.
 *
 * What it does not check: whether the file currently sitting at an
 * artifact's path on disk matches the hash of its most recent
 * `artifact.written` event. That would be a real check, but it is a
 * different one — it says something about the working directory, which
 * agents are free to edit by hand outside atrium entirely (ARCHITECTURE.md
 * §3.3: "real files on real disk, not abstractions") — and folding it in here
 * would make this command start asserting things about files it was never
 * told to guard. This module is about whether the room's own record of
 * itself is internally consistent, not about policing the working directory.
 */

import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_ROOM_CONFIG, type AnyEvent } from "./types.js";
import { settingKeys } from "./config.js";
import { gcBlobs, loadBlob, type GcResult } from "./snapshots.js";
import type { Room } from "./room.js";
import { sha256 } from "./util.js";

/**
 * How seriously a finding should be taken. `critical` and `warning` both make
 * a room report unhealthy; `info` is the severity reserved for things that
 * are expected and actionable but not wrong — right now, only reclaimable
 * space. Keeping that one apart from the other two is the entire point of
 * this type: it is what stops "you have garbage to collect" from reading the
 * same as "your object store is corrupted."
 */
export type VerifySeverity = "critical" | "warning" | "info";

export interface VerifyFinding {
  severity: VerifySeverity;
  /** A short, stable identifier for what kind of finding this is, e.g.
   * "blob-missing" or "config-type" — useful for a script that wants to act
   * on one category without parsing prose. */
  check: string;
  /** For a person: what was found, and — for anything actionable — what to
   * do about it. */
  message: string;
  path?: string;
  seq?: number;
  hash?: string;
}

export interface VerifySummary {
  /** Total events in the log, the same number `atrium log` would show. */
  eventsChecked: number;
  /** `artifact.written` events examined for a live or legitimately-pruned blob. */
  artifactWrites: number;
  /** Distinct hashes whose blob (if present) was reread and rehashed. */
  blobsChecked: number;
  /** Objects in the store no `artifact.written` event refers to. */
  reclaimableBlobs: number;
  reclaimableBytes: number;
}

export interface VerifyReport {
  /**
   * The unambiguous answer. `true` exactly when every finding is `info` — a
   * script can gate on this alone; a person can stop reading after the first
   * line the CLI prints for it.
   */
  healthy: boolean;
  findings: VerifyFinding[];
  summary: VerifySummary;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * The log's own documented invariant (`types.ts`: "Starts at 1 and never has
 * gaps"), confirmed rather than assumed. `log.ts`'s `AUTOINCREMENT` primary
 * key and its append-only triggers make this true for anything that went
 * through `EventLog`, so a gap here means some other process reached
 * `.atrium/log.db` directly.
 *
 * Resyncs its expectation to whatever it actually finds after reporting a
 * gap, rather than reporting the same gap again for every event after it —
 * one true statement about where the log diverged is more useful than a
 * thousand echoes of it.
 */
function checkSequence(events: AnyEvent[], findings: VerifyFinding[]): void {
  let expected = 1;
  for (const event of events) {
    if (event.seq !== expected) {
      findings.push({
        severity: "critical",
        check: "log-sequence",
        seq: event.seq,
        message:
          `Expected the next event to be #${expected}, but found #${event.seq}. ` +
          `The log is supposed to start at 1 and never skip a position — see the ` +
          `comment on Event.seq in types.ts — so this means something other than ` +
          `atrium's own EventLog wrote to .atrium/log.db.`,
      });
      expected = event.seq;
    }
    expected++;
  }
}

/**
 * Walks every `artifact.written` event once, checking two things per event
 * and one thing per distinct hash:
 *
 * - Per event: if the hash's blob is not on disk, was *this* write named in a
 *   recorded `artifact.pruned` event? If so, its content is supposed to be
 *   gone and there is nothing to report. If not, the content is missing
 *   without ever having been discarded on purpose, which is exactly the
 *   damage this whole command exists to catch.
 * - Per distinct hash that does have a blob: do its bytes actually hash to
 *   the name it is filed under? A mismatch is corruption, not absence — the
 *   one case a missing-blob check alone could never find.
 *
 * Hashes are cached across events so content shared between several writes
 * (content-addressing's whole point) is only read and rehashed once.
 */
function checkArtifacts(
  room: Room,
  events: AnyEvent[],
  prunedSeqs: Set<number>,
  findings: VerifyFinding[],
): { artifactWrites: number; blobsChecked: number } {
  const blobCache = new Map<string, Buffer | undefined>();
  const hashVersions = new Map<string, { path: string; seq: number }[]>();
  let artifactWrites = 0;

  const load = (hash: string): Buffer | undefined => {
    if (!blobCache.has(hash)) blobCache.set(hash, loadBlob(room, hash));
    return blobCache.get(hash);
  };

  for (const event of events) {
    if (event.type !== "artifact.written") continue;
    artifactWrites++;
    const { path, hash } = event.data;

    const versions = hashVersions.get(hash) ?? [];
    versions.push({ path, seq: event.seq });
    hashVersions.set(hash, versions);

    if (load(hash) === undefined && !prunedSeqs.has(event.seq)) {
      findings.push({
        severity: "critical",
        check: "blob-missing",
        path,
        seq: event.seq,
        hash,
        message:
          `${path}@${event.seq} was written with hash ${shortHash(hash)}…, but no blob ` +
          `is stored under that hash and no "atrium prune" ever recorded dropping it. ` +
          `That combination is not something atrium's own tools produce — gcBlobs only ` +
          `removes blobs the log never references, and pruneVersions only removes a blob ` +
          `after writing the artifact.pruned event that says so. Something else removed ` +
          `these bytes. The content itself cannot be recovered by atrium; this is a record ` +
          `of what is gone, not a way to get it back.`,
      });
    }
  }

  for (const [hash, blob] of blobCache) {
    if (blob === undefined) continue;
    const actual = sha256(blob);
    if (actual === hash) continue;

    const where = (hashVersions.get(hash) ?? []).map((v) => `${v.path}@${v.seq}`).join(", ");
    findings.push({
      severity: "critical",
      check: "blob-corrupt",
      hash,
      message:
        `The blob stored under ${shortHash(hash)}… actually hashes to ${shortHash(actual)}… ` +
        `— its bytes have changed since they were written. Content-addressing means atrium ` +
        `itself never has a reason to rewrite a blob in place, so this means something outside ` +
        `atrium touched .atrium/objects directly.` +
        (where ? ` Affected version(s): ${where}.` : ""),
    });
  }

  return { artifactWrites, blobsChecked: blobCache.size };
}

/** Blobs the log does not reference at all — exactly what `gcBlobs` reclaims.
 * Reported as its own severity because a room that has never run `atrium gc`
 * is expected to accumulate some of this in ordinary operation; it is not
 * evidence of anything having gone wrong. */
function checkReclaimable(room: Room, findings: VerifyFinding[]): GcResult {
  const result = gcBlobs(room, { dryRun: true });
  if (result.removed > 0) {
    findings.push({
      severity: "info",
      check: "reclaimable",
      message:
        `${result.removed} stored object${result.removed === 1 ? "" : "s"} ` +
        `(${result.bytesReclaimed} byte${result.bytesReclaimed === 1 ? "" : "s"}) ` +
        `${result.removed === 1 ? "is" : "are"} not referenced by any artifact.written event ` +
        `and can be freed with "atrium gc". This is not damage — it is what atrium gc exists to reclaim.`,
    });
  }
  return result;
}

/**
 * `room.json` parsed independently of `Room.open`, which layers stored config
 * over `DEFAULT_ROOM_CONFIG` and so would happily hand back a `RoomConfig`
 * whose `leaseSeconds` is the string `"300"` without anyone noticing. A field
 * that is simply absent from the file is not a finding — that is what the
 * defaults are for — only a field that is present with a type `RoomConfig`
 * does not declare.
 */
function checkRoomConfig(room: Room, findings: VerifyFinding[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(room.paths.config, "utf8"));
  } catch (err) {
    findings.push({
      severity: "critical",
      check: "config-parse",
      message:
        `room.json could not be parsed as JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Every setting in this room is unreadable until that file is fixed by hand.`,
    });
    return;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    findings.push({
      severity: "critical",
      check: "config-shape",
      message: "room.json does not contain a JSON object, so no setting in it can be read.",
    });
    return;
  }
  const obj = raw as Record<string, unknown>;

  for (const field of ["id", "name", "createdAt"] as const) {
    if (field in obj && typeof obj[field] !== "string") {
      findings.push({
        severity: "warning",
        check: "config-type",
        message: `room.json's "${field}" is ${typeof obj[field]}, but RoomConfig declares it a string.`,
      });
    }
  }

  const defaults: Record<string, unknown> = DEFAULT_ROOM_CONFIG;
  for (const key of settingKeys()) {
    if (!(key in obj)) continue; // absent means "use the default" — not a finding
    const expected = typeof defaults[key];
    const actual = typeof obj[key];
    if (actual !== expected) {
      findings.push({
        severity: "warning",
        check: "config-type",
        message:
          `room.json's "${key}" is ${actual} (${JSON.stringify(obj[key])}), but RoomConfig ` +
          `declares it a ${expected}. atrium will use this value exactly as written until ` +
          `something downstream trips over it; run "atrium config ${key} <value>" to set it ` +
          `to something valid.`,
      });
    }
  }
}

/**
 * `tokens.json` parsed on its own, since it is a file `Room.open` never reads
 * — only `authenticate` touches it, lazily, per call — so damage here can sit
 * undetected through every other command.
 */
function checkTokens(room: Room, findings: VerifyFinding[]): void {
  if (!existsSync(room.paths.tokens)) return; // Room.create always writes one; a room's business, not this check's

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(room.paths.tokens, "utf8"));
  } catch (err) {
    findings.push({
      severity: "critical",
      check: "tokens-parse",
      message:
        `tokens.json could not be parsed as JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `No session token in this room can be authenticated until that file is fixed by hand.`,
    });
    return;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    findings.push({
      severity: "critical",
      check: "tokens-shape",
      message: "tokens.json does not contain a JSON object mapping token hashes to member ids.",
    });
    return;
  }

  const rosterIds = new Set(room.roster().map((m) => m.id));
  for (const memberId of Object.values(raw as Record<string, unknown>)) {
    if (typeof memberId !== "string") {
      findings.push({
        severity: "warning",
        check: "tokens-type",
        message: `tokens.json maps a token to ${typeof memberId}, not a member id string.`,
      });
      continue;
    }
    if (!rosterIds.has(memberId)) {
      findings.push({
        severity: "warning",
        check: "tokens-dangling",
        message:
          `tokens.json grants a session to "${memberId}", who has never joined this room ` +
          `(not in the roster). Whoever holds that token would authenticate as a member ` +
          `that does not exist.`,
      });
    }
  }
}

/**
 * Checks one open room for internal consistency and returns everything found,
 * grouped by severity, plus enough of a summary to say what was actually
 * looked at. Read-only: nothing here writes to the log, the object store, or
 * either JSON file, no matter what it finds.
 */
export function verifyRoom(room: Room): VerifyReport {
  const findings: VerifyFinding[] = [];
  const events = room.log.read();

  checkSequence(events, findings);

  const prunedSeqs = new Set<number>();
  for (const event of events) {
    if (event.type === "artifact.pruned") {
      for (const seq of event.data.seqs) prunedSeqs.add(seq);
    }
  }

  const { artifactWrites, blobsChecked } = checkArtifacts(room, events, prunedSeqs, findings);
  const gc = checkReclaimable(room, findings);
  checkRoomConfig(room, findings);
  checkTokens(room, findings);

  return {
    healthy: findings.every((f) => f.severity === "info"),
    findings,
    summary: {
      eventsChecked: events.length,
      artifactWrites,
      blobsChecked,
      reclaimableBlobs: gc.removed,
      reclaimableBytes: gc.bytesReclaimed,
    },
  };
}
