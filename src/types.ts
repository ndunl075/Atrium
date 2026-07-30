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
 * What a member is allowed to do.
 *
 * `worker` produces work. `reviewer` judges other members' work and does not
 * produce any. `manager` is a reviewer that can also unstick the board —
 * releasing a claim somebody else is sitting on — for a supervising agent
 * that should not need a human for routine housekeeping. `human` is all of
 * that plus room administration, and is the only role that can un-freeze an
 * escalated task, because that freeze is §5's backstop and handing an agent
 * the key to it would defeat the point of having one.
 */
export type MemberRole = "worker" | "reviewer" | "manager" | "human";

/**
 * Every role, registered once so the runtime check and the type cannot drift
 * apart. `Record<MemberRole, true>` is what does the work: adding a role to
 * the union without adding it here fails the build, which is exactly what did
 * not happen when `manager` was added and `isRole` kept silently refusing it.
 * The event type registry below uses the same trick for the same reason.
 */
const MEMBER_ROLE_REGISTRY: Record<MemberRole, true> = {
  worker: true,
  reviewer: true,
  manager: true,
  human: true,
};

/** Every role, for validation and for error messages that list the options. */
export function memberRoles(): MemberRole[] {
  return Object.keys(MEMBER_ROLE_REGISTRY) as MemberRole[];
}

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && Object.hasOwn(MEMBER_ROLE_REGISTRY, value);
}

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
  /**
   * Started, and stuck: the holder needs something before it can go on.
   *
   * ARCHITECTURE.md §12.6, from A2A's task lifecycle. Without this a blocked
   * agent has three bad options — release the claim and lose its place, sit on
   * it until the lease lapses, or guess — and guessing is the one an LLM
   * picks. It is also the one that produces the plausible-but-wrong output §5
   * exists to catch, so the absence of this state was quietly pushing work
   * toward the failure the whole project is about.
   */
  | "needs_input"
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
  /**
   * Paths this task is meant to produce (ARCHITECTURE.md §13.6, from
   * Dagster's software-defined assets).
   *
   * Sits *alongside* `dependsOn` rather than replacing it, which is the
   * answer to the open question that section carried. Some work genuinely
   * produces no file — a review, a decision, a sign-off whose whole output is
   * a verdict — and a model where every task had to name an artifact would
   * make those awkward or fake. So this is optional, and a task without it is
   * not a lesser task.
   *
   * It is a declaration of intent, never a gate: `producedGaps` reports a
   * task that promised a file and did not write it, for whoever is deciding
   * whether the work is finished. §5 keeps that decision with a member.
   */
  produces?: string[];
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

  /** Set while the task is in `needs_input`: what the holder is waiting for. */
  pendingQuestion?: { by: MemberId; text: string; at: string };
  /** The last answer the task received, kept after it goes back to work. */
  lastAnswer?: { by: MemberId; text: string; at: string };

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
    produces?: string[];
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
  /**
   * The holder of a claim saying it cannot go on without something.
   *
   * The question and its answer are events, not a message between two
   * members. That is what keeps this inside the §2 thesis instead of
   * reintroducing the handoff it argues against: a third agent reading the
   * room afterwards sees the question, the answer, and what was done with
   * them, in order, without anybody having summarised anything.
   */
  "task.input_requested": { taskId: TaskId; memberId: MemberId; question: string };
  /**
   * Somebody other than the asker answering it.
   *
   * `expiresAt` is a *fresh* claim window, not the remains of the old one.
   * A claim stops expiring while a task waits (see `applyDerivedState`),
   * because a question left overnight should not cost the asker its place —
   * so by the time an answer arrives the original window is usually long
   * past, and restoring it would drop the task the instant it was unblocked.
   *
   * This is also what answers the objection §12.6 raised against pausing at
   * all. If the asker died right after asking, the answer hands it a fresh
   * window it will never renew, and the claim lapses normally a moment later.
   * The task returns to the board on its own; nothing is held forever.
   */
  "task.input_supplied": {
    taskId: TaskId;
    memberId: MemberId;
    answer: string;
    expiresAt: string;
  };
  /** The asker withdrawing its own question, having resolved it. */
  "task.input_withdrawn": { taskId: TaskId; memberId: MemberId; expiresAt: string };

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

  /**
   * What the room's brief said, recorded so the log stops being silent about
   * the one input every agent reads.
   *
   * ARCHITECTURE.md §3.5 calls the log the single source of truth, and until
   * this existed that was false in exactly one place: pinning was an event,
   * but editing `CONTEXT.md` was a plain file write nothing recorded. The log
   * held every consequence of the instruction and not the instruction, so no
   * replay could recover what an agent was actually told.
   *
   * The bytes go in the same content-addressed store artifacts use, keyed by
   * this hash, which is what lets `atrium context --at` and a fork read a past
   * brief back rather than only knowing that it changed.
   */
  "context.written": {
    hash: string;
    bytes: number;
    /**
     * Where the bytes came from, which is not the same question as who the
     * actor is. `atrium` means Atrium itself wrote them — seeding a room from
     * a job file, say — so the actor authored this content. `observed` means
     * Atrium read them off disk: the file had already changed, and this is a
     * room noticing rather than a member writing.
     *
     * The brief is deliberately still a file anybody can edit in any editor
     * (§4), so this distinction is the honest one. A room must not claim
     * somebody authored a change it merely found.
     */
    source: "atrium" | "observed";
  };

  "note.posted": { memberId: MemberId; text: string; taskId?: TaskId };

  "room.halted": { reason: string };

  /**
   * Where a forked room came from. Appended once, immediately after the
   * history copied out of the parent, so a fork's provenance is in the log
   * rather than only in its config — a room that could not say what it was
   * forked from would be telling the truth about everything except its own
   * first cause.
   *
   * It sits *after* the copied events on purpose. Everything at or below
   * `atSeq` is byte-identical to the parent, so replaying a fork to any point
   * in that range gives exactly what replaying the parent to the same point
   * gives, and the divergence has a sequence number of its own.
   */
  "room.forked": {
    /** The parent's room id, which no longer exists anywhere else. */
    fromRoomId: string;
    fromName: string;
    /** The parent sequence number this room was taken from. */
    atSeq: number;
    /** Paths whose content the parent no longer had, so the fork has none. */
    unrecoverablePaths: string[];
  };

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
  "task.input_requested": true,
  "task.input_supplied": true,
  "task.input_withdrawn": true,
  "task.escalated": true,
  "task.unescalated": true,
  "artifact.written": true,
  "artifact.deleted": true,
  "artifact.pruned": true,
  "lease.acquired": true,
  "lease.renewed": true,
  "lease.released": true,
  "context.pinned": true,
  "context.written": true,
  "context.unpinned": true,
  "note.posted": true,
  "room.halted": true,
  "room.forked": true,
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
