/**
 * Where things live inside a room, and how to turn a path an agent supplied
 * into a real path safely.
 *
 * A room directory looks like this:
 *
 *   my-room/
 *     .atrium/
 *       log.db        the event log
 *       room.json     settings
 *       tokens.json   session token -> member id
 *     CONTEXT.md      the shared brief
 *     ...             everything the agents are actually producing
 */

import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { InvalidError } from "./errors.js";

export const ATRIUM_DIR = ".atrium";
export const CONTEXT_FILE = "CONTEXT.md";

export interface RoomPaths {
  /** The working directory: the artifacts themselves. */
  root: string;
  /** Room bookkeeping, not an artifact. */
  atrium: string;
  db: string;
  config: string;
  tokens: string;
  context: string;
}

export function roomPaths(root: string): RoomPaths {
  const abs = resolve(root);
  const atrium = join(abs, ATRIUM_DIR);
  return {
    root: abs,
    atrium,
    db: join(atrium, "log.db"),
    config: join(atrium, "room.json"),
    tokens: join(atrium, "tokens.json"),
    context: join(abs, CONTEXT_FILE),
  };
}

/**
 * Turns a caller-supplied artifact path into an absolute one, refusing anything
 * that would land outside the room or inside its bookkeeping.
 *
 * Agents are the ones passing these strings and they are not always careful, so
 * this rejects absolute paths, `..` escapes, and writes into `.atrium/`.
 */
export function resolveArtifact(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new InvalidError("An artifact path is required.");
  }
  if (requested.includes("\0")) {
    throw new InvalidError("Artifact paths cannot contain null bytes.", {
      path: requested,
    });
  }
  if (isAbsolute(requested)) {
    throw new InvalidError(
      "Artifact paths are relative to the room, not absolute.",
      { path: requested },
    );
  }

  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, normalize(requested));
  const rel = relative(rootAbs, candidate);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InvalidError("That path is outside the room.", {
      path: requested,
    });
  }
  if (rel === ATRIUM_DIR || rel.startsWith(ATRIUM_DIR + sep)) {
    throw new InvalidError(
      `${ATRIUM_DIR}/ holds the room's own records and is not writable as an artifact.`,
      { path: requested },
    );
  }

  return candidate;
}

/** The room-relative form of a path, always with forward slashes. */
export function toArtifactPath(root: string, absolute: string): string {
  const rel = relative(resolve(root), resolve(absolute));
  return rel.split(sep).join("/");
}

/** Whether a path sits inside the room's bookkeeping directory. */
export function isRoomInternal(root: string, absolute: string): boolean {
  const rel = relative(resolve(root), resolve(absolute));
  return rel === ATRIUM_DIR || rel.startsWith(ATRIUM_DIR + sep);
}
