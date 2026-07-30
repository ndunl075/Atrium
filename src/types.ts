/**
 * Every type in the Atrium domain.
 *
 * This file is the contract between modules. The board, the artifact store, the
 * acceptance rules and the context layer all read and write the same shapes, so
 * changing something here changes it for everybody.
 */

export type MemberId = string;
export type TaskId = string;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * - `worker`   claims tasks and produces artifacts
 * - `reviewer` accepts or rejects finished work, but never its own
 * - `human`    everything a reviewer can do, plus running the room
 */
export type MemberRole = "worker" | "reviewer" | "human";

export interface Member {
  id: MemberId;
  name: string;
  role: MemberRole;
  /**
   * How the member describes itself, in prose. There is deliberately no formal
   * capability schema: a taxonomy costs weeks and nobody uses it.
   */
  manifest: string;
  /** Rough, free-form labels like "research" or "typescript". Not validated. */
  tags: string[];
  joinedAt: string;
  /** Goes false when the member leaves. Members are never removed from history. */
  active: boolean;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskState =
  | "open"
  | "claimed"
  | "submitted"
  | "accepted"
  | "rejected"
  | "blocked";

/**
 * How a task is allowed to be called finished. Listed cheapest to most
 * trustworthy in the docs; `none` exists so that rooms can refuse it.
 */
export type Acceptance =
  | {
      kind: "command";
      command: string;
      /**
       * Seconds this task's command gets before it is killed and reported as
       * a rejection. Overrides the room's `commandTimeoutSeconds` for this
       * task only — a lint check and a full integration suite in the same
       * room legitimately want different limits. Omit to use the room's
       * setting. Must be a finite number greater than 0 where it is set
       * (validated by `createTask`); zero, negative, or non-finite would mean
       * a command killed before it starts, or never.
       */
      timeoutSeconds?: number;
    }
  | { kind: "reviewer" }
  | { kind: "human" }
  | { kind: "none" };

export type AcceptanceKind = Acceptance["kind"];

/**
 * The contract a finished result is expected to satisfy. It informs the
 * worker and the independent acceptor; it never accepts work by itself.
 */
export interface ExpectedOutput {
  /** Plain-language description of what a finished result looks like. */
  description: string;
  /** Optional JSON Schema for tasks whose result has a structured shape. */
  schema?: boolean | Record<string, unknown>;
}

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  expectedOutput?: ExpectedOutput;
  /** Task ids that must be accepted before this one can be worked on. */
  dependsOn: TaskId[];
  acceptance: Acceptance;
  state: TaskState;
  createdBy: MemberId;
  createdAt: string;

  /** Set while the task is claimed or awaiting a verdict. */
  claimedBy?: MemberId;
  claimedAt?: string;
  /** When the claim lapses and the task goes back on the board. */
  claimExpiresAt?: string;

  /** Set once work has been handed in and is waiting on a verdict. */
  submittedBy?: MemberId;
  submittedAt?: string;
  /** Log position the submitted work was based on, for staleness checks. */
  submittedAtSeq?: number;
  /** Paths the submitter says it touched. */
  submittedArtifacts?: string[];
  submissionSummary?: string;

  /** How many times handed-in work has been turned down. */
  attempts: number;
  /** Why it was turned down the last time. */
  lastRejection?: { by: MemberId; reason: string; at: string };

  /** Frozen after too many rejections; only a human can restart it. */
  escalated: boolean;

  /** Which unfinished tasks are holding this one up, when blocked. */
  waitingOn?: TaskId[];

  /** Log position this snapshot was folded at. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Artifacts and leases
// ---------------------------------------------------------------------------

/** A claim on one path. Writing without one is refused. */
export interface Lease {
  path: string;
  holder: MemberId;
  acquiredAt: string;
  expiresAt: string;
  /** Log position when the lease was taken. */
  seq: number;
}

export interface ArtifactInfo {
  /** Path relative to the room's working directory, using forward slashes. */
  path: string;
  bytes: number;
  /** sha256 of the contents, as recorded in the log. */
  hash: string;
  /** Log position of the most recent write. */
  seq: number;
  lastWrittenBy: MemberId;
  lastWrittenAt: string;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * Every kind of thing that can happen in a room, with the payload it carries.
 *
 * The board and the roster are folded from these records rather than stored
 * separately, so anything that needs to survive a replay has to be in here.
 */
export interface EventMap {
  "room.created": { roomId: string; name: string };

  "member.joined": {
    memberId: MemberId;
    name: string;
    role: MemberRole;
    manifest: string;
    tags: string[];
  };
  "member.left": { memberId: MemberId };

  "task.created": {
    taskId: TaskId;
    title: string;
    description: string;
    expectedOutput?: ExpectedOutput;
    dependsOn: TaskId[];
    acceptance: Acceptance;
  };
  "task.claimed": { taskId: TaskId; memberId: MemberId; expiresAt: string };
  /**
   * The holder extending a claim it already has, before it lapses. Never
   * changes who holds the claim — `renewClaim` in board.ts only lets the
   * current holder call it — so folding this only ever moves `claimExpiresAt`
   * forward, the same way `lease.renewed` only ever moves a lease's.
   */
  "task.claim_renewed": { taskId: TaskId; memberId: MemberId; expiresAt: string };
  "task.released": {
    taskId: TaskId;
    memberId: MemberId;
    reason: "voluntary" | "lease-expired";
  };
  "task.blocked": { taskId: TaskId; waitingOn: TaskId[] };
  "task.unblocked": { taskId: TaskId };
  "task.submitted": {
    taskId: TaskId;
    memberId: MemberId;
    summary: string;
    artifacts: string[];
    /** Log position the work was based on. */
    basedOnSeq: number;
  };
  "task.accepted": {
    taskId: TaskId;
    by: MemberId;
    via: AcceptanceKind;
    /** Command output, reviewer note, or whatever justified the verdict. */
    detail?: string;
  };
  "task.rejected": {
    taskId: TaskId;
    by: MemberId;
    via: AcceptanceKind;
    reason: string;
  };
  "task.escalated": { taskId: TaskId; attempts: number };
  /** Only a human can record this: it is what un-freezes an escalated task. */
  "task.unescalated": { taskId: TaskId };

  "artifact.written": {
    path: string;
    bytes: number;
    hash: string;
    memberId: MemberId;
  };
  "artifact.deleted": { path: string; memberId: MemberId };

  /**
   * Content dropped by a retention sweep. The versions themselves stay in the
   * log and still list in `atrium history` — what is gone is their bytes.
   * Recording it is the point: without this the log would show a version whose
   * content cannot be read and give no way to tell "discarded on purpose"
   * from "something has damaged the object store".
   */
  "artifact.pruned": {
    path: string;
    /** Log positions whose content was dropped, oldest first. */
    seqs: number[];
    bytesReclaimed: number;
    /** The retention setting the sweep ran with. */
    retained: number;
  };

  "lease.acquired": { path: string; memberId: MemberId; expiresAt: string };
  "lease.renewed": { path: string; memberId: MemberId; expiresAt: string };
  /**
   * `memberId` is always the member who *held* the lease, not necessarily
   * whoever caused the release — those differ exactly when `reason` is
   * `"forced"`, so `event.actor` is where a human administrator taking
   * someone else's lease away shows up.
   */
  "lease.released": {
    path: string;
    memberId: MemberId;
    reason: "voluntary" | "expired" | "forced";
  };

  "context.pinned": { path: string; memberId: MemberId };
  "context.unpinned": { path: string; memberId: MemberId };

  "note.posted": { memberId: MemberId; text: string; taskId?: TaskId };

  "room.halted": { reason: string };

  /**
   * A member self-reporting what a model call cost. Atrium does not make the
   * call itself, so this is the only way it learns about money spent — see
   * ARCHITECTURE.md §6. A member that never appends one of these is never
   * charged for anything, by construction.
   */
  "cost.reported": {
    memberId: MemberId;
    /** USD. Validated non-negative and finite before this is appended. */
    amountUsd: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    note?: string;
  };
}

export type EventType = keyof EventMap;

/**
 * Every event type, registered once so the log's `types` filter (see
 * `ReadOptions` in log.ts, and "atrium log --type" / the MCP `read_log`
 * tool) can validate against something other than a second, hand-copied
 * list. `Record<EventType, true>` is what does the actual work: if EventMap
 * ever gains a key without this object gaining the matching one, the build
 * fails right here instead of the new event type just silently never
 * matching any `--type` filter anyone types. The config.ts settings registry
 * uses the same trick for the same reason.
 */
const EVENT_TYPE_REGISTRY: Record<EventType, true> = {
  "room.created": true,
  "member.joined": true,
  "member.left": true,
  "task.created": true,
  "task.claimed": true,
  "task.claim_renewed": true,
  "task.released": true,
  "task.blocked": true,
  "task.unblocked": true,
  "task.submitted": true,
  "task.accepted": true,
  "task.rejected": true,
  "task.escalated": true,
  "task.unescalated": true,
  "artifact.written": true,
  "artifact.deleted": true,
  "artifact.pruned": true,
  "lease.acquired": true,
  "lease.renewed": true,
  "lease.released": true,
  "context.pinned": true,
  "context.unpinned": true,
  "note.posted": true,
  "room.halted": true,
  "cost.reported": true,
};

/** Every event type there is, in the order EventMap declares them. */
export function eventTypes(): EventType[] {
  return Object.keys(EVENT_TYPE_REGISTRY) as EventType[];
}

export function isEventType(type: string): type is EventType {
  return (eventTypes() as string[]).includes(type);
}

export interface Event<T extends EventType = EventType> {
  /** Position in the log. Starts at 1 and never has gaps. */
  seq: number;
  ts: string;
  /** The member that caused it, or "system" for lease expiry and the like. */
  actor: MemberId | "system";
  type: T;
  data: EventMap[T];
}

/**
 * The union form. Switching on `type` narrows `data` to the right payload,
 * which is what folding code wants.
 */
export type AnyEvent = { [K in EventType]: Event<K> }[EventType];

// ---------------------------------------------------------------------------
// Room settings
// ---------------------------------------------------------------------------

export interface RoomConfig {
  id: string;
  name: string;
  createdAt: string;

  /**
   * Whether tasks may use `none` acceptance, which auto-accepts on hand-in.
   * Off by default: self-declared completion is the failure this project exists
   * to prevent.
   */
  allowUncheckedAcceptance: boolean;

  /** Seconds a lease on a file lasts before it lapses. */
  leaseSeconds: number;
  /** Seconds a task claim lasts before the task goes back on the board. */
  claimSeconds: number;
  /**
   * Seconds a `command` acceptance gets to run before it is killed and
   * reported as a rejection, for every task in the room that does not set its
   * own `timeoutSeconds` (see `Acceptance`). Defaults to 60, the limit every
   * command acceptance had before this setting existed, so an existing room
   * that never touches this field behaves exactly as it did before.
   */
  commandTimeoutSeconds: number;
  /** Rejections a task may collect before it freezes and waits for a human. */
  maxAttempts: number;
  /** Total events a room may record before it stops itself. */
  actionBudget: number;
  /** Hard ceiling on the shared brief, measured in tokens. */
  contextTokenCeiling: number;

  /**
   * USD. Total of every member's self-reported spend before the room halts.
   * `0` means no cap — a room that never sets one behaves exactly as it did
   * before cost accounting existed. This is advisory in the strict sense:
   * see ARCHITECTURE.md §6. Atrium can only total what gets reported to it.
   */
  roomSpendCapUsd: number;
  /**
   * Versions of each artifact whose content is kept on disk. `0` means keep
   * everything, the same "0 means no cap" rule as the spend caps, and is the
   * default: a room never discards history unless it is told to. Nothing is
   * dropped automatically even when this is set — `atrium prune` applies it,
   * so discarding history stays something a person does deliberately.
   */
  retainVersionsPerPath: number;

  /** USD, per member. Same "0 means no cap" rule as `roomSpendCapUsd`. */
  memberSpendCapUsd: number;
}

export const DEFAULT_ROOM_CONFIG: Omit<RoomConfig, "id" | "name" | "createdAt"> =
  {
    allowUncheckedAcceptance: false,
    leaseSeconds: 300,
    claimSeconds: 300,
    commandTimeoutSeconds: 60,
    maxAttempts: 3,
    actionBudget: 1000,
    contextTokenCeiling: 8000,
    roomSpendCapUsd: 0,
    retainVersionsPerPath: 0,
    memberSpendCapUsd: 0,
  };
