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

import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
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

/**
 * Resolves every path component that already exists while preserving a
 * possibly-missing suffix. `realpathSync` alone cannot check a new artifact,
 * because the leaf (and often its parent directories) do not exist yet.
 *
 * A dangling symlink is rejected rather than treated as an ordinary missing
 * path. Its eventual target could otherwise move a previously-approved write
 * outside the room without another containment check.
 */
function canonicalPathWithMissingSuffix(path: string, requested: string): string {
  let existing = path;
  const suffix: string[] = [];

  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;

      const parent = dirname(existing);
      if (parent === existing) {
        // Filesystem roots exist in ordinary operation. Keep this fallback
        // deterministic for unusual virtual filesystems rather than looping.
        return path;
      }
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }

  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new InvalidError(
      "That artifact path cannot be resolved safely.",
      { path: requested },
    );
  }
  return resolve(realExisting, ...suffix);
}

function isOutside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

function isAtOrInside(base: string, candidate: string): boolean {
  return !isOutside(base, candidate);
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
 * that would land outside the room or inside its bookkeeping. Existing
 * symlinks and Windows junctions are resolved before the containment check.
 *
 * Agents are the ones passing these strings and they are not always careful, so
 * this rejects absolute paths, `..` escapes, and writes into `.atrium/`.
 *
 * This validates the filesystem state at the time of the call. Like any
 * path-based API, it cannot stop another process with direct filesystem
 * access from replacing a checked directory before the caller uses the
 * returned path; fully closing that race requires handle-relative operations
 * that Node does not expose consistently across supported platforms.
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
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    throw new InvalidError("The room root must exist and be resolvable.", {
      root: rootAbs,
    });
  }

  const candidate = resolve(rootAbs, normalize(requested));
  const rel = relative(rootAbs, candidate);

  if (rel === "" || isOutside(rootAbs, candidate)) {
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

  // The lexical checks above stop `..` traversal, but the filesystem can
  // redirect an innocent-looking component. For example, `room/outside`
  // might be a symlink or Windows junction to a directory elsewhere, and
  // `outside/secret.txt` would then escape despite containing no `..`.
  //
  // Resolve the nearest existing ancestors so this also protects writes to
  // new files and new nested directories. The result is used only for the
  // check; callers keep the lexical path so room-relative event paths remain
  // stable even when the room itself was opened through a symlink.
  const candidateReal = canonicalPathWithMissingSuffix(candidate, requested);
  if (isOutside(rootReal, candidateReal)) {
    throw new InvalidError("That path resolves outside the room through a symlink.", {
      path: requested,
    });
  }

  const internalReal = canonicalPathWithMissingSuffix(
    join(rootAbs, ATRIUM_DIR),
    requested,
  );
  if (isAtOrInside(internalReal, candidateReal)) {
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
