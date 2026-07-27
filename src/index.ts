/**
 * The public surface of the package.
 *
 * Feature modules are wired in here as they land, so that adding one is a
 * single line rather than a merge conflict.
 */

export * from "./types.js";
export * from "./errors.js";
export { EventLog, type ReadOptions, type PendingEvent } from "./log.js";
export {
  Room,
  type CreateRoomOptions,
  type JoinOptions,
  type JoinResult,
} from "./room.js";
export {
  foldTasks,
  blockingDependencies,
  isClaimable,
  needsEscalation,
  type FoldOptions,
} from "./tasks.js";
export {
  roomPaths,
  resolveArtifact,
  toArtifactPath,
  isRoomInternal,
  ATRIUM_DIR,
  CONTEXT_FILE,
  type RoomPaths,
} from "./paths.js";
export {
  now,
  addSeconds,
  hasPassed,
  newId,
  sha256,
  estimateTokens,
} from "./util.js";
