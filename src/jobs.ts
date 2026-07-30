/**
 * Declaring a whole job in one file.
 *
 * ARCHITECTURE.md §12.1: a room's board is otherwise built one
 * `atrium task add` at a time, which means the only way to hand somebody a
 * working room is a shell script of CLI calls. A job file declares the brief,
 * the tasks, the dependency graph, and the acceptance rules together, and
 * `atrium init --from job.yaml` turns it into a room in one command.
 *
 * This is a *seeding* format, not a runtime one. Nothing reads it again after
 * the room exists: once the tasks are on the board the log is the truth, the
 * same as it is for a board built by hand, and editing the file afterwards
 * changes nothing. That is deliberate — a file that stayed authoritative
 * would be a second source of truth sitting next to the log, which §3.5 rules
 * out.
 *
 * Two things this file is careful about, both for the same reason: a job file
 * is written by a person, and a person's mistakes should be caught here
 * rather than surfacing as a board that quietly does not match what they
 * wrote.
 *
 *   - Unknown keys are refused, not ignored. `titel:` is a typo, and a parser
 *     that skips it produces a task with the wrong title and no complaint.
 *   - Dependencies are resolved and cycle-checked *before* anything is
 *     created, so a bad graph leaves no half-built room behind.
 */

import { writeFileSync } from "node:fs";

import { createTask } from "./board.js";
import { recordBrief } from "./context.js";
import { InvalidError } from "./errors.js";
import type { Room } from "./room.js";
import type { Acceptance, AcceptanceKind, MemberId, TaskId } from "./types.js";
import { parseYaml, type YamlValue } from "./yaml.js";

/** One task as written in the file, before it has an id. */
export interface JobTask {
  /** The name it was declared under, used by `dependsOn` and in errors. */
  key: string;
  title: string;
  description?: string;
  /** Other job keys, not task ids — the file is written before ids exist. */
  dependsOn: string[];
  acceptance?: Acceptance;
}

export interface Job {
  /** Room name. Falls back to the directory name when absent. */
  name?: string;
  /** Written to CONTEXT.md as the room's brief. */
  context?: string;
  /** In the order they were declared, which is the order they get created. */
  tasks: JobTask[];
}

export interface AppliedJob {
  /** Job key to the id the task was actually created under. */
  taskIds: Map<string, TaskId>;
  /** Whether the job supplied a brief and it was written to CONTEXT.md. */
  wroteContext: boolean;
}

const TOP_LEVEL_KEYS = new Set(["name", "context", "tasks"]);
const TASK_KEYS = new Set(["title", "description", "dependsOn", "acceptance"]);
const ACCEPTANCE_KINDS: ReadonlySet<string> = new Set([
  "command",
  "reviewer",
  "human",
  "none",
]);

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Reads a job file into a `Job`, or throws an `InvalidError` naming what is
 * wrong with it. Nothing here touches a room; this is pure validation, so a
 * bad file can be rejected before a room is created for it.
 */
export function parseJob(text: string, source = "the job file"): Job {
  const doc = parseYaml(text, { source });

  if (doc === null) {
    throw new InvalidError(`${source} is empty. A job file needs at least a "tasks" section.`);
  }
  if (!isRecord(doc)) {
    throw new InvalidError(
      `${source} must be a mapping with a "tasks" section at the top level, not ` +
        `${describeKind(doc)}.`,
    );
  }

  rejectUnknownKeys(doc, TOP_LEVEL_KEYS, source, "the top level of the job file");

  const name = optionalString(doc["name"], "name", source);
  const context = optionalString(doc["context"], "context", source);

  const rawTasks = doc["tasks"];
  if (rawTasks === undefined || rawTasks === null) {
    throw new InvalidError(
      `${source} has no "tasks" section, so there would be nothing on the board.`,
    );
  }
  if (Array.isArray(rawTasks)) {
    throw new InvalidError(
      `${source}: "tasks" must be a mapping of name to task, not a list. Each task needs ` +
        "a name so other tasks can list it in dependsOn — write \"research:\" above the " +
        "task rather than \"- \" in front of it.",
    );
  }
  if (!isRecord(rawTasks)) {
    throw new InvalidError(
      `${source}: "tasks" must be a mapping of name to task, not ${describeKind(rawTasks)}.`,
    );
  }

  const entries = Object.entries(rawTasks);
  if (entries.length === 0) {
    throw new InvalidError(
      `${source} declares no tasks, so there would be nothing on the board.`,
    );
  }

  const tasks = entries.map(([key, value]) => parseTask(key, value, source));
  checkDependencies(tasks, source);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(context !== undefined ? { context } : {}),
    tasks,
  };
}

function parseTask(key: string, value: YamlValue, source: string): JobTask {
  const where = `${source}: task "${key}"`;

  // Object key order is insertion order for ordinary string keys, but integer-
  // like keys are enumerated first regardless of where they were written. A
  // task named "1" would therefore jump the queue on creation, so refuse the
  // name rather than silently reordering somebody's board.
  if (/^(?:0|[1-9]\d*)$/.test(key)) {
    throw new InvalidError(
      `${where}: a task name cannot be a plain number, because that changes the order ` +
        'tasks are created in. Give it a word, or quote it as "step1".',
    );
  }

  if (!isRecord(value)) {
    throw new InvalidError(
      `${where} must be a mapping with at least a title, not ${describeKind(value)}.`,
    );
  }
  rejectUnknownKeys(value, TASK_KEYS, source, `task "${key}"`);

  const title = optionalString(value["title"], `task "${key}" title`, source);
  if (title === undefined || title.trim() === "") {
    throw new InvalidError(`${where} needs a non-empty "title".`);
  }

  const description = optionalString(value["description"], `task "${key}" description`, source);
  const dependsOn = parseDependsOn(value["dependsOn"], where);
  const acceptance = parseAcceptance(value["acceptance"], where);

  return {
    key,
    title: title.trim(),
    ...(description !== undefined ? { description } : {}),
    dependsOn,
    ...(acceptance !== undefined ? { acceptance } : {}),
  };
}

function parseDependsOn(value: YamlValue | undefined, where: string): string[] {
  if (value === undefined || value === null) return [];

  // A single dependency is far more common than several, and writing it
  // without the brackets is the obvious thing to try.
  const list = Array.isArray(value) ? value : [value];

  return list.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvalidError(
        `${where}: every dependsOn entry must be the name of another task in this file, ` +
          `got ${describeKind(entry)}.`,
      );
    }
    return entry.trim();
  });
}

/**
 * Either the shorthand (`acceptance: reviewer`) or the full form
 * (`acceptance: { kind: command, command: "npm test" }`). The full form uses
 * `kind` because that is the field name everywhere else this shape appears —
 * MCP's `create_task`, `Task.acceptance`, the CLI's `--acceptance`.
 */
function parseAcceptance(value: YamlValue | undefined, where: string): Acceptance | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const kind = expectKind(value, where);
    if (kind === "command") {
      throw new InvalidError(
        `${where}: "acceptance: command" needs the command to run. Write it as ` +
          '{ kind: command, command: "npm test" }.',
      );
    }
    return { kind };
  }

  if (!isRecord(value)) {
    throw new InvalidError(
      `${where}: acceptance must be a kind, or a mapping with a "kind", not ` +
        `${describeKind(value)}.`,
    );
  }

  const rawKind = value["kind"];
  if (typeof rawKind !== "string") {
    throw new InvalidError(
      `${where}: acceptance needs a "kind" of ${listKinds()}.` +
        (value["type"] !== undefined ? ' This file says "type"; the field is "kind".' : ""),
    );
  }
  const kind = expectKind(rawKind, where);

  const allowed = kind === "command" ? ["kind", "command", "timeoutSeconds"] : ["kind"];
  rejectUnknownKeys(value, new Set(allowed), where, `a "${kind}" acceptance`);

  if (kind !== "command") return { kind };

  const command = value["command"];
  if (typeof command !== "string" || command.trim() === "") {
    throw new InvalidError(
      `${where}: a "command" acceptance needs a non-empty "command" to run.`,
    );
  }

  const timeout = value["timeoutSeconds"];
  if (timeout === undefined || timeout === null) {
    return { kind, command: command.trim() };
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new InvalidError(
      `${where}: timeoutSeconds must be a finite number of seconds greater than 0 ` +
        `(got ${JSON.stringify(timeout)}). Leave it out to use the room's setting.`,
    );
  }
  return { kind, command: command.trim(), timeoutSeconds: timeout };
}

function expectKind(raw: string, where: string): AcceptanceKind {
  const kind = raw.trim();
  if (!ACCEPTANCE_KINDS.has(kind)) {
    throw new InvalidError(
      `${where}: acceptance kind must be one of ${listKinds()} (got ${JSON.stringify(raw)}).`,
    );
  }
  return kind as AcceptanceKind;
}

function listKinds(): string {
  return [...ACCEPTANCE_KINDS].map((k) => `"${k}"`).join(", ");
}

/**
 * Every dependency names a task in this file, and the graph has no cycle.
 * Both are checked before anything is created: a cycle found halfway through
 * creating tasks would leave a room holding half a job.
 */
function checkDependencies(tasks: JobTask[], source: string): void {
  const byKey = new Map(tasks.map((task) => [task.key, task]));

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) {
        throw new InvalidError(`${source}: task "${task.key}" depends on itself.`);
      }
      if (!byKey.has(dep)) {
        throw new InvalidError(
          `${source}: task "${task.key}" depends on "${dep}", which is not a task in this ` +
            `file. Known tasks: ${tasks.map((t) => `"${t.key}"`).join(", ")}.`,
        );
      }
    }
  }

  const cycle = findCycle(tasks, byKey);
  if (cycle !== undefined) {
    throw new InvalidError(
      `${source}: these tasks depend on each other in a loop, so none of them could ever ` +
        `start — ${cycle.map((k) => `"${k}"`).join(" → ")}.`,
    );
  }
}

/** The first cycle reachable from any task, as the path around it. */
function findCycle(tasks: JobTask[], byKey: Map<string, JobTask>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const walk = (key: string): string[] | undefined => {
    const seen = state.get(key);
    if (seen === "done") return undefined;
    if (seen === "visiting") {
      // Trim the stack back to where this key was first entered, so the
      // reported path is the loop itself and not the walk that reached it.
      return [...stack.slice(stack.indexOf(key)), key];
    }

    state.set(key, "visiting");
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const found = walk(dep);
      if (found !== undefined) return found;
    }
    stack.pop();
    state.set(key, "done");
    return undefined;
  };

  for (const task of tasks) {
    const found = walk(task.key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

/**
 * Creates every task in the job, resolving job keys to the ids they are
 * created under, and writes the brief to CONTEXT.md if the job carries one.
 *
 * Tasks are created dependency-first, because `createTask` validates that
 * every id in `dependsOn` is already on the board. Among tasks that are ready
 * at the same moment, file order is kept — the board should read the way the
 * file does.
 */
export function applyJob(room: Room, actorId: MemberId, job: Job): AppliedJob {
  const taskIds = new Map<string, TaskId>();

  for (const task of creationOrder(job.tasks)) {
    const created = createTask(room, actorId, {
      title: task.title,
      ...(task.description !== undefined ? { description: task.description } : {}),
      dependsOn: task.dependsOn.map((key) => {
        const id = taskIds.get(key);
        // creationOrder guarantees this, so reaching it means the ordering
        // itself is broken rather than the file.
        if (id === undefined) {
          throw new InvalidError(
            `Internal: task "${task.key}" was created before its dependency "${key}".`,
          );
        }
        return id;
      }),
      ...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
    });
    taskIds.set(task.key, created.id);
  }

  let wroteContext = false;
  if (job.context !== undefined && job.context.trim() !== "") {
    writeFileSync(room.paths.context, ensureTrailingNewline(job.context), "utf8");
    // Recorded rather than left on disk alone: this brief is what every task
    // above was created to serve, and a log that held the tasks and not the
    // brief would be missing the reason for all of them.
    recordBrief(room, actorId);
    wroteContext = true;
  }

  return { taskIds, wroteContext };
}

/**
 * Dependency-first, file order among equals. `checkDependencies` has already
 * ruled out cycles and unknown names by the time this runs, so it can assume
 * the graph is sound.
 */
function creationOrder(tasks: JobTask[]): JobTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const placed = new Set<string>();
  const ordered: JobTask[] = [];

  const place = (task: JobTask): void => {
    if (placed.has(task.key)) return;
    placed.add(task.key);
    for (const dep of task.dependsOn) {
      const dependency = byKey.get(dep);
      if (dependency !== undefined) place(dependency);
    }
    ordered.push(task);
  };

  for (const task of tasks) place(task);
  return ordered;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  value: YamlValue | undefined,
  field: string,
  source: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidError(`${source}: "${field}" must be text, not ${describeKind(value)}.`);
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, YamlValue>,
  allowed: ReadonlySet<string>,
  source: string,
  where: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;

  const known = [...allowed].map((k) => `"${k}"`).join(", ");
  const suggestion = suggest(unknown[0]!, allowed);
  throw new InvalidError(
    `${source}: ${where} does not understand ${unknown.map((k) => `"${k}"`).join(", ")}` +
      (suggestion !== undefined ? ` — did you mean "${suggestion}"?` : ".") +
      ` Known keys are ${known}.`,
  );
}

/** The closest known key within one small edit, for the typo case only. */
function suggest(word: string, allowed: ReadonlySet<string>): string | undefined {
  const lower = word.toLowerCase();
  for (const candidate of allowed) {
    if (candidate.toLowerCase() === lower) return candidate;
    if (editDistanceWithin(lower, candidate.toLowerCase(), 2)) return candidate;
  }
  return undefined;
}

/** Levenshtein, but it stops caring once the distance exceeds `limit`. */
function editDistanceWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[b.length]! <= limit;
}

function describeKind(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "string") return "text";
  return `a ${typeof value}`;
}
