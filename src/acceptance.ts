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

/** Long enough for most build and test commands, short enough that a hung
 * process does not stall the room forever. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

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
  if (task.state !== "claimed") {
    throw new InvalidError(
      `${taskId} is ${task.state}, not claimed, so there is nothing to hand in. Claim it first.`,
      { taskId, state: task.state },
    );
  }
  if (task.claimedBy !== actorId) {
    throw new PermissionError(
      `${actorId} does not hold the claim on ${taskId} (${task.claimedBy} does), so it cannot submit this work.`,
      { taskId, claimedBy: task.claimedBy, actorId },
    );
  }

  const submitted: PendingEvent<"task.submitted"> = {
    actor: actorId,
    type: "task.submitted",
    data: {
      taskId,
      memberId: actorId,
      summary: input.summary,
      artifacts: input.artifacts ?? [],
      basedOnSeq: input.basedOnSeq ?? room.log.head(),
    },
  };

  const { acceptance } = task;

  if (acceptance.kind === "none") {
    if (!room.config.allowUncheckedAcceptance) {
      throw new InvalidError(
        `${taskId} uses "none" acceptance, which this room does not allow. ` +
          `Turn on allowUncheckedAcceptance if auto-accept is genuinely intended, ` +
          `or give the task a command, reviewer, or human acceptance instead.`,
        { taskId },
      );
    }
    room.log.appendMany([
      submitted,
      {
        actor: actorId,
        type: "task.accepted",
        data: { taskId, by: actorId, via: "none" },
      },
    ]);
    return currentTask(room, taskId);
  }

  if (acceptance.kind === "command") {
    // The whole point of a command task: the machine decides, not the agent.
    const result = await runAcceptanceCommand(room, task);

    const entries: PendingEvent[] = [submitted];
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
      escalateIfNeeded(room, task, entries);
    }

    // Submission and verdict land together: a crash cannot leave a submission
    // on record with no verdict when the command already ran.
    room.log.appendMany(entries);
    return currentTask(room, taskId);
  }

  // "reviewer" or "human": the task now waits for reviewTask.
  room.log.appendMany([submitted]);
  return currentTask(room, taskId);
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
      data: { taskId, by: actorId, via: acceptance.kind, reason: verdict.reason },
    },
  ];
  escalateIfNeeded(room, task, entries);

  room.log.appendMany(entries);
  return currentTask(room, taskId);
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
 */
export async function runAcceptanceCommand(
  room: Room,
  task: Task,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<AcceptanceCommandResult> {
  if (task.acceptance.kind !== "command") {
    throw new InvalidError(
      `${task.id} does not use command acceptance, so there is no command to run.`,
      { taskId: task.id },
    );
  }

  return runShell(task.acceptance.command, room.dir, timeoutMs);
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
  timeoutMs: number,
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
        output: `${truncate(output)}\n[timed out after ${timeoutMs}ms and was killed]`,
      });
    }, timeoutMs);

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

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const cut = output.length - MAX_OUTPUT_CHARS;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${cut} more characters]`;
}
