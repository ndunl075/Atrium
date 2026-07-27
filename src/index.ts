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
  createTask,
  listTasks,
  getTask,
  claimTask,
  releaseTask,
  sweepExpiredClaims,
  type CreateTaskInput,
  type TaskFilter,
} from "./board.js";
export {
  submitTask,
  reviewTask,
  runAcceptanceCommand,
  pendingReview,
  type SubmitInput,
  type Verdict,
  type AcceptanceCommandResult,
} from "./acceptance.js";
export {
  foldLeases,
  currentLease,
  listLeases,
  acquireLease,
  renewLease,
  releaseLease,
} from "./leases.js";
export {
  readArtifact,
  readArtifactBytes,
  writeArtifact,
  deleteArtifact,
  listArtifacts,
  artifactInfo,
  type ArtifactRead,
  type ArtifactReadBytes,
  type WriteOptions,
} from "./artifacts.js";
export {
  getContext,
  pinArtifact,
  unpinArtifact,
  listPinned,
  describeHistory,
  type RoomContext,
  type PinnedArtifact,
  type HistoryLine,
} from "./context.js";
export {
  searchArtifacts,
  indexRoom,
  type SearchHit,
  type SearchOptions,
  type IndexStats,
} from "./search.js";
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
