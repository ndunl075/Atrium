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
  | { kind: "command"; command: string }
  | { kind: "reviewer" }
  | { kind: "human" }
  | { kind: "none" };

export type AcceptanceKind = Acceptance["kind"];

export interface Task {
  id: TaskId;
  title: string;
  description: string;
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
    dependsOn: TaskId[];
    acceptance: Acceptance;
  };
  "task.claimed": { taskId: TaskId; memberId: MemberId; expiresAt: string };
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

  "artifact.written": {
    path: string;
    bytes: number;
    hash: string;
    memberId: MemberId;
  };
  "artifact.deleted": { path: string; memberId: MemberId };

  "lease.acquired": { path: string; memberId: MemberId; expiresAt: string };
  "lease.renewed": { path: string; memberId: MemberId; expiresAt: string };
  "lease.released": {
    path: string;
    memberId: MemberId;
    reason: "voluntary" | "expired";
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
  /** USD, per member. Same "0 means no cap" rule as `roomSpendCapUsd`. */
  memberSpendCapUsd: number;
}

export const DEFAULT_ROOM_CONFIG: Omit<RoomConfig, "id" | "name" | "createdAt"> =
  {
    allowUncheckedAcceptance: false,
    leaseSeconds: 300,
    claimSeconds: 300,
    maxAttempts: 3,
    actionBudget: 1000,
    contextTokenCeiling: 8000,
    roomSpendCapUsd: 0,
    memberSpendCapUsd: 0,
  };
