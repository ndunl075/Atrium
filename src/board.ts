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
 */

import { ConflictError, InvalidError, NotFoundError, PermissionError } from "./errors.js";
import { Room } from "./room.js";
import { foldTasks, isClaimable } from "./tasks.js";
import type {
  Acceptance,
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
  "task.released",
  "task.submitted",
  "task.accepted",
  "task.rejected",
  "task.escalated",
] as const;

/** A moment before any real claim could have been made against. */
const EPOCH = new Date(0).toISOString();

export interface CreateTaskInput {
  title: string;
  description?: string;
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
      dependsOn,
      acceptance,
    });

    return requireTask(readBoard(room), taskId);
  });
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
    if (task.claimedBy !== actorId && actor.role !== "human") {
      throw new PermissionError(
        `${actor.name} does not hold the claim on ${taskId} and is not a ` +
          "human, so only the member holding it can release it.",
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
