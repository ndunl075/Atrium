/**
 * Folding the log into the task board.
 *
 * Nothing here writes. This is the shared reading of what the events mean, used
 * both by the module that puts tasks on the board and by the one that decides
 * whether handed-in work is finished, so that the two can never disagree about
 * what state a task is in.
 *
 * The state machine, from ARCHITECTURE.md:
 *
 *     open -> claimed -> submitted -> accepted
 *                            |
 *                        rejected -> open
 *       |
 *    blocked -> open
 *
 * Two things are worked out here rather than stored:
 *
 * - **blocked** is derived from whether a task's dependencies have been
 *   accepted. Keeping it as a stored flag would mean a second copy of the truth
 *   that could drift, so it is recomputed on every fold.
 * - **a lapsed claim** frees its task. An agent that crashes holding a claim
 *   should not wedge the board until somebody notices, and this way no sweeper
 *   process has to be running for the board to be correct.
 *
 * Because a lapsed claim depends on the time you ask, `at` is an argument. Pass
 * the current time for a live board; pass the timestamp of the event you are
 * replaying to for a view of how the board looked back then.
 */

import type { AnyEvent, Task, TaskId } from "./types.js";
import { hasPassed, now } from "./util.js";

export interface FoldOptions {
  /** Rejections a task may collect before it freezes. */
  maxAttempts: number;
  /** The moment to judge lapsed claims against. Defaults to right now. */
  at?: string;
}

/**
 * Replays task history into the current board.
 *
 * `task.blocked` and `task.unblocked` events are deliberately ignored: they are
 * there so a human reading the log can see when something stalled, but blocking
 * is worked out from dependencies, which cannot fall out of step.
 */
export function foldTasks(
  events: AnyEvent[],
  options: FoldOptions,
): Map<TaskId, Task> {
  const at = options.at ?? now();
  const tasks = new Map<TaskId, Task>();

  for (const event of events) {
    switch (event.type) {
      case "task.created": {
        tasks.set(event.data.taskId, {
          id: event.data.taskId,
          title: event.data.title,
          description: event.data.description,
          dependsOn: event.data.dependsOn,
          acceptance: event.data.acceptance,
          state: "open",
          createdBy: event.actor,
          createdAt: event.ts,
          attempts: 0,
          escalated: false,
          seq: event.seq,
        });
        break;
      }

      case "task.claimed": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        task.state = "claimed";
        task.claimedBy = event.data.memberId;
        task.claimedAt = event.ts;
        task.claimExpiresAt = event.data.expiresAt;
        task.seq = event.seq;
        break;
      }

      case "task.released": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        task.state = "open";
        delete task.claimedBy;
        delete task.claimedAt;
        delete task.claimExpiresAt;
        task.seq = event.seq;
        break;
      }

      case "task.submitted": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        task.state = "submitted";
        task.submittedBy = event.data.memberId;
        task.submittedAt = event.ts;
        task.submittedAtSeq = event.data.basedOnSeq;
        task.submittedArtifacts = event.data.artifacts;
        task.submissionSummary = event.data.summary;
        task.seq = event.seq;
        break;
      }

      case "task.accepted": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        task.state = "accepted";
        delete task.claimExpiresAt;
        task.seq = event.seq;
        break;
      }

      case "task.rejected": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        // Back on the board, but the state records why it came back and the
        // count is what eventually freezes it.
        task.state = "rejected";
        task.attempts += 1;
        task.lastRejection = {
          by: event.data.by,
          reason: event.data.reason,
          at: event.ts,
        };
        delete task.claimedBy;
        delete task.claimedAt;
        delete task.claimExpiresAt;
        delete task.submittedBy;
        delete task.submittedAt;
        delete task.submittedAtSeq;
        task.seq = event.seq;
        break;
      }

      case "task.escalated": {
        const task = tasks.get(event.data.taskId);
        if (!task) break;
        task.escalated = true;
        task.seq = event.seq;
        break;
      }

      default:
        break;
    }
  }

  for (const task of tasks.values()) applyDerivedState(task, tasks, at);
  return tasks;
}

/**
 * The states a task can be picked up from. `rejected` is one of them: a
 * rejection puts the work back on the board, and the state is what tells the
 * next agent that it is a second go rather than a fresh start.
 */
const CLAIMABLE_STATES = new Set(["open", "rejected"]);

function applyDerivedState(
  task: Task,
  tasks: Map<TaskId, Task>,
  at: string,
): void {
  // A claim that has run out frees the task, whether or not anybody noticed.
  if (task.state === "claimed" && task.claimExpiresAt && hasPassed(task.claimExpiresAt, at)) {
    task.state = "open";
    delete task.claimedBy;
    delete task.claimedAt;
    delete task.claimExpiresAt;
  }

  delete task.waitingOn;
  if (!CLAIMABLE_STATES.has(task.state)) return;

  const waitingOn = blockingDependencies(task, tasks);
  if (waitingOn.length > 0) {
    task.state = "blocked";
    task.waitingOn = waitingOn;
  }
}

/**
 * Which of a task's dependencies are not finished yet. A dependency nobody has
 * created counts as unfinished, so a typo in a task id stalls the work rather
 * than quietly letting it through.
 */
export function blockingDependencies(
  task: Task,
  tasks: Map<TaskId, Task>,
): TaskId[] {
  return task.dependsOn.filter((id) => tasks.get(id)?.state !== "accepted");
}

/** Whether anybody could pick this task up right now. */
export function isClaimable(task: Task): boolean {
  return CLAIMABLE_STATES.has(task.state) && !task.escalated;
}

/** Whether this task has collected enough rejections to need a human. */
export function needsEscalation(task: Task, maxAttempts: number): boolean {
  return !task.escalated && task.attempts >= maxAttempts;
}
