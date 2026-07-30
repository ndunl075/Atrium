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
  foldRoster,
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
  renewClaim,
  releaseTask,
  restartTask,
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
  listDeletedArtifacts,
  artifactInfo,
  type ArtifactRead,
  type ArtifactReadBytes,
  type WriteOptions,
  type DeletedArtifact,
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
  type HistoryOptions,
} from "./context.js";
export {
  searchArtifacts,
  indexRoom,
  type SearchHit,
  type SearchOptions,
  type IndexStats,
} from "./search.js";
export {
  RoomServer,
  serveStdio,
  type ToolDefinition,
  type ToolResult,
  type RoomServerOptions,
} from "./mcp.js";
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
export {
  serveHttp,
  type ServeHttpOptions,
  type HttpServerHandle,
} from "./http.js";
export {
  serveWatch,
  escapeHtml,
  type ServeWatchOptions,
  type WatchServerHandle,
} from "./watch.js";
export {
  foldCosts,
  spendTotals,
  costSummary,
  reportCost,
  type CostReportInput,
  type SpendTotals,
  type MemberSpend,
  type CostSummary,
} from "./cost.js";
export {
  storeBlob,
  loadBlob,
  gcBlobs,
  pruneVersions,
  listVersions,
  contentAt,
  contentStateAt,
  isBinaryContent,
  diffArtifact,
  type ArtifactVersion,
  type ArtifactContent,
  type DiffResult,
  type GcResult,
  type PrunePlan,
  type PruneResult,
  type PruneOptions,
} from "./snapshots.js";
export {
  settingKeys,
  isSettingKey,
  listSettings,
  parseSettingValue,
  applyConfigChange,
  type SettingKey,
  type SettingListing,
  type ParsedSettingValue,
  type ConfigChangeResult,
} from "./config.js";
export {
  verifyRoom,
  type VerifySeverity,
  type VerifyFinding,
  type VerifySummary,
  type VerifyReport,
} from "./verify.js";
export { parseYaml, type YamlValue, type YamlParseOptions } from "./yaml.js";
export {
  parseJob,
  applyJob,
  type Job,
  type JobTask,
  type AppliedJob,
} from "./jobs.js";
export {
  parseRunnerConfig,
  loadRunnerConfig,
  planRunnerAssignments,
  workerEnvironment,
  launchWorker,
  runRoomOnce,
  type RunnerWorker,
  type RunnerConfig,
  type RunnerAssignment,
  type RunnerResult,
  type RunnerSummary,
  type RunnerHooks,
  type WorkerLauncher,
} from "./runner.js";
