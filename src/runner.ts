/**
 * The optional thin runner starts workers; it does not become the board.
 *
 * A dispatch pass reads claimable tasks from the Room, pairs them with the
 * operator's configured worker slots, and launches those commands with the
 * assignment in environment variables. The worker must still join and claim
 * the task through Atrium. That keeps tasks, claims, acceptance, and history
 * in the Room instead of creating a private scheduler state alongside it.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { InvalidError } from "./errors.js";
import { listTasks } from "./board.js";
import type { Room } from "./room.js";
import type { Task } from "./types.js";

export interface RunnerWorker {
  /** Human-readable label shown in runner output. */
  name: string;
  /** Operator-authored shell command. */
  command: string;
  /**
   * Start this worker once and leave it running, rather than once per task
   * (ARCHITECTURE.md §12.9, from Temporal's worker model). It finds its own
   * work by claiming from the board.
   *
   * Process startup for an agent runtime is not milliseconds, so a worker
   * that stays up and holds a warm connection is what a real deployment
   * looks like.
   */
  poll?: boolean;
}

export interface RunnerConfig {
  workers: RunnerWorker[];
  /** Caps a single dispatch pass. Defaults to the number of worker slots. */
  maxConcurrent?: number;
}

export interface RunnerAssignment {
  worker: RunnerWorker;
  task: Task;
}

export interface RunnerResult extends RunnerAssignment {
  exitCode: number;
}

export interface RunnerSummary {
  assignments: RunnerAssignment[];
  results: RunnerResult[];
}

export interface RunnerHooks {
  onStart?(assignment: RunnerAssignment): void;
  onExit?(result: RunnerResult): void;
}

export type WorkerLauncher = (
  assignment: RunnerAssignment,
  roomDir: string,
) => Promise<number>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Validate untrusted JSON before it can reach a shell. */
export function parseRunnerConfig(value: unknown): RunnerConfig {
  const raw = record(value, "Runner config");
  if (!Array.isArray(raw.workers) || raw.workers.length === 0) {
    throw new InvalidError('Runner config needs a non-empty "workers" array.');
  }

  const workers = raw.workers.map((entry, index): RunnerWorker => {
    const worker = record(entry, `workers[${index}]`);
    const name = typeof worker.name === "string" ? worker.name.trim() : "";
    const command = typeof worker.command === "string" ? worker.command.trim() : "";
    if (!name) throw new InvalidError(`workers[${index}].name must be a non-empty string.`);
    if (!command) {
      throw new InvalidError(`workers[${index}].command must be a non-empty string.`);
    }
    if (worker.poll !== undefined && typeof worker.poll !== "boolean") {
      throw new InvalidError(`workers[${index}].poll must be true or false.`);
    }
    return { name, command, ...(worker.poll === true ? { poll: true } : {}) };
  });

  const names = new Set<string>();
  for (const worker of workers) {
    if (names.has(worker.name)) {
      throw new InvalidError(`Runner worker names must be unique (duplicate "${worker.name}").`);
    }
    names.add(worker.name);
  }

  let maxConcurrent: number | undefined;
  if (raw.maxConcurrent !== undefined) {
    if (
      typeof raw.maxConcurrent !== "number" ||
      !Number.isInteger(raw.maxConcurrent) ||
      raw.maxConcurrent <= 0
    ) {
      throw new InvalidError("Runner maxConcurrent must be a positive whole number.");
    }
    maxConcurrent = raw.maxConcurrent;
  }

  return { workers, maxConcurrent };
}

export function loadRunnerConfig(room: Room, configPath?: string): RunnerConfig {
  const path = configPath === undefined
    ? join(room.paths.atrium, "runner.json")
    : isAbsolute(configPath)
      ? configPath
      : resolve(configPath);

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InvalidError(
        `No runner config at ${path}. Create it or pass --worker "name=command".`,
      );
    }
    throw err;
  }

  try {
    return parseRunnerConfig(JSON.parse(source));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new InvalidError(`Runner config at ${path} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

/**
 * One worker definition is one slot in a dispatch pass. This intentionally
 * does not pretend to understand agent capability: tasks do not carry required
 * capability tags yet, so deterministic board order is more honest.
 */
export function planRunnerAssignments(
  tasks: Task[],
  config: RunnerConfig,
): RunnerAssignment[] {
  // Polling workers are not assigned anything: they find their own work.
  const dispatchable = config.workers.filter((worker) => worker.poll !== true);
  const limit = Math.min(
    tasks.length,
    dispatchable.length,
    config.maxConcurrent ?? dispatchable.length,
  );
  const assignments: RunnerAssignment[] = [];
  for (let index = 0; index < limit; index += 1) {
    assignments.push({
      worker: dispatchable[index]!,
      task: tasks[index]!,
    });
  }
  return assignments;
}

/**
 * What a polling worker is told, which is deliberately almost nothing.
 *
 * This is where §7.4's rule gets teeth rather than good intentions, and the
 * answer is the opposite shape to what §12.9 feared. The worry was that a
 * long-lived worker could hold private state between tasks and quietly become
 * a second source of truth. But look at what the per-task path already does:
 * `planRunnerAssignments` decides *which worker gets which task*. That is a
 * scheduling decision held by the runner, and it is the closest this design
 * has ever come to a private plan.
 *
 * A polling worker deletes it. No task is passed, because the runner has not
 * picked one; the worker claims from the board itself, and Atrium's atomic
 * claim settles the race between workers. There is nothing here for a worker
 * to remember that the room does not already know, and the runner stops
 * deciding who does what.
 *
 * Long-lived workers therefore make the runner *less* of an orchestrator, not
 * more. What a worker does inside its own process stays its own business —
 * Atrium cannot police that and should not pretend to — but that is true of
 * any long-running MCP client, and it is not something the runner handed it.
 */
export function pollingWorkerEnvironment(
  worker: RunnerWorker,
  roomDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATRIUM_ROOM: roomDir,
    ATRIUM_WORKER_NAME: worker.name,
    // Present so a worker supporting both modes can tell which it is in
    // without inferring it from the absence of ATRIUM_TASK_ID.
    ATRIUM_POLL: "1",
  };
}

export interface PollingHandle {
  /** The workers that were started. */
  readonly started: RunnerWorker[];
  /** Resolves with each worker's exit code once they have all stopped. */
  readonly done: Promise<number[]>;
}

export type PollingLauncher = (worker: RunnerWorker, roomDir: string) => Promise<number>;

export const launchPollingWorker: PollingLauncher = (worker, roomDir) =>
  new Promise<number>((resolvePoll, reject) => {
    const child = spawn(worker.command, {
      cwd: roomDir,
      env: pollingWorkerEnvironment(worker, roomDir),
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePoll(code ?? 1));
  });

/**
 * Starts every polling worker once and hands back a handle.
 *
 * Deliberately does not supervise them. Restarting a worker that exited would
 * be the runner deciding the job is not finished yet, which is a conclusion
 * about the board — and the board is not the runner's to draw conclusions
 * from. A worker that stops has stopped; whether that matters is for a person
 * or a supervisor above the runner to decide.
 */
export function startPollingWorkers(
  room: Room,
  config: RunnerConfig,
  options: {
    launcher?: PollingLauncher;
    hooks?: { onStart?(worker: RunnerWorker): void };
  } = {},
): PollingHandle {
  room.assertUsable();
  const started = config.workers.filter((worker) => worker.poll === true);
  const launcher = options.launcher ?? launchPollingWorker;

  const done = Promise.all(
    started.map((worker) => {
      options.hooks?.onStart?.(worker);
      return launcher(worker, room.dir);
    }),
  );

  return { started, done };
}

/** Environment contract shared by every worker adapter. */
export function workerEnvironment(
  assignment: RunnerAssignment,
  roomDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATRIUM_ROOM: roomDir,
    ATRIUM_TASK_ID: assignment.task.id,
    ATRIUM_TASK_TITLE: assignment.task.title,
    ATRIUM_TASK_DESCRIPTION: assignment.task.description,
    ...(assignment.task.expectedOutput !== undefined
      ? {
          ATRIUM_EXPECTED_OUTPUT: assignment.task.expectedOutput.description,
          ...(assignment.task.expectedOutput.schema !== undefined
            ? {
                ATRIUM_EXPECTED_OUTPUT_SCHEMA: JSON.stringify(
                  assignment.task.expectedOutput.schema,
                ),
              }
            : {}),
        }
      : {}),
    ATRIUM_WORKER_NAME: assignment.worker.name,
  };
}

export const launchWorker: WorkerLauncher = (assignment, roomDir) =>
  new Promise<number>((resolveLaunch, reject) => {
    const child = spawn(assignment.worker.command, {
      cwd: roomDir,
      env: workerEnvironment(assignment, roomDir),
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => resolveLaunch(code ?? 1));
  });

/**
 * Run one bounded dispatch pass. Long-lived scheduling can be added later by
 * repeatedly calling this against fresh board state; the first version stays
 * deliberately finite and easy to reason about.
 */
export async function runRoomOnce(
  room: Room,
  config: RunnerConfig,
  options: {
    dryRun?: boolean;
    hooks?: RunnerHooks;
    launcher?: WorkerLauncher;
  } = {},
): Promise<RunnerSummary> {
  room.assertUsable();
  const tasks = listTasks(room, { claimable: true });
  const assignments = planRunnerAssignments(tasks, config);
  if (options.dryRun) return { assignments, results: [] };

  const launcher = options.launcher ?? launchWorker;
  const results = await Promise.all(
    assignments.map(async (assignment): Promise<RunnerResult> => {
      options.hooks?.onStart?.(assignment);
      const exitCode = await launcher(assignment, room.dir);
      const result = { ...assignment, exitCode };
      options.hooks?.onExit?.(result);
      return result;
    }),
  );
  return { assignments, results };
}
