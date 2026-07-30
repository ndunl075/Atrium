/**
 * The task board: putting work up, and picking it up.
 *
 * There is no board table. Everything here reads by folding the log with
 * `foldTasks` and writes by appending an event, so the board can never drift
 * from what actually happened — there is nothing to drift from.
 *
 * `claimTask` is the one function in this file that matters for correctness.
 * Two agents can run in two different processes and go for the same task at
 * the same moment. The only thing standing between that and two winners is
 * doing the read (fold the board), the check (is it claimable), and the write
 * (append `task.claimed`) inside a single `room.log.transaction`, which takes
 * SQLite's write lock for the whole span. Whoever's transaction commits first
 * sees the task open; the other sees it already claimed and gets a
 * `ConflictError`, because by the time its transaction actually runs, the log
 * has moved on underneath it.
 *
 * `renewClaim` does not need that same scrutiny for a different reason: it
 * never decides who holds a task, only how much longer whoever already holds
 * it gets to keep it, and it refuses the moment that stops being true (see
 * its own doc comment for why an already-lapsed claim is refused rather than
 * quietly resurrected).
 */

import { ConflictError, InvalidError, NotFoundError, PermissionError } from "./errors.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import { Room } from "./room.js";
import { foldTasks, isClaimable } from "./tasks.js";
import type {
  Acceptance,
  ExpectedOutput,
  MemberId,
  Task,
  TaskId,
  TaskState,
} from "./types.js";
import { addSeconds, hasPassed, newId, now } from "./util.js";

/** Only the events `foldTasks` looks at; no point reading the rest off disk. */
const TASK_EVENT_TYPES = [
  "task.created",
  "task.claimed",
  "task.claim_renewed",
  "task.released",
  "task.submitted",
  "task.accepted",
  "task.rejected",
  "task.input_requested",
  "task.input_supplied",
  "task.input_withdrawn",
  "task.escalated",
  "task.unescalated",
] as const;

/** A moment before any real claim could have been made against. */
const EPOCH = new Date(0).toISOString();

export interface CreateTaskInput {
  title: string;
  description?: string;
  expectedOutput?: ExpectedOutput;
  /** Paths this task is meant to produce. Optional; see `Task.produces`. */
  produces?: string[];
  dependsOn?: TaskId[];
  acceptance?: Acceptance;
}

export interface TaskFilter {
  state?: TaskState;
  claimedBy?: MemberId;
  claimable?: boolean;
}

/** The live board, folded from the log as of right now. */
function readBoard(room: Room): Map<TaskId, Task> {
  return foldTasks(room.log.read({ types: [...TASK_EVENT_TYPES] }), {
    maxAttempts: room.config.maxAttempts,
  });
}

function requireTask(board: Map<TaskId, Task>, taskId: TaskId): Task {
  const task = board.get(taskId);
  if (!task) {
    throw new NotFoundError(`No task ${taskId} in this room.`, { taskId });
  }
  return task;
}

export function createTask(
  room: Room,
  actorId: MemberId,
  input: CreateTaskInput,
): Task {
  room.assertUsable();
  room.member(actorId); // fails loudly on a bogus actor rather than logging one

  const title = input.title?.trim();
  if (!title) throw new InvalidError('A task needs a non-empty "title".');

  const expectedOutput = normalizeExpectedOutput(input.expectedOutput);
  const produces = normalizeProduces(room, input.produces);
  const acceptance: Acceptance = input.acceptance ?? { kind: "reviewer" };
  if (acceptance.kind === "none" && !room.config.allowUncheckedAcceptance) {
    throw new InvalidError(
      'This room does not allow "none" acceptance, so work cannot auto-accept ' +
        'on submit. Use "reviewer", "human", or "command" instead, or turn on ' +
        "allowUncheckedAcceptance on the room if self-certified work is really " +
        "what you want.",
    );
  }
  if (
    acceptance.kind === "command" &&
    (typeof acceptance.command !== "string" || acceptance.command.trim() === "")
  ) {
    throw new InvalidError(
      'A "command" acceptance needs a non-empty command to run.',
    );
  }
  // A per-task timeout is validated here, not just parsed, because this is
  // the one place both entry points (create_task over MCP, "atrium task add")
  // funnel through: a bad value caught here can never reach runAcceptanceCommand,
  // where 0 or a negative number would kill the command before it starts and
  // NaN or Infinity would mean it can never time out at all.
  if (acceptance.kind === "command" && acceptance.timeoutSeconds !== undefined) {
    const seconds = acceptance.timeoutSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      throw new InvalidError(
        `A command acceptance's timeoutSeconds must be a finite number of seconds ` +
          `greater than 0 (got ${JSON.stringify(acceptance.timeoutSeconds)}). Omit it ` +
          `to use the room's commandTimeoutSeconds instead.`,
      );
    }
  }

  const dependsOn = input.dependsOn ?? [];

  // The dependsOn check and the append happen in one transaction so a
  // dependency id is validated against the same board snapshot it gets
  // recorded against.
  return room.log.transaction(() => {
    const board = readBoard(room);
    for (const depId of dependsOn) {
      if (!board.has(depId)) {
        throw new NotFoundError(
          `Task ${depId} does not exist, so it cannot be a dependency. Create ` +
            "it first or fix the id.",
          { taskId: depId },
        );
      }
    }

    const taskId = newId("task");
    room.log.append(actorId, "task.created", {
      taskId,
      title,
      description: input.description ?? "",
      ...(expectedOutput !== undefined ? { expectedOutput } : {}),
      ...(produces !== undefined ? { produces } : {}),
      dependsOn,
      acceptance,
    });

    return requireTask(readBoard(room), taskId);
  });
}

/**
 * Validates `produces` and normalises each path the same way a write would.
 *
 * Resolved through `toArtifactPath` rather than trusted as typed, so a task
 * that declares `./draft.md` and a write of `draft.md` are the same path.
 * Without that, the gap report in `producedGaps` would fire on a file that is
 * sitting right there under a different spelling — a false alarm about the
 * one thing this feature exists to notice.
 */
function normalizeProduces(room: Room, value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidError('"produces" must be a list of paths this task will write.');
  }
  if (value.length === 0) return undefined;

  const paths = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvalidError(
        `Every "produces" entry must be a non-empty path (got ${JSON.stringify(entry)}).`,
      );
    }
    // Throws for a path escaping the room or reaching into .atrium, the same
    // as writing there would.
    return toArtifactPath(room.dir, resolveArtifact(room.dir, entry.trim()));
  });

  return [...new Set(paths)];
}

function normalizeExpectedOutput(value: ExpectedOutput | undefined): ExpectedOutput | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidError('"expectedOutput" must contain a description and optional JSON schema.');
  }

  const description = value.description?.trim();
  if (!description) {
    throw new InvalidError('"expectedOutput.description" must be non-empty text.');
  }

  if (
    value.schema !== undefined &&
    value.schema !== true &&
    value.schema !== false &&
    (typeof value.schema !== "object" || value.schema === null || Array.isArray(value.schema))
  ) {
    throw new InvalidError('"expectedOutput.schema" must be a JSON Schema object or boolean.');
  }

  if (value.schema !== undefined) {
    try {
      JSON.stringify(value.schema);
    } catch {
      throw new InvalidError('"expectedOutput.schema" must be JSON-serializable.');
    }
  }

  return {
    description,
    ...(value.schema !== undefined ? { schema: value.schema } : {}),
  };
}

export function listTasks(room: Room, filter: TaskFilter = {}): Task[] {
  const tasks = [...readBoard(room).values()];
  return tasks.filter((task) => {
    if (filter.state !== undefined && task.state !== filter.state) return false;
    if (filter.claimedBy !== undefined && task.claimedBy !== filter.claimedBy) {
      return false;
    }
    // isClaimable already accounts for blocking dependencies: a task with an
    // unfinished dependency folds to state "blocked", which isClaimable rejects.
    if (filter.claimable !== undefined && isClaimable(task) !== filter.claimable) {
      return false;
    }
    return true;
  });
}

export function getTask(room: Room, taskId: TaskId): Task {
  return requireTask(readBoard(room), taskId);
}

export function claimTask(room: Room, actorId: MemberId, taskId: TaskId): Task {
  room.assertUsable();
  // Reviewers judge work; they do not produce it, so they are not in this list.
  room.requireRole(actorId, ["worker", "human"]);

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (task.escalated) {
      throw new InvalidError(
        `Task ${taskId} is escalated after too many rejections; a human has ` +
          "to look at it and restart it before anyone can claim it.",
        { taskId },
      );
    }
    if (!isClaimable(task)) {
      const waiting =
        task.state === "blocked" && task.waitingOn && task.waitingOn.length > 0
          ? ` waiting on ${task.waitingOn.join(", ")}`
          : "";
      throw new ConflictError(
        `Task ${taskId} is ${task.state}${waiting}, not open to claim; re-read ` +
          "the board and try a different task.",
        { taskId, state: task.state, waitingOn: task.waitingOn },
      );
    }

    const expiresAt = addSeconds(now(), room.config.claimSeconds);
    room.log.append(actorId, "task.claimed", {
      taskId,
      memberId: actorId,
      expiresAt,
    });

    return requireTask(readBoard(room), taskId);
  });
}

/**
 * Extends a claim `actorId` already holds — the task-board equivalent of
 * `renewLease` in leases.ts, and modeled closely on it: same shape, same
 * "only the holder renews its own" rule, same approach of appending a fresh
 * expiry rather than mutating anything in place.
 *
 * Three refusals are kept distinct rather than folded into one message,
 * because each is a different fact about the world and an agent that acted
 * on the wrong one would make a different mistake:
 *
 * - **Never claimed at all** (or the claim already moved on to submitted,
 *   accepted, or rejected) — there is nothing here to renew.
 * - **Somebody else holds the claim** — renewing is not a way to take over
 *   another member's work, any more than `releaseTask` lets a non-holder
 *   release one.
 * - **The holder's own claim already lapsed.** This is the interesting case.
 *   `foldTasks` already treats a lapsed claim as freeing the task the
 *   instant it lapses (tasks.ts), so by the time this function is asked to
 *   renew it, the task has already been genuinely open — not just on a
 *   technicality — for however long it took the caller to notice and call
 *   this. Somebody else may have claimed it in that window. Quietly
 *   extending the old expiry would let two workers both believe they hold
 *   the same task, which is exactly the failure `claimTask`'s
 *   compare-and-swap exists to prevent — a renewal that resurrects a claim
 *   after the fact would be reintroducing that same race through a side
 *   door, just later. So a lapsed claim is refused outright, and the
 *   message points at `claimTask`: claiming the task fresh goes through the
 *   one codepath that actually re-checks the board against the log, and
 *   either succeeds (nobody beat you to it) or fails with the same
 *   `ConflictError` any other losing claim gets. `renewClaim` only ever
 *   extends a claim that is still genuinely live; it never revives one that
 *   has already died.
 *
 * The practical upshot: call this *before* `claimExpiresAt` (returned by
 * `getTask`), not after.
 */
export function renewClaim(room: Room, actorId: MemberId, taskId: TaskId): Task {
  room.assertUsable();
  room.member(actorId); // fails loudly on a bogus actor rather than a bogus renewal

  return room.log.transaction(() => {
    const at = now();
    // Folded at the epoch, the same trick sweepExpiredClaims uses above:
    // this shows whether the log has an unreleased task.claimed for this
    // task at all, regardless of whether the wall clock has since carried it
    // past its expiry. The live board (readBoard, folded at `at`) cannot
    // tell "never claimed" apart from "claimed and lapsed" — both read as
    // state "open" with no claimedBy — and that distinction is the entire
    // point of this function's error messages.
    const raw = requireTask(
      foldTasks(room.log.read({ types: [...TASK_EVENT_TYPES] }), {
        maxAttempts: room.config.maxAttempts,
        at: EPOCH,
      }),
      taskId,
    );

    if (raw.state !== "claimed") {
      throw new InvalidError(
        `Task ${taskId} is not claimed, so there is nothing to renew. Call ` +
          "claim_task if you want to take it.",
        { taskId, state: raw.state },
      );
    }
    if (raw.claimedBy !== actorId) {
      throw new PermissionError(
        `Task ${taskId} is claimed by ${raw.claimedBy}, not you. Only the ` +
          "member holding a claim can renew it.",
        { taskId, claimedBy: raw.claimedBy },
      );
    }
    // raw.state === "claimed" guarantees claimExpiresAt was set by
    // task.claimed or task.claim_renewed and has not been cleared since.
    if (hasPassed(raw.claimExpiresAt!, at)) {
      throw new ConflictError(
        `Your claim on ${taskId} expired at ${raw.claimExpiresAt}, so the ` +
          "task already went back on the board; somebody else may have " +
          "claimed it since. Call claim_task instead of renew_claim — it " +
          "will succeed if the task is still open, or say plainly if " +
          "somebody else got there first.",
        { taskId, claimExpiresAt: raw.claimExpiresAt },
      );
    }

    const expiresAt = addSeconds(at, room.config.claimSeconds);
    room.log.append(actorId, "task.claim_renewed", {
      taskId,
      memberId: actorId,
      expiresAt,
    });

    return requireTask(readBoard(room), taskId);
  });
}

/**
 * The holder of a claim saying it cannot go on without something.
 *
 * ARCHITECTURE.md §12.6. The task stays claimed by whoever asked — asking is
 * not giving up — and its claim stops expiring, so a question left overnight
 * does not cost the asker its place (see `applyDerivedState` for why that
 * cannot strand the task forever).
 *
 * Only the holder may ask, because the question is "I cannot continue", which
 * is not a thing a bystander can say on somebody else's behalf.
 */
export function askForInput(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
  question: string,
): Task {
  room.assertUsable();
  room.member(actorId);

  const text = question?.trim();
  if (!text) {
    throw new InvalidError(
      "A question needs to say what you are waiting for, or nobody can answer it.",
    );
  }

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (task.state === "needs_input") {
      throw new ConflictError(
        `Task ${taskId} is already waiting on an answer: "${task.pendingQuestion?.text}". ` +
          "Withdraw that question before asking another.",
        { taskId, pendingQuestion: task.pendingQuestion?.text },
      );
    }
    if (task.state !== "claimed" || !task.claimedBy) {
      throw new InvalidError(
        `Task ${taskId} is ${task.state}, not claimed, so there is no work in progress ` +
          "to be stuck on. Claim it first.",
        { taskId, state: task.state },
      );
    }
    if (task.claimedBy !== actorId) {
      throw new PermissionError(
        `Task ${taskId} is claimed by ${task.claimedBy}, not you. Only the member doing ` +
          "the work can say it is stuck.",
        { taskId, claimedBy: task.claimedBy },
      );
    }

    room.log.append(actorId, "task.input_requested", {
      taskId,
      memberId: actorId,
      question: text,
    });
    return requireTask(readBoard(room), taskId);
  });
}

/**
 * Answering somebody else's question, which puts the task back to work.
 *
 * The answer goes on the log rather than to the asker, so it is there for
 * whoever picks the task up — which need not be the member that asked, if the
 * asker has since died and the refreshed claim lapses.
 *
 * The asker cannot answer itself. Not because self-answering is dangerous the
 * way self-acceptance is, but because `needs_input` means "I could not work
 * this out", and a member that has worked it out after all wants
 * `withdrawQuestion`, which says that plainly instead of leaving a log where
 * somebody appears to have told themselves something.
 */
export function supplyInput(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
  answer: string,
): Task {
  room.assertUsable();
  room.member(actorId);

  const text = answer?.trim();
  if (!text) {
    throw new InvalidError("An answer cannot be empty; the task is waiting on something.");
  }

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (task.state !== "needs_input" || !task.pendingQuestion) {
      throw new InvalidError(
        `Task ${taskId} is ${task.state} and is not waiting on anything.`,
        { taskId, state: task.state },
      );
    }
    if (task.pendingQuestion.by === actorId) {
      throw new PermissionError(
        `You asked this question, so you cannot also answer it. If you have worked it ` +
          "out yourself, withdraw the question instead.",
        { taskId },
      );
    }

    room.log.append(actorId, "task.input_supplied", {
      taskId,
      memberId: actorId,
      answer: text,
      expiresAt: addSeconds(now(), room.config.claimSeconds),
    });
    return requireTask(readBoard(room), taskId);
  });
}

/** The asker taking its own question back, having resolved it. */
export function withdrawQuestion(room: Room, actorId: MemberId, taskId: TaskId): Task {
  room.assertUsable();
  room.member(actorId);

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (task.state !== "needs_input" || !task.pendingQuestion) {
      throw new InvalidError(
        `Task ${taskId} is ${task.state} and is not waiting on anything.`,
        { taskId, state: task.state },
      );
    }
    if (task.pendingQuestion.by !== actorId) {
      throw new PermissionError(
        `That question was asked by ${task.pendingQuestion.by}, not you. Answer it instead ` +
          "of withdrawing somebody else's.",
        { taskId, askedBy: task.pendingQuestion.by },
      );
    }

    room.log.append(actorId, "task.input_withdrawn", {
      taskId,
      memberId: actorId,
      expiresAt: addSeconds(now(), room.config.claimSeconds),
    });
    return requireTask(readBoard(room), taskId);
  });
}

export function releaseTask(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
): Task {
  room.assertUsable();
  const actor = room.member(actorId);

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (task.state !== "claimed" || !task.claimedBy) {
      throw new InvalidError(
        `Task ${taskId} is ${task.state}, not claimed; there is no claim to ` +
          "release.",
        { taskId, state: task.state },
      );
    }
    // A manager can take a claim off somebody else, the same as a human:
    // freeing a task a crashed worker is sitting on is housekeeping, not a
    // judgement about the work, so it does not need a person.
    if (task.claimedBy !== actorId && actor.role !== "human" && actor.role !== "manager") {
      throw new PermissionError(
        `${actor.name} does not hold the claim on ${taskId} and is neither a ` +
          "human nor a manager, so only the member holding it can release it.",
        { taskId, claimedBy: task.claimedBy, role: actor.role },
      );
    }

    room.log.append(actorId, "task.released", {
      taskId,
      memberId: task.claimedBy,
      reason: "voluntary",
    });

    return requireTask(readBoard(room), taskId);
  });
}

/**
 * Un-freezes an escalated task so it can be claimed again. ARCHITECTURE.md
 * section 6: three rejections escalates a task and freezes it, and only a
 * human can restart it, so this is gated the same way `reviewTask`'s human
 * acceptance is. The attempt counter is left alone on purpose — the log
 * should still show that this task has a history, not pretend it is fresh —
 * so a single further rejection escalates it again.
 */
export function restartTask(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
): Task {
  room.assertUsable();
  room.requireRole(actorId, ["human"]);

  return room.log.transaction(() => {
    const task = requireTask(readBoard(room), taskId);

    if (!task.escalated) {
      throw new InvalidError(
        `${taskId} is not escalated, so there is nothing to restart.`,
        { taskId },
      );
    }

    room.log.append(actorId, "task.unescalated", { taskId });

    return requireTask(readBoard(room), taskId);
  });
}

/**
 * Writes down every claim whose lease has lapsed as a `task.released` event,
 * so the log records why the task came back rather than leaving it implicit.
 * `foldTasks` already treats a lapsed claim as open (see tasks.ts), so this
 * function changes nothing about what is claimable — it just makes the log
 * match what every reader already concludes.
 */
export function sweepExpiredClaims(room: Room): Task[] {
  room.assertUsable();

  return room.log.transaction(() => {
    const events = room.log.read({ types: [...TASK_EVENT_TYPES] });
    // Folding at the epoch turns off the "an expired claim reads as open" rule
    // in tasks.ts, which is exactly what this needs: the raw fact of which
    // tasks the log still shows as claimed, regardless of the wall clock.
    const raw = foldTasks(events, { maxAttempts: room.config.maxAttempts, at: EPOCH });
    const nowIso = now();

    const lapsed = [...raw.values()].filter(
      (task) =>
        task.state === "claimed" &&
        task.claimExpiresAt !== undefined &&
        hasPassed(task.claimExpiresAt, nowIso),
    );
    if (lapsed.length === 0) return [];

    for (const task of lapsed) {
      room.log.append("system", "task.released", {
        taskId: task.id,
        memberId: task.claimedBy!,
        reason: "lease-expired",
      });
    }

    // Calling this twice must be harmless: the second pass folds the
    // `task.released` events just written, finds nothing still claimed at the
    // epoch, and returns an empty list.
    const board = readBoard(room);
    return lapsed.map((task) => requireTask(board, task.id));
  });
}
