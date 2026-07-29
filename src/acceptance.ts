/**
 * Deciding whether handed-in work is actually finished.
 *
 * ARCHITECTURE.md section 5 is blunt about this: an agent cannot mark its own
 * work done. Every task carries an `acceptance` field that says who or what is
 * trusted to make that call, and this module is the only place the call gets
 * made. `command` tasks are the whole point of the design — the exit code
 * decides, not anybody's opinion of the work — and `reviewer`/`human` tasks
 * still can never be signed off by the member who submitted them, no matter
 * what role that member holds.
 *
 * Reading task state here goes through `foldTasks` rather than a board module,
 * so this file agrees with whatever else is folding the same log.
 */

import { spawn } from "node:child_process";

import {
  InvalidError,
  NotFoundError,
  PermissionError,
} from "./errors.js";
import type { PendingEvent } from "./log.js";
import type { Room } from "./room.js";
import { foldTasks, needsEscalation } from "./tasks.js";
import type { MemberId, Task, TaskId } from "./types.js";

export interface SubmitInput {
  summary: string;
  /** Paths the submitter says it touched, relative to the room. */
  artifacts?: string[];
  /** Log position the work was based on. Defaults to the log head right now. */
  basedOnSeq?: number;
}

export type Verdict =
  | { accept: true; note?: string }
  | { accept: false; reason: string };

export interface AcceptanceCommandResult {
  ok: boolean;
  /** null when the command never produced an exit code, e.g. it timed out. */
  exitCode: number | null;
  output: string;
}

/** Command output past this size is truncated so a runaway process cannot
 * bloat the log; whoever is reading a verdict needs a diagnosis, not a dump. */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * Long enough for most build and test commands, short enough that a hung
 * process does not stall the room forever — this was the one timeout every
 * command acceptance got before `commandTimeoutSeconds` existed, and is now
 * only a safety net: it applies when a room's `commandTimeoutSeconds` was
 * saved by a version of this code before the field existed and has genuinely
 * never been read back as a real number (see `resolveTimeout`), not as the
 * everyday default. The everyday default lives in `DEFAULT_ROOM_CONFIG` in
 * types.ts, and happens to be the same 60 seconds so that nothing changes for
 * a room that has not touched the new setting.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Where a command's timeout came from, so a killed command's own message can
 * point at the thing to change instead of leaving whoever reads it guessing
 * whether the number is a per-task setting, the room's default, or something
 * a caller (a test, typically) passed in directly. */
type TimeoutOrigin = "task" | "room" | "override";

interface ResolvedTimeout {
  ms: number;
  seconds: number;
  origin: TimeoutOrigin;
}

/**
 * Works out how long a task's command acceptance gets to run, and where that
 * number came from. The task's own `timeoutSeconds` wins if it set one —
 * that is the whole point of letting a task override the room — otherwise
 * the room's `commandTimeoutSeconds` applies. A room setting that cannot mean
 * anything real (zero, negative, `NaN`, a config file written before this
 * field existed and never normalized back to a number) falls back to
 * `DEFAULT_COMMAND_TIMEOUT_MS` rather than silently becoming "killed before
 * it starts" or "can never time out" — `createTask` is what stops a bad
 * per-task value from ever reaching here, so this fallback exists only for a
 * room config nobody validated at the point it was written.
 */
function resolveTimeout(room: Room, task: Task): ResolvedTimeout {
  if (task.acceptance.kind === "command" && task.acceptance.timeoutSeconds !== undefined) {
    return {
      ms: task.acceptance.timeoutSeconds * 1000,
      seconds: task.acceptance.timeoutSeconds,
      origin: "task",
    };
  }
  const seconds = room.config.commandTimeoutSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return {
      ms: DEFAULT_COMMAND_TIMEOUT_MS,
      seconds: DEFAULT_COMMAND_TIMEOUT_MS / 1000,
      origin: "room",
    };
  }
  return { ms: seconds * 1000, seconds, origin: "room" };
}

/** The current view of one task, folded live from the log. */
function currentTask(room: Room, taskId: TaskId): Task {
  const tasks = foldTasks(room.log.read(), {
    maxAttempts: room.config.maxAttempts,
  });
  const task = tasks.get(taskId);
  if (!task) {
    throw new NotFoundError(`No task ${taskId} in this room.`, { taskId });
  }
  return task;
}

/**
 * Hands in the work on a claimed task. What happens next depends on the
 * task's acceptance: a `command` task runs its check immediately, a `none`
 * task auto-accepts (if the room allows it at all), and a `reviewer` or
 * `human` task just waits for somebody else to call `reviewTask`.
 */
export async function submitTask(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
  input: SubmitInput,
): Promise<Task> {
  room.assertUsable();

  const task = currentTask(room, taskId);
  assertSubmittable(task, actorId);

  const { acceptance } = task;
  if (acceptance.kind === "none" && !room.config.allowUncheckedAcceptance) {
    throw new InvalidError(
      `${taskId} uses "none" acceptance, which this room does not allow. ` +
        `Turn on allowUncheckedAcceptance if auto-accept is genuinely intended, ` +
        `or give the task a command, reviewer, or human acceptance instead.`,
      { taskId },
    );
  }

  // A command can take a minute, and the write lock cannot be held across it
  // without stopping the whole room, so it runs before the lock is taken. The
  // state it was checked against is re-checked below.
  const result =
    acceptance.kind === "command"
      ? await runAcceptanceCommand(room, task)
      : undefined;

  return room.log.transaction(() => {
    // The claim could have lapsed or been released while the command ran, so
    // the check that mattered is this one, taken with the write lock held.
    const fresh = currentTask(room, taskId);
    assertSubmittable(fresh, actorId);

    const entries: PendingEvent[] = [
      {
        actor: actorId,
        type: "task.submitted",
        data: {
          taskId,
          memberId: actorId,
          summary: input.summary,
          artifacts: input.artifacts ?? [],
          basedOnSeq: input.basedOnSeq ?? room.log.head(),
        },
      } satisfies PendingEvent<"task.submitted">,
    ];

    if (acceptance.kind === "none") {
      entries.push({
        actor: actorId,
        type: "task.accepted",
        data: { taskId, by: actorId, via: "none" },
      });
    } else if (result) {
      // The whole point of a command task: the machine decides, not the agent.
      if (result.ok) {
        entries.push({
          actor: actorId,
          type: "task.accepted",
          data: { taskId, by: actorId, via: "command", detail: result.output },
        });
      } else {
        entries.push({
          actor: actorId,
          type: "task.rejected",
          data: { taskId, by: actorId, via: "command", reason: result.output },
        });
        escalateIfNeeded(room, fresh, entries);
      }
    }
    // Anything else is "reviewer" or "human": the task now waits for reviewTask.

    // Submission and verdict land together: a crash cannot leave a submission
    // on record with no verdict when the command already ran.
    room.log.appendMany(entries);
    return currentTask(room, taskId);
  });
}

/** The task must be claimed, and claimed by whoever is handing it in. */
function assertSubmittable(task: Task, actorId: MemberId): void {
  if (task.state !== "claimed") {
    throw new InvalidError(
      `${task.id} is ${task.state}, not claimed, so there is nothing to hand in. Claim it first.`,
      { taskId: task.id, state: task.state },
    );
  }
  if (task.claimedBy !== actorId) {
    throw new PermissionError(
      `${actorId} does not hold the claim on ${task.id} (${task.claimedBy} does), so it cannot submit this work.`,
      { taskId: task.id, claimedBy: task.claimedBy, actorId },
    );
  }
}

/**
 * Records a verdict on submitted work. This is where the core rule lives: the
 * member who submitted the work is never the one who can accept or reject it,
 * whatever role it holds — a human submitter is still a submitter.
 */
export function reviewTask(
  room: Room,
  actorId: MemberId,
  taskId: TaskId,
  verdict: Verdict,
): Task {
  room.assertUsable();

  // Reading the task, checking it, and recording the verdict happen with the
  // write lock held. Two reviewers can reach the same submitted task at the
  // same moment, and without this both rejections would count: the attempt
  // counter would jump by two and freeze the task a go early.
  return room.log.transaction(() => {
    const task = currentTask(room, taskId);
    if (task.state !== "submitted") {
      throw new InvalidError(
        `${taskId} is ${task.state}, not submitted, so there is no verdict to give yet.`,
        { taskId, state: task.state },
      );
    }

    if (task.submittedBy === actorId) {
      throw new PermissionError(
        `${actorId} submitted this work and cannot also be the one who checks it. ` +
          `Work has to be checked by somebody else.`,
        { taskId, actorId },
      );
    }

    const { acceptance } = task;
    switch (acceptance.kind) {
      case "command":
        throw new PermissionError(
          `${taskId} is decided by its command, not by a manual verdict. ` +
            `Fix the work and hand it in again so the command can run.`,
          { taskId },
        );
      case "reviewer":
        room.requireRole(actorId, ["reviewer", "human"]);
        break;
      case "human":
        room.requireRole(actorId, ["human"]);
        break;
      case "none":
        // submitTask resolves "none" tasks the moment they are submitted, so a
        // task can never actually be sitting in "submitted" state with this kind.
        break;
    }

    if (verdict.accept) {
      room.log.append(actorId, "task.accepted", {
        taskId,
        by: actorId,
        via: acceptance.kind,
        detail: verdict.note,
      });
      return currentTask(room, taskId);
    }

    const entries: PendingEvent[] = [
      {
        actor: actorId,
        type: "task.rejected",
        data: {
          taskId,
          by: actorId,
          via: acceptance.kind,
          reason: verdict.reason,
        },
      },
    ];
    escalateIfNeeded(room, task, entries);

    room.log.appendMany(entries);
    return currentTask(room, taskId);
  });
}

/**
 * Adds a `task.escalated` event to `entries` when this rejection would put
 * the task over its attempt limit, so the rejection and the escalation land
 * in the same batch. Applies equally to command and manual rejections: a
 * task that keeps failing its own test suite stops rather than looping.
 */
function escalateIfNeeded(room: Room, task: Task, entries: PendingEvent[]): void {
  const attempts = task.attempts + 1;
  if (needsEscalation({ ...task, attempts }, room.config.maxAttempts)) {
    entries.push({
      actor: "system",
      type: "task.escalated",
      data: { taskId: task.id, attempts },
    });
  }
}

/**
 * Runs a task's acceptance command with the room's working directory as its
 * cwd. A failing or hanging command is a normal result, never a thrown error:
 * the caller decides what a bad exit code means.
 *
 * `timeoutMs`, when given, overrides both the task's own `timeoutSeconds` and
 * the room's `commandTimeoutSeconds` — this is for callers (tests, mainly)
 * that want to force a specific limit regardless of either setting. Leave it
 * out, which is what `submitTask` does, to get the resolution this feature is
 * actually for: the task's own setting if it has one, otherwise the room's.
 */
export async function runAcceptanceCommand(
  room: Room,
  task: Task,
  timeoutMs?: number,
): Promise<AcceptanceCommandResult> {
  if (task.acceptance.kind !== "command") {
    throw new InvalidError(
      `${task.id} does not use command acceptance, so there is no command to run.`,
      { taskId: task.id },
    );
  }

  const timeout: ResolvedTimeout =
    timeoutMs !== undefined
      ? { ms: timeoutMs, seconds: timeoutMs / 1000, origin: "override" }
      : resolveTimeout(room, task);

  return runShell(task.acceptance.command, room.dir, timeout);
}

/** Every task currently waiting on somebody to call `reviewTask`. */
export function pendingReview(room: Room): Task[] {
  const tasks = foldTasks(room.log.read(), {
    maxAttempts: room.config.maxAttempts,
  });
  return [...tasks.values()].filter((task) => task.state === "submitted");
}

// ---------------------------------------------------------------------------

/**
 * Needs a shell because the acceptance field is documented as "a shell
 * command that must exit 0" — pipes, `&&`, globbing, all the things a plain
 * argv exec cannot do.
 */
function runShell(
  command: string,
  cwd: string,
  timeout: ResolvedTimeout,
): Promise<AcceptanceCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });

    let output = "";
    let settled = false;
    const finish = (result: AcceptanceCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        exitCode: null,
        output:
          `${truncate(output)}\n[timed out after ${timeout.seconds}s and was killed — ` +
          `${describeTimeoutOrigin(timeout)}]`,
      });
    }, timeout.ms);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    // Spawning itself failed (bad cwd, missing shell, ...) rather than the
    // command running and failing. Still a normal, reportable result.
    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: null,
        output: `Could not run the command: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code, output: truncate(output) });
    });
  });
}

/**
 * The point of tracking `origin` at all: whoever reads a timed-out command's
 * output needs to know this is not the command failing on its own merits, and
 * needs a concrete next step rather than a bare number. What the two real
 * origins actually differ on is which knob to turn.
 */
function describeTimeoutOrigin(timeout: ResolvedTimeout): string {
  switch (timeout.origin) {
    case "task":
      return (
        `this is this task's own acceptance.timeoutSeconds (${timeout.seconds}), not a ` +
        `real test failure; raise it on the task if the command genuinely needs longer`
      );
    case "room":
      return (
        `this is the room's commandTimeoutSeconds (${timeout.seconds}), not a real test ` +
        `failure; raise it on the room, or set a longer timeoutSeconds on this task's ` +
        `command acceptance if only this command needs more time`
      );
    case "override":
      return `a timeout of ${timeout.seconds}s was passed in directly for this run`;
  }
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const cut = output.length - MAX_OUTPUT_CHARS;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${cut} more characters]`;
}
