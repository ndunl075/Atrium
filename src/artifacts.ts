/**
 * The shared filesystem: real files in the room's working directory, guarded
 * by leases and checked for staleness.
 *
 * Two rules make this safe for two agents to share:
 *
 * - You cannot write a path without holding a live lease on it (see
 *   leases.ts). That is what stops two agents from scribbling over each other.
 * - Every read hands back the log position its contents were valid at. A
 *   write can say which position it was based on, and is refused if the
 *   artifact has moved on since — including having been deleted — so an
 *   agent re-reads instead of clobbering work it never saw.
 *
 * `listArtifacts` and `artifactInfo` are folded from the log rather than from
 * a directory listing. That is deliberate: they describe what the room knows
 * it produced, which is the thing other agents and the task board reason
 * about, not whatever happens to be sitting on disk (a stray file dropped in
 * by hand is not, in this model, an artifact).
 *
 * `listArtifacts` only returns paths that currently exist. A path that was
 * written and then deleted still has a real version history behind it —
 * `atrium history` and `atrium diff` still show it, and `read_artifact`'s
 * `seq` argument can still read its old content back — but it is not a thing
 * the room currently has, so it does not belong in a list of "what artifacts
 * are here now." `listDeletedArtifacts` is the separate, opt-in way to see
 * those paths: it is never merged into `listArtifacts`'s result, so a caller
 * can always tell a live artifact from a tombstone by which list it came
 * from rather than by inspecting a flag on each entry.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { currentLease } from "./leases.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import { Room } from "./room.js";
import { LeaseError, StaleError } from "./errors.js";
import { storeBlob } from "./snapshots.js";
import type { AnyEvent, ArtifactInfo, EventType, MemberId } from "./types.js";
import { sha256 } from "./util.js";

const ARTIFACT_EVENT_TYPES: EventType[] = ["artifact.written", "artifact.deleted"];

export interface ArtifactRead {
  path: string;
  /** Absent when the file does not exist. */
  content: string | undefined;
  exists: boolean;
  /** Log position this state is valid at; 0 if the path has never been touched. */
  seq: number;
}

export interface ArtifactReadBytes extends Omit<ArtifactRead, "content"> {
  /** Absent when the file does not exist. */
  content: Buffer | undefined;
}

export interface WriteOptions {
  /** The log position the write was based on. Omit for a first write, or if
   * you deliberately do not care what you are overwriting. */
  basedOnSeq?: number;
}

/**
 * The last thing recorded for a path: the artifact info if it currently
 * exists, plus the log position of whichever came last, a write or a delete.
 * Keeping both together is what lets a stale write be caught even when the
 * thing that happened since was a deletion rather than another write.
 *
 * `deletedBy`/`deletedAt` are set instead of `info` when the last event was a
 * deletion. `listDeletedArtifacts` is the only reader of those two fields;
 * everywhere else in this file only cares whether `info` is present.
 */
interface ArtifactState {
  info?: ArtifactInfo;
  seq: number;
  deletedBy?: MemberId;
  deletedAt?: string;
}

function foldArtifacts(events: AnyEvent[]): Map<string, ArtifactState> {
  const artifacts = new Map<string, ArtifactState>();

  for (const event of events) {
    switch (event.type) {
      case "artifact.written": {
        artifacts.set(event.data.path, {
          seq: event.seq,
          info: {
            path: event.data.path,
            bytes: event.data.bytes,
            hash: event.data.hash,
            seq: event.seq,
            lastWrittenBy: event.data.memberId,
            lastWrittenAt: event.ts,
          },
        });
        break;
      }

      case "artifact.deleted": {
        artifacts.set(event.data.path, {
          seq: event.seq,
          deletedBy: event.data.memberId,
          deletedAt: event.ts,
        });
        break;
      }

      default:
        break;
    }
  }

  return artifacts;
}

function readArtifactEvents(room: Room): AnyEvent[] {
  return room.log.read({ types: ARTIFACT_EVENT_TYPES });
}

function stateOf(room: Room, path: string): ArtifactState | undefined {
  return foldArtifacts(readArtifactEvents(room)).get(path);
}

/** Log position a path is currently at, 0 if it has never been written. */
function seqOf(room: Room, path: string): number {
  return stateOf(room, path)?.seq ?? 0;
}

/** What the room currently knows about a path, or `undefined` if it does not
 * currently exist (never written, or written and then deleted). */
export function artifactInfo(room: Room, path: string): ArtifactInfo | undefined {
  const relPath = toArtifactPath(room.dir, resolveArtifact(room.dir, path));
  return stateOf(room, relPath)?.info;
}

/** Every path the room currently knows about. */
export function listArtifacts(room: Room): ArtifactInfo[] {
  const infos: ArtifactInfo[] = [];
  for (const state of foldArtifacts(readArtifactEvents(room)).values()) {
    if (state.info) infos.push(state.info);
  }
  return infos;
}

/** A path the room once wrote and has since deleted — a tombstone. */
export interface DeletedArtifact {
  /** Path relative to the room's working directory, using forward slashes. */
  path: string;
  /** Log position of the deletion itself. */
  seq: number;
  deletedBy: MemberId;
  deletedAt: string;
}

/**
 * Every path the room once wrote and has since deleted — the tombstones
 * `listArtifacts` leaves out on purpose (see the module doc above). A path
 * here still has a real version history behind it; this is only for finding
 * the *name* of a path you don't already know was ever written, when you
 * specifically want the deleted ones rather than what currently exists.
 */
export function listDeletedArtifacts(room: Room): DeletedArtifact[] {
  const deleted: DeletedArtifact[] = [];
  for (const [path, state] of foldArtifacts(readArtifactEvents(room))) {
    if (state.info) continue; // still exists; not a tombstone
    // Every entry in the fold came from a write or a delete event, so the
    // absence of `info` here always means the last one was a delete — there
    // is no third case where deletedBy/deletedAt would be missing.
    deleted.push({
      path,
      seq: state.seq,
      deletedBy: state.deletedBy!,
      deletedAt: state.deletedAt!,
    });
  }
  return deleted;
}

/**
 * Reads a path's current contents as text. A missing file is not an error — it
 * comes back as `exists: false` so a caller can check before deciding whether
 * to write — but a path that tries to escape the room or reach into `.atrium/`
 * still throws, via `resolveArtifact`.
 *
 * The contents are decoded as UTF-8, so this is for the text an agent actually
 * works with. Anything that is not valid UTF-8 loses bytes to replacement
 * characters and will not survive a round trip; use {@link readArtifactBytes}
 * for images and other binary files.
 */
export function readArtifact(room: Room, path: string): ArtifactRead {
  const abs = resolveArtifact(room.dir, path);
  const relPath = toArtifactPath(room.dir, abs);
  const seq = seqOf(room, relPath);

  if (!existsSync(abs)) {
    return { path: relPath, content: undefined, exists: false, seq };
  }

  return { path: relPath, content: readFileSync(abs, "utf8"), exists: true, seq };
}

/**
 * Reads a path's current contents as raw bytes.
 *
 * Writing accepts a `Uint8Array`, so reading has to be able to give one back.
 * Without this, a PNG written into a room and read out again comes back as
 * mangled UTF-8 rather than the file that went in, and nothing complains.
 */
export function readArtifactBytes(room: Room, path: string): ArtifactReadBytes {
  const abs = resolveArtifact(room.dir, path);
  const relPath = toArtifactPath(room.dir, abs);
  const seq = seqOf(room, relPath);

  if (!existsSync(abs)) {
    return { path: relPath, content: undefined, exists: false, seq };
  }

  return { path: relPath, content: readFileSync(abs), exists: true, seq };
}

/**
 * Writes a path, requiring a live lease on it and, optionally, that the write
 * be based on the room's current version.
 *
 * The write itself goes to a temporary file in the same directory and is
 * renamed into place, so a process that dies mid-write leaves the old
 * contents intact rather than a truncated file.
 */
export function writeArtifact(
  room: Room,
  actorId: MemberId,
  path: string,
  content: string | Uint8Array,
  options: WriteOptions = {},
): ArtifactInfo {
  room.assertUsable();

  const abs = resolveArtifact(room.dir, path);
  const relPath = toArtifactPath(room.dir, abs);

  const lease = currentLease(room, relPath);
  if (!lease || lease.holder !== actorId) {
    throw new LeaseError(
      lease
        ? `${relPath} is leased by ${lease.holder}, not you. Only the lease holder can write it.`
        : `Writing ${relPath} needs a lease first. Call acquireLease before writing.`,
      { path: relPath, holder: lease?.holder },
    );
  }

  if (options.basedOnSeq !== undefined) {
    const seq = seqOf(room, relPath);
    if (options.basedOnSeq < seq) {
      throw new StaleError(
        `${relPath} has moved on since position ${options.basedOnSeq}; it is now at ${seq}. Re-read it before writing again.`,
        { path: relPath, basedOnSeq: options.basedOnSeq, currentSeq: seq },
      );
    }
  }

  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;

  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, abs);

  const hash = sha256(bytes);
  // Content-addressed: the blob for this hash may already be on disk, from
  // this path's own history or another one's, in which case this is a
  // no-op. See snapshots.ts for why that is the whole dedup story.
  storeBlob(room, hash, bytes);
  const event = room.log.append(actorId, "artifact.written", {
    path: relPath,
    bytes: bytes.length,
    hash,
    memberId: actorId,
  });

  return {
    path: relPath,
    bytes: bytes.length,
    hash,
    seq: event.seq,
    lastWrittenBy: actorId,
    lastWrittenAt: event.ts,
  };
}

/** Removes a path. Requires a lease on it, the same as writing does. */
export function deleteArtifact(room: Room, actorId: MemberId, path: string): void {
  room.assertUsable();

  const abs = resolveArtifact(room.dir, path);
  const relPath = toArtifactPath(room.dir, abs);

  const lease = currentLease(room, relPath);
  if (!lease || lease.holder !== actorId) {
    throw new LeaseError(
      lease
        ? `${relPath} is leased by ${lease.holder}, not you. Only the lease holder can delete it.`
        : `Deleting ${relPath} needs a lease first. Call acquireLease before deleting.`,
      { path: relPath, holder: lease?.holder },
    );
  }

  if (existsSync(abs)) rmSync(abs);

  room.log.append(actorId, "artifact.deleted", { path: relPath, memberId: actorId });
}
