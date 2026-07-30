#!/usr/bin/env node
/**
 * The command line, per ARCHITECTURE.md section 7.2.
 *
 * Every command is a plain function from (argv, sink) to an exit code. That is
 * what makes this file testable without spawning a process: a test can call
 * `cmdBoard(["--json", dir], sink)` directly and read back whatever the sink
 * captured. `main()` at the bottom is the only place that touches
 * `process.stdout`, `process.stderr`, or `process.exit`, and it only runs when
 * this file is the thing actually being executed (see `isEntryPoint` below) so
 * importing the module for tests never launches a command.
 *
 * Errors are handled in exactly one place, `runCli`, rather than in each
 * command: an `AtriumError` means the room said no for a reason a human can
 * act on, so only its message is shown. Anything else is a bug in this file or
 * its dependencies, so the stack is shown instead of hiding it.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  isAtriumError,
  InvalidError,
  Room,
  applyConfigChange,
  applyJob,
  parseJob,
  costSummary,
  createTask,
  currentLease,
  describeHistory,
  diffArtifact,
  foldLeases,
  foldRoster,
  foldTasks,
  gcBlobs,
  getContext,
  getTask,
  listArtifacts,
  listDeletedArtifacts,
  listLeases,
  listPinned,
  listSettings,
  listTasks,
  listVersions,
  pinArtifact,
  pruneVersions,
  releaseLease,
  releaseTask,
  renewClaim,
  resolveArtifact,
  restartTask,
  reviewTask,
  runRoomOnce,
  parseRunnerConfig,
  searchArtifacts,
  sweepExpiredClaims,
  toArtifactPath,
  unpinArtifact,
  verifyRoom,
  loadRunnerConfig,
} from "./index.js";
import { serveHttp } from "./http.js";
import { serveWatch } from "./watch.js";
import { PACKAGE_VERSION } from "./util.js";
import { serveStdio } from "./mcp.js";
import type {
  Acceptance,
  EventType,
  HistoryOptions,
  Job,
  Member,
  MemberId,
  MemberRole,
  RunnerConfig,
  RunnerWorker,
  Task,
  TaskState,
  Verdict,
} from "./index.js";

export interface Sink {
  out(line: string): void;
  err(line: string): void;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

// Piped output has to stay clean: anything reading `atrium board --json` or
// piping `atrium log` into another tool should never have to strip escape
// codes back out. NO_COLOR is the documented opt-out on top of that.
function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const bold = (text: string): string => paint("1", text);
const dim = (text: string): string => paint("2", text);
const red = (text: string): string => paint("31", text);

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/**
 * Pads every column to the width of its widest cell. Deliberately never
 * applied to already-coloured text: an ANSI escape sequence has characters
 * that take no space on screen but do count towards `.length`, which would
 * throw the padding off exactly where colour is used.
 */
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd(),
  );
}

const STATE_ORDER: TaskState[] = [
  "open",
  "blocked",
  "claimed",
  "submitted",
  "rejected",
  "accepted",
];

function taskRow(task: Task): string[] {
  const extras: string[] = [];
  if (task.claimedBy) extras.push(`claimed by ${task.claimedBy}`);
  if (task.waitingOn && task.waitingOn.length > 0) {
    extras.push(`waiting on ${task.waitingOn.join(", ")}`);
  }
  if (task.attempts > 0) {
    extras.push(`${task.attempts} attempt${task.attempts === 1 ? "" : "s"}`);
  }
  if (task.escalated) extras.push("escalated");
  return [task.id, task.title, extras.join("; ")];
}

function renderBoard(tasks: Task[]): string[] {
  if (tasks.length === 0) return [dim("No tasks yet.")];

  const lines: string[] = [];
  for (const state of STATE_ORDER) {
    const group = tasks.filter((t) => t.state === state);
    if (group.length === 0) continue;
    lines.push(bold(`${state.toUpperCase()} (${group.length})`));
    for (const row of table(group.map(taskRow))) lines.push(`  ${row}`);
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Shared argument handling
// ---------------------------------------------------------------------------

/**
 * Resolves a room and gives a next step when there isn't one, rather than
 * surfacing `Room.open`'s own "is not a room" message with nothing to do
 * about it. This is the one place every reading and writing command routes
 * through, so the hint only has to be written once.
 */
function openRoom(dir: string): Room {
  const abs = resolve(dir);
  if (!Room.isRoom(abs)) {
    throw new InvalidError(
      `${abs} is not an Atrium room (no .atrium directory there). Run "atrium init ${abs}" to create one.`,
    );
  }
  return Room.open(abs);
}

/** Parses `--limit`, returning `undefined` on success-with-no-flag so callers
 * can pass it straight through to the option bag it belongs to. */
function parseLimit(
  sink: Sink,
  raw: string | undefined,
): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    sink.err(`--limit must be a whole number, zero or more (got "${raw}").`);
    return { ok: false };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const INIT_HELP = `Usage: atrium init [dir] [--from <job.yaml>]

Creates a room in dir (default: the current directory). Refuses to run
twice on the same directory — a room is created once, then joined.

With --from, the room is seeded from a job file: the brief becomes
CONTEXT.md, and every task in it goes on the board with its dependencies
and acceptance rules already set. The file is read once, here. After this
the log is the truth, so editing it later changes nothing.

Options:
  --from <file>   seed the room from a job file (YAML)
  --help, -h      show this help
`;

export function cmdInit(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      from: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(INIT_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();

  // The job file is read and fully validated before the room is created, so a
  // file with a typo in it leaves no half-built room behind for the next run
  // of `atrium init` to refuse.
  let job: Job | undefined;
  if (values.from !== undefined) {
    const path = resolve(values.from);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new InvalidError(
        code === "ENOENT"
          ? `No job file at ${path}.`
          : `Could not read the job file at ${path}: ${(err as Error).message}`,
      );
    }
    job = parseJob(text, path);
  }

  const room = Room.create(dir, job?.name !== undefined ? { name: job.name } : {});
  try {
    sink.out(`Created room "${room.config.name}" in ${room.dir}`);

    if (job === undefined) {
      sink.out(
        `Write ${room.paths.context} before anyone joins — it's the first thing every agent reads.`,
      );
      return 0;
    }

    const applied = applyJob(room, ensureCliHuman(room), job);
    for (const task of job.tasks) {
      const id = applied.taskIds.get(task.key)!;
      const dependsOn =
        task.dependsOn.length > 0 ? `  (after ${task.dependsOn.join(", ")})` : "";
      sink.out(`  ${id}  ${task.title}${dependsOn}`);
    }
    sink.out(
      `Seeded ${job.tasks.length} ${job.tasks.length === 1 ? "task" : "tasks"} from ${values.from}.`,
    );
    sink.out(
      applied.wroteContext
        ? `Wrote the brief to ${room.paths.context}.`
        : `That job carried no brief — write ${room.paths.context} before anyone joins.`,
    );
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

const OPEN_HELP = `Usage: atrium open [dir]

Shows what this room is: name, settings, members, and task counts by state.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdOpen(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(OPEN_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const roster = room.roster();
    const tasks = listTasks(room);
    const counts: Partial<Record<TaskState, number>> = {};
    for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;

    if (values.json) {
      sink.out(
        JSON.stringify(
          {
            id: room.config.id,
            name: room.config.name,
            dir: room.dir,
            createdAt: room.config.createdAt,
            halted: room.isHalted(),
            config: room.config,
            members: roster,
            taskCounts: counts,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    sink.out(bold(room.config.name));
    sink.out(`  ${room.dir}`);
    sink.out(`  created ${room.config.createdAt}`);
    if (room.isHalted()) sink.out(red("  HALTED — out of action budget"));
    sink.out("");

    sink.out(bold("Settings"));
    sink.out(
      `  lease ${room.config.leaseSeconds}s   claim ${room.config.claimSeconds}s   ` +
        `command timeout ${room.config.commandTimeoutSeconds}s   ` +
        `max attempts ${room.config.maxAttempts}   action budget ${room.config.actionBudget}`,
    );
    sink.out(
      `  context ceiling ${room.config.contextTokenCeiling} tokens   ` +
        `unchecked acceptance ${room.config.allowUncheckedAcceptance ? "allowed" : "not allowed"}`,
    );
    sink.out("");

    sink.out(bold(`Members (${roster.length})`));
    for (const row of table(roster.map((m) => [m.name, m.role, m.active ? "active" : "left"]))) {
      sink.out(`  ${row}`);
    }
    sink.out("");

    sink.out(bold(`Tasks (${tasks.length})`));
    for (const state of STATE_ORDER) {
      sink.out(`  ${state}: ${counts[state] ?? 0}`);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

const BOARD_HELP = `Usage: atrium board [dir]

The task board, grouped by state.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdBoard(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(BOARD_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const tasks = listTasks(room);
    if (values.json) {
      sink.out(JSON.stringify(tasks, null, 2));
      return 0;
    }
    for (const line of renderBoard(tasks)) sink.out(line);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

const LOG_HELP = `Usage: atrium log [dir]

What has happened in the room, as readable lines, oldest first.

A room with a thousand events and nobody to summarize them needs a way to
ask a question of the log rather than read all of it — that's what the
filters below are for. Passing more than one intersects them rather than
widening the search: "--type task.rejected --actor scout" shows only
task.rejected events whose actor is scout, not everything either alone
would match. Matching nothing is a normal answer and is reported as one,
distinct from an empty room — the message names what was filtered on, so
you can tell a filter that found nothing from a filter that was wrong.

Options:
  --type <type,type,...>  only these event types, e.g. task.accepted,task.rejected.
                            An unknown type is refused and lists the valid
                            ones, rather than silently matching nothing.
  --actor <who>            only this actor's events — a member's name as it
                            appears in the log, their member id, or "system".
                            Exact match, not a substring.
  --contains <text>        only lines whose rendered text contains this,
                            case-insensitively. Plain substring match, never
                            a regular expression.
  --from <seq>             first sequence number to include
  --to <seq>               last sequence number to include (inclusive)
  --limit <n>              show at most n lines of the filtered result
  --json                   print machine-readable JSON instead
  --help, -h               show this help
`;

/** Names what a log query was filtered on, for the one case where that
 * matters most: nothing matched, and the person reading needs to see
 * whether that's because the room is quiet or because the filter was wrong. */
function describeLogFilters(options: HistoryOptions): string {
  const parts: string[] = [];
  if (options.types && options.types.length > 0) parts.push(`type in ${options.types.join(", ")}`);
  if (options.actor !== undefined) parts.push(`actor "${options.actor}"`);
  if (options.contains !== undefined) parts.push(`text containing "${options.contains}"`);
  if (options.from !== undefined) parts.push(`seq >= ${options.from}`);
  if (options.to !== undefined) parts.push(`seq <= ${options.to}`);
  return parts.join(" and ");
}

export function cmdLog(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      limit: { type: "string" },
      type: { type: "string" },
      actor: { type: "string" },
      contains: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(LOG_HELP);
    return 0;
  }

  const limit = parseLimit(sink, values.limit);
  if (!limit.ok) return 2;

  let fromSeq: number | undefined;
  if (values.from !== undefined) {
    fromSeq = Number(values.from);
    if (!Number.isInteger(fromSeq)) {
      sink.err(`--from must be a whole number (got "${values.from}").`);
      return 2;
    }
  }
  let toSeq: number | undefined;
  if (values.to !== undefined) {
    toSeq = Number(values.to);
    if (!Number.isInteger(toSeq)) {
      sink.err(`--to must be a whole number (got "${values.to}").`);
      return 2;
    }
  }
  if (values.actor !== undefined && !values.actor.trim()) {
    sink.err('--actor needs a value, e.g. "atrium log --actor scout".');
    return 2;
  }
  if (values.contains !== undefined && !values.contains.trim()) {
    sink.err('--contains needs text to search for, e.g. "atrium log --contains draft.md".');
    return 2;
  }
  const types = values.type
    ? values.type.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : undefined;

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const options: HistoryOptions = {
      ...(fromSeq !== undefined ? { from: fromSeq } : {}),
      ...(toSeq !== undefined ? { to: toSeq } : {}),
      ...(types && types.length > 0 ? { types: types as EventType[] } : {}),
      ...(values.actor !== undefined ? { actor: values.actor } : {}),
      ...(values.contains !== undefined ? { contains: values.contains } : {}),
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
    };
    // Validates --type against the real EventMap and throws an AtriumError
    // naming the valid ones if it's wrong; runCli is what turns that into a
    // message and an exit code (see cmdInit's tests for why that split
    // matters — this function itself just lets it propagate).
    const lines = describeHistory(room, options);

    if (values.json) {
      sink.out(JSON.stringify(lines, null, 2));
      return 0;
    }
    if (lines.length === 0) {
      const filters = describeLogFilters(options);
      sink.out(dim(filters ? `Nothing matched ${filters}.` : "Nothing has happened yet."));
      return 0;
    }
    for (const row of table(lines.map((l) => [`#${l.seq}`, l.ts, l.line]))) {
      sink.out(row);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

const INVITE_HELP = `Usage: atrium invite --name <name> [--role worker|reviewer|human] [dir]

Adds a member and prints their session token. The token is shown exactly
once here — it is not stored anywhere it can be read back out, so save it
before you close this terminal.

Options:
  --name <name>   the member's name (required)
  --role <role>   worker, reviewer, or human (default: worker)
  --help, -h      show this help
`;

export function cmdInvite(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      name: { type: "string" },
      role: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(INVITE_HELP);
    return 0;
  }
  if (!values.name || !values.name.trim()) {
    sink.err('An invite needs --name, e.g. "atrium invite --name scout --role worker".');
    return 2;
  }

  const dir = positionals[0] ?? process.cwd();
  const role = (values.role ?? "worker") as MemberRole;
  const room = openRoom(dir);
  try {
    const { member, token } = room.join({ name: values.name, role });
    sink.out(`${member.name} joined as ${member.role} (${member.id}).`);
    sink.out("");
    sink.out("Session token — shown once, cannot be recovered. Save it now:");
    sink.out(token);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

const REPLAY_HELP = `Usage: atrium replay <seq> [dir]

The task board, room roster, and artifact leases as they looked right after
event <seq>, not as they look now. Folds the log up to that point and judges
claim and lease expiry against the timestamp of that event, so state that was
live back then remains visible even if it has since lapsed for real.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdReplay(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(REPLAY_HELP);
    return 0;
  }

  const seqArg = positionals[0];
  if (seqArg === undefined) {
    sink.err('replay needs a sequence number, e.g. "atrium replay 12".');
    return 2;
  }
  const seq = Number(seqArg);
  if (!Number.isInteger(seq) || seq < 1) {
    sink.err(`"${seqArg}" is not a valid sequence number; it must be a whole number, 1 or more.`);
    return 2;
  }

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const event = room.log.at(seq);
    if (!event) {
      sink.err(`There is no event #${seq}; the log only goes up to #${room.log.head()}.`);
      return 1;
    }

    // Folding at the timestamp of the event itself, not now, is what makes this
    // a real replay: a claim or lease that was still live at #seq must still
    // read as live, even though wall-clock time has moved on since.
    const events = room.log.read({ to: seq });
    const tasks = [
      ...foldTasks(events, {
        maxAttempts: room.config.maxAttempts,
        at: event.ts,
      }).values(),
    ];
    const members = foldRoster(events);
    const names = new Map(members.map((m) => [m.id, m.name] as const));
    const leases = [...foldLeases(events, event.ts).values()].map((lease) => ({
      ...lease,
      holderName: names.get(lease.holder) ?? lease.holder,
    }));

    if (values.json) {
      sink.out(
        JSON.stringify({ seq, at: event.ts, tasks, members, leases }, null, 2),
      );
      return 0;
    }

    sink.out(bold(`Board as of #${seq} (${event.ts})`));
    sink.out("");
    for (const line of renderBoard(tasks)) sink.out(line);
    sink.out("");
    sink.out(bold("Room roster"));
    if (members.length === 0) {
      sink.out(dim("Nobody had joined at this point."));
    } else {
      for (const row of table(
        members.map((member) => [
          member.name,
          member.role,
          member.active ? "active" : "left",
        ]),
      )) {
        sink.out(row);
      }
    }
    sink.out("");
    sink.out(bold("Artifact leases"));
    if (leases.length === 0) {
      sink.out(dim("No paths were leased at this point."));
    } else {
      for (const row of table(
        leases.map((lease) => [
          lease.path,
          lease.holderName,
          `until ${lease.expiresAt}`,
        ]),
      )) {
        sink.out(row);
      }
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

const CONTEXT_HELP = `Usage: atrium context [dir]
       atrium context --pin <path> [dir]
       atrium context --unpin <path> [dir]

With no flags, shows the shared brief (CONTEXT.md plus pinned artifacts)
and its token total against the room's ceiling. --pin and --unpin curate
that brief instead, acting as the CLI's own local human member (see
"atrium task" for why that identity exists) — somebody running the room
by hand needs a way to add and remove pins, not just look at them.

A pin that would push the brief over contextTokenCeiling is refused, not
silently dropped or summarized: ARCHITECTURE.md §6 puts that decision in
front of a person, and the refusal names the ceiling, what the pin would
have cost, and what is already pinned that could be unpinned instead.

Options:
  --pin <path>    add an artifact to the shared brief
  --unpin <path>  remove an artifact from the shared brief
  --json          print machine-readable JSON instead (display mode only)
  --help, -h      show this help
`;

export function cmdContext(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      pin: { type: "string" },
      unpin: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(CONTEXT_HELP);
    return 0;
  }
  if (values.pin !== undefined && values.unpin !== undefined) {
    sink.err("Choose either --pin or --unpin, not both.");
    return 2;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    if (values.pin !== undefined) {
      if (!values.pin.trim()) {
        sink.err('--pin needs a path, e.g. "atrium context --pin notes.md".');
        return 2;
      }
      const actorId = ensureCliHuman(room);
      const relPath = toArtifactPath(room.dir, resolveArtifact(room.dir, values.pin));
      const already = listPinned(room).includes(relPath);
      pinArtifact(room, actorId, values.pin);
      sink.out(
        already
          ? `${relPath} is already pinned; nothing changed.`
          : `Pinned ${relPath}.`,
      );
      return 0;
    }

    if (values.unpin !== undefined) {
      if (!values.unpin.trim()) {
        sink.err('--unpin needs a path, e.g. "atrium context --unpin notes.md".');
        return 2;
      }
      const actorId = ensureCliHuman(room);
      const relPath = toArtifactPath(room.dir, resolveArtifact(room.dir, values.unpin));
      const wasPinned = listPinned(room).includes(relPath);
      unpinArtifact(room, actorId, values.unpin);
      sink.out(
        wasPinned
          ? `Unpinned ${relPath}.`
          : `${relPath} was not pinned; nothing changed.`,
      );
      return 0;
    }

    const context = getContext(room);
    if (values.json) {
      sink.out(JSON.stringify(context, null, 2));
      return 0;
    }

    sink.out(bold("Brief"));
    if (context.brief.trim() === "") {
      sink.out(dim("  (empty — nothing in CONTEXT.md yet)"));
    } else {
      for (const line of context.brief.split("\n")) sink.out(`  ${line}`);
    }
    sink.out("");

    const pct = context.ceiling > 0 ? Math.round((context.tokens / context.ceiling) * 100) : 0;
    const over = context.tokens > context.ceiling ? red(" — over the ceiling") : "";
    sink.out(`Tokens: ${context.tokens} / ${context.ceiling} (${pct}%)${over}`);
    sink.out("");

    sink.out(bold(`Pinned (${context.pinned.length})`));
    for (const pinned of context.pinned) sink.out(`  ${pinned.path}`);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const SEARCH_HELP = `Usage: atrium search <query> [dir]

Full-text search over the room's artifacts (ARCHITECTURE.md tier 2 context).

Options:
  --limit <n>  at most n hits (default: 20)
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdSearch(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(SEARCH_HELP);
    return 0;
  }

  const query = positionals[0];
  if (query === undefined || query.trim() === "") {
    sink.err('search needs a query, e.g. atrium search "draft".');
    return 2;
  }
  const limit = parseLimit(sink, values.limit);
  if (!limit.ok) return 2;

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const hits = searchArtifacts(room, query, limit.value === undefined ? {} : { limit: limit.value });

    if (values.json) {
      sink.out(JSON.stringify(hits, null, 2));
      return 0;
    }
    if (hits.length === 0) {
      sink.out(dim("No matches."));
      return 0;
    }
    for (const row of table(hits.map((h) => [h.score.toFixed(2), h.path, h.excerpt]))) {
      sink.out(row);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------
//
// `listArtifacts` has been exported from the package since artifacts.ts
// shipped, with no caller in this file or in mcp.ts: an agent could
// `search_artifacts` for a word it had to guess was in a file, or a human
// could `atrium history <path>` for a path they already knew the name of,
// but nothing could answer "what does this room have" for someone who
// doesn't already know what to look for. This command, and the MCP tool of
// the same name in mcp.ts, are that missing answer.

const ARTIFACTS_HELP = `Usage: atrium artifacts [dir] [--include-deleted]

Every artifact this room currently has: path, size, the log position it was
last written at, and who wrote it.

This is folded from the log, not read off disk (see the doc comment on
listArtifacts in artifacts.ts for why): it describes what the room knows it
produced, not whatever happens to be sitting in the working directory. A
file dropped in by hand, without going through write_artifact or the
write_artifact MCP tool, will never show up here even though "ls" would
show it — the room never recorded producing it.

A path that was written and later deleted is left out of the list above: it
has no current bytes to report a size for, and deletion moved it out of
"what this room currently has." Pass --include-deleted to see those too, as
their own separate "Deleted" list rather than folded into the live one —
telling a live artifact apart from a tombstone is the whole point of asking
for them together, so the two are never merged into one table. A deleted
path still has real history behind it: "atrium history <path>" and "atrium
diff <path>" both still work on it.

Options:
  --include-deleted  also list paths that were written and later deleted
  --json              print machine-readable JSON instead
  --help, -h          show this help
`;

export function cmdArtifacts(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      "include-deleted": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(ARTIFACTS_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const artifacts = listArtifacts(room);
    const includeDeleted = values["include-deleted"] === true;
    const deleted = includeDeleted ? listDeletedArtifacts(room) : undefined;

    // Resolved the same way "atrium leases" resolves a lease holder: an
    // author is a MemberId, which means nothing to a human reading this at a
    // terminal without separately looking up the roster.
    const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
    const authorName = (id: string): string => names.get(id) ?? id;

    if (values.json) {
      sink.out(
        JSON.stringify(
          {
            artifacts: artifacts.map((a) => ({
              ...a,
              lastWrittenByName: authorName(a.lastWrittenBy),
            })),
            ...(deleted
              ? {
                  deleted: deleted.map((d) => ({
                    ...d,
                    deletedByName: authorName(d.deletedBy),
                  })),
                }
              : {}),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (artifacts.length === 0 && (!deleted || deleted.length === 0)) {
      sink.out(
        dim(
          "No artifacts yet. Nothing has been written through write_artifact in this room " +
            "— completely normal for a room that is just getting started.",
        ),
      );
      return 0;
    }

    if (artifacts.length === 0) {
      sink.out(dim("No live artifacts — everything this room ever wrote has since been deleted. See Deleted below."));
    } else {
      sink.out(bold(`Artifacts (${artifacts.length})`));
      for (const row of table(
        artifacts.map((a) => [a.path, `${a.bytes} bytes`, `#${a.seq}`, authorName(a.lastWrittenBy)]),
      )) {
        sink.out(`  ${row}`);
      }
    }

    if (deleted && deleted.length > 0) {
      sink.out("");
      sink.out(bold(`Deleted (${deleted.length})`));
      for (const row of table(
        deleted.map((d) => [d.path, `#${d.seq}`, authorName(d.deletedBy), d.deletedAt]),
      )) {
        sink.out(`  ${row}`);
      }
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// note
// ---------------------------------------------------------------------------
//
// `post_note` has been an MCP tool since ARCHITECTURE.md §7.1 listed it: an
// agent in a room can leave a note in the log for the others — "the client
// changed the deadline," "ignore the third source, it is wrong" — for
// anything worth recording that is not a task and not an artifact. Until now
// a human running the same room by hand had no equivalent at all: there was
// no "atrium note" command, and nothing short of joining the room as an MCP
// client could add one. That asymmetry is backwards — the human is the one
// member of a room most likely to have something to say that is neither a
// task nor a file. This command is the missing half. It acts as the CLI's
// own "cli" human member for the same reason "atrium task" and "atrium
// context --pin" do (see "atrium task --help" for why that identity exists),
// and reuses `ensureCliHuman` rather than inventing a second identity
// mechanism.
//
// `atrium log` already renders `note.posted` events as readable sentences —
// `describeHistory` in context.ts has said "X noted: ..." (or "X noted on
// task Y: ...") since the event type was added — so this file adds no second
// listing for notes. Reading them back was already solved; only writing one
// from outside MCP was missing.

/**
 * How long a note is allowed to be.
 *
 * ARCHITECTURE.md §6 measures a room's action budget in events, not bytes, so
 * nothing before this stopped a note the length of a novel from landing in
 * the log, where `atrium log` and the `read_log` MCP tool re-render it every
 * time anyone catches up on the room. A cap is worth having: the whole point
 * of a note is a short, pointed thing a human wants on the record ("the
 * client changed the deadline"), not a place to paste a document. 4,000
 * characters is generous for that — several paragraphs — while still
 * refusing the pathological case. Genuinely long material belongs in an
 * artifact, pinned into the shared brief if it needs to be there, where it
 * can be versioned and diffed instead of sitting as one immovable log entry.
 */
const NOTE_MAX_LENGTH = 4000;

const NOTE_HELP = `Usage: atrium note <text> [dir] [--task <id>]

Leaves a note in the log for the other members to read: something worth
recording that is not a task and not an artifact — a decision, a correction,
a change in plan nobody else in the room would otherwise find out about.

"atrium log" already renders notes as readable lines, the same as everything
else that happens in the room, so there is no separate command to read them
back.

Options:
  --task <id>  attach this note to a task. Refused if the task does not
               exist, since a note pointing at a task id that was never
               created would be a dangling reference the log carries forever.
  --help, -h   show this help

An empty or whitespace-only note is refused: there is nothing to record.
Notes over ${NOTE_MAX_LENGTH} characters are refused too (see the source
comment on NOTE_MAX_LENGTH for the reasoning) — put long material in an
artifact instead, and note a pointer to it.
`;

export function cmdNote(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      task: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(NOTE_HELP);
    return 0;
  }

  const text = positionals[0];
  if (text === undefined || text.trim() === "") {
    sink.err('note needs text to record, e.g. atrium note "the client changed the deadline".');
    return 2;
  }
  if (text.length > NOTE_MAX_LENGTH) {
    sink.err(
      `A note can be at most ${NOTE_MAX_LENGTH} characters (got ${text.length}). ` +
        "Put long-form material in an artifact instead, and note just a pointer to it.",
    );
    return 2;
  }
  if (values.task !== undefined && values.task.trim() === "") {
    sink.err('--task needs a task id, e.g. --task task_abc123.');
    return 2;
  }

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);

    // Checked before the append, the same way createTask validates a
    // dependsOn id against the board before recording it: a note naming a
    // task id that does not exist is a dangling reference the log would
    // carry forever, so this is refused rather than recorded. getTask throws
    // NotFoundError for a bogus id, which runCli turns into a clear message.
    if (values.task !== undefined) getTask(room, values.task);

    room.assertUsable();
    const event = room.log.append(actorId, "note.posted", {
      memberId: actorId,
      text,
      ...(values.task !== undefined ? { taskId: values.task } : {}),
    });
    sink.out(values.task !== undefined ? `Noted on ${values.task} (#${event.seq}).` : `Noted (#${event.seq}).`);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------

const COST_HELP = `Usage: atrium cost [dir]

Per-member and room spend totals, folded from self-reported cost.reported
events, against the room's caps. A cap of 0 means the room has not set one.

This is advisory in the strict sense ARCHITECTURE.md §6 describes: Atrium
did not make any model call itself, so a member that never calls
report_cost is never charged, and there is no way to make it charged
retroactively. It only shows what was reported.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdCost(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(COST_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const summary = costSummary(room);
    if (values.json) {
      sink.out(JSON.stringify(summary, null, 2));
      return 0;
    }

    const roomCapText =
      summary.roomCapUsd > 0 ? ` / $${summary.roomCapUsd.toFixed(2)} cap` : " (no room cap set)";
    const roomOver = summary.roomCapUsd > 0 && summary.roomTotalUsd > summary.roomCapUsd;
    sink.out(
      `${bold("Room total")}: $${summary.roomTotalUsd.toFixed(2)}${roomCapText}${
        roomOver ? red(" — over cap") : ""
      }`,
    );
    if (room.isHalted()) sink.out(red("  HALTED"));
    sink.out("");

    sink.out(bold(`Per member (${summary.members.length})`));
    if (summary.members.length === 0) {
      sink.out(dim("  Nothing reported yet."));
      return 0;
    }
    for (const row of table(
      summary.members.map((m) => {
        const over = m.capUsd > 0 && m.totalUsd > m.capUsd;
        const capText = m.capUsd > 0 ? `$${m.capUsd.toFixed(2)} cap` : "no cap";
        return [m.name, `$${m.totalUsd.toFixed(2)}`, capText, over ? red("over cap") : ""];
      }),
    )) {
      sink.out(`  ${row}`);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
//
// Room.updateConfig has worked since the room shipped and had no caller:
// every setting that governs how this room behaves — action budget, lease
// and claim lengths, max attempts, spend caps, the context ceiling, whether
// unchecked acceptance is allowed at all — could only be changed by opening
// .atrium/room.json in an editor. Several of Atrium's own refusals even say
// to do exactly that (context.ts's "raise contextTokenCeiling in
// .atrium/room.json"), which is really an admission that a command was
// missing. This is that command. The coercion and rejection rules live in
// config.ts, not here — this is the thin CLI wrapper around it, the same
// division every other command in this file keeps with its own module.
//
// updateConfig writes straight to room.json without appending a log event —
// a setting is state the room holds, not something that happened in it — so
// unlike "atrium task" or "atrium context --pin", there is no identity for
// this command to act as, and no ensureCliHuman call here.

const CONFIG_HELP = `Usage: atrium config [dir]
       atrium config <key> <value> [dir]

With no key, lists every setting this room has: its current value, and
whether that value is the shipped default or was set explicitly. With a
key and a value, changes that one setting — the supported alternative to
hand-editing .atrium/room.json.

Values are coerced to the type the setting needs and rejected if they
cannot be, or if they parse fine but would be meaningless (a lease of 0
seconds, a negative action budget, zero max attempts). roomSpendCapUsd,
memberSpendCapUsd, and retainVersionsPerPath are the exception: they use a
documented "0 means no cap" convention, so 0 is accepted for those
specifically rather than rejected as a nonsense count.

Two changes print a warning on top of applying it, because "it worked"
is not reassuring enough on its own for either: turning on
allowUncheckedAcceptance (ARCHITECTURE.md §5 calls self-declared
completion the failure this project exists to prevent), and lowering
actionBudget to at or below the number of actions this room has already
recorded (the room will halt on its very next action). Both are things a
person is allowed to want on purpose, so neither is refused — only done
loudly instead of quietly.

Options:
  --json       print the listing as machine-readable JSON (list mode only)
  --help, -h   show this help
`;

export function cmdConfig(argv: string[], sink: Sink): number {
  // A negative number is a value, not a flag. `parseArgs` cannot know that:
  // it sees a leading "-" and refuses "-5" as an unknown option, so
  // "atrium config actionBudget -5" would fail with a parser error about
  // quoting rather than the validation message that actually explains what is
  // wrong with -5. No option in this program starts with a digit, so a token
  // matching a negative number is unambiguous, and marking it as positional
  // lets it reach the validation that has something useful to say about it.
  const args = argv.map((arg, i) => (i > 0 && /^-\d/.test(arg) ? ["--", arg] : [arg])).flat();

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(CONFIG_HELP);
    return 0;
  }

  // Arity, not a flag, tells list mode and set mode apart: "atrium config
  // [dir]" takes at most one positional, while set mode always supplies a
  // key and a value ahead of the optional trailing directory. "atrium diff"
  // and "atrium task add" already share a directory positional with a
  // command's own required arguments the same way.
  if (positionals.length >= 2) {
    if (positionals.length > 3) {
      sink.err('Too many arguments for "atrium config <key> <value> [dir]".');
      return 2;
    }
    const [key, value, dirArg] = positionals;
    const dir = dirArg ?? process.cwd();
    const room = openRoom(dir);
    try {
      let result;
      try {
        result = applyConfigChange(room, key!, value!);
      } catch (err) {
        // applyConfigChange throws for a library caller, which is right for
        // it. Here the bad value came off a command line, which makes it a
        // usage mistake rather than the room refusing something — the same
        // category as "--keep must be a whole number" elsewhere in this file,
        // and reported the same way rather than as a stack.
        if (!isAtriumError(err)) throw err;
        sink.err(err.message);
        return 2;
      }
      sink.out(`${result.key} is now ${String(result.value)} (was ${String(result.previous)}).`);
      for (const warning of result.warnings) sink.out(red(`Warning: ${warning}`));
      return 0;
    } finally {
      room.close();
    }
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const settings = listSettings(room.config);

    if (values.json) {
      sink.out(JSON.stringify(settings, null, 2));
      return 0;
    }

    sink.out(bold(`Settings for ${room.config.name}`));
    for (const row of table(
      settings.map((s) => [s.key, String(s.value), s.isDefault ? dim("(default)") : dim("(set)")]),
    )) {
      sink.out(`  ${row}`);
    }
    sink.out("");
    sink.out(dim('Change one with "atrium config <key> <value> [dir]".'));
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

const HISTORY_HELP = `Usage: atrium history <path> [dir]

Every version an artifact has had: log position, author, when, and size.
A path that was later deleted still shows its versions here — deletion does
not erase what came before it.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdHistory(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(HISTORY_HELP);
    return 0;
  }

  const path = positionals[0];
  if (path === undefined || path.trim() === "") {
    sink.err('history needs a path, e.g. "atrium history draft.md".');
    return 2;
  }

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const versions = listVersions(room, path);

    if (values.json) {
      sink.out(JSON.stringify(versions, null, 2));
      return 0;
    }
    if (versions.length === 0) {
      sink.out(dim(`No history for ${path}.`));
      return 0;
    }
    for (const row of table(
      versions.map((v) => [
        `#${v.seq}`,
        v.author,
        v.ts,
        v.kind === "deleted" ? "deleted" : `${v.bytes} bytes`,
      ]),
    )) {
      sink.out(row);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const DIFF_HELP = `Usage: atrium diff <path> [dir] [--from SEQ] [--to SEQ]

A unified diff between two versions of an artifact. Defaults to the last two
versions recorded for the path. Refuses to run a line diff on binary
content — it says so instead of printing garbage.

Options:
  --from <seq>  earlier log position (default: second-to-last version)
  --to <seq>    later log position (default: last version)
  --help, -h    show this help
`;

export function cmdDiff(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      from: { type: "string" },
      to: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(DIFF_HELP);
    return 0;
  }

  const path = positionals[0];
  if (path === undefined || path.trim() === "") {
    sink.err('diff needs a path, e.g. "atrium diff draft.md".');
    return 2;
  }

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    let fromSeq: number;
    let toSeq: number;

    if (values.from !== undefined || values.to !== undefined) {
      if (values.from === undefined || values.to === undefined) {
        sink.err("--from and --to must be given together, or not at all.");
        return 2;
      }
      fromSeq = Number(values.from);
      toSeq = Number(values.to);
      if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) {
        sink.err("--from and --to must be whole numbers.");
        return 2;
      }
    } else {
      const versions = listVersions(room, path);
      if (versions.length < 2) {
        sink.err(
          `${path} has ${versions.length === 0 ? "no" : "only one"} recorded version; there is nothing to diff. Pass --from and --to explicitly if you mean something else.`,
        );
        return 1;
      }
      const previous = versions[versions.length - 2];
      const latest = versions[versions.length - 1];
      // versions.length >= 2 was just checked above, so both are defined.
      fromSeq = previous!.seq;
      toSeq = latest!.seq;
    }

    const diff = diffArtifact(room, path, fromSeq, toSeq);

    if (diff.identical) {
      sink.out(dim(`No differences between #${fromSeq} and #${toSeq}.`));
      return 0;
    }
    sink.out(diff.patch.replace(/\n$/, ""));
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

const GC_HELP = `Usage: atrium gc [dir] [--dry-run]

Removes anything in the room's object store that no log entry points at:
content stored by a write that died before recording its event, and temporary
files left by a write that died before the rename.

This does not shrink history. Every version an artifact has ever had is
referenced by the log and is kept — that is what makes "atrium history" and
"atrium diff" work on versions that no longer exist on disk. A room that keeps
working keeps growing, and only discarding history would change that.

Options:
  --dry-run    report what would be removed, without removing it
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdGc(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(GC_HELP);
    return 0;
  }

  const dryRun = values["dry-run"] === true;
  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    const result = gcBlobs(room, { dryRun });

    if (values.json) {
      sink.out(JSON.stringify({ ...result, dryRun }, null, 2));
      return 0;
    }

    if (result.removed === 0) {
      sink.out(
        dim(
          result.kept === 0
            ? "Nothing to reclaim; this room has not stored any content yet."
            : `Nothing to reclaim; all ${result.kept} stored object${result.kept === 1 ? " is" : "s are"} still referenced.`,
        ),
      );
      return 0;
    }
    sink.out(
      `${dryRun ? "Would remove" : "Removed"} ${result.removed} unreferenced ` +
        `object${result.removed === 1 ? "" : "s"} (${result.bytesReclaimed} bytes).`,
    );
    sink.out(dim(`${result.kept} referenced object${result.kept === 1 ? "" : "s"} kept.`));
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

const PRUNE_HELP = `Usage: atrium prune [dir] [--keep N] [--dry-run]

Drops the content of all but the most recent N versions of each artifact,
where N is the room's retainVersionsPerPath (or --keep for this run).

This is the one thing in Atrium that discards history, and it only ever
happens because you ran it. What goes is bytes, not record: every version
stays in the log and keeps showing up in "atrium history", and reading one
whose content has gone says so rather than pretending the write never
happened. It cannot be undone.

Content is shared between versions holding identical bytes, so a version old
enough to drop keeps its content anyway if anything still being kept points at
the same bytes. Those are not reported as dropped, because they are still
readable.

Start with --dry-run.

Options:
  --keep <n>   versions per path to keep, overriding the room setting
  --dry-run    report what would go, and touch nothing
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdPrune(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      keep: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(PRUNE_HELP);
    return 0;
  }

  let retain: number | undefined;
  if (values.keep !== undefined) {
    retain = Number(values.keep);
    if (!Number.isInteger(retain) || retain < 1) {
      sink.err("--keep must be a whole number of versions, 1 or more.");
      return 2;
    }
  }

  const dryRun = values["dry-run"] === true;
  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    if (retain === undefined && room.config.retainVersionsPerPath < 1) {
      sink.err(
        'This room keeps every version (retainVersionsPerPath is 0), so there is no policy to apply. ' +
          'Pass --keep N to prune this once, or set retainVersionsPerPath in .atrium/room.json to make it the room\'s policy.',
      );
      return 2;
    }

    const result = pruneVersions(room, { retain, dryRun });

    if (values.json) {
      sink.out(JSON.stringify({ ...result, dryRun }, null, 2));
      return 0;
    }

    if (result.droppedVersions === 0) {
      sink.out(dim(`Nothing to prune; no path has more than ${result.retained} versions to spare.`));
      return 0;
    }

    for (const plan of result.plans) {
      sink.out(
        `${plan.path}  ${dryRun ? "would drop" : "dropped"} ${plan.seqs.length} version${plan.seqs.length === 1 ? "" : "s"} ` +
          `(${plan.seqs.map((s) => `#${s}`).join(", ")}), ${plan.bytesReclaimed} bytes`,
      );
    }
    sink.out(
      `${dryRun ? "Would reclaim" : "Reclaimed"} ${result.bytesReclaimed} bytes across ` +
        `${result.droppedVersions} version${result.droppedVersions === 1 ? "" : "s"}, keeping the most recent ${result.retained} of each path.`,
    );
    if (dryRun) sink.out(dim("Nothing was changed. Re-run without --dry-run to apply."));
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
//
// gc and prune can both remove bytes from a room; until now nothing could
// confirm afterwards that what is left still hangs together with what the
// log says should be there. The substance of this check lives in verify.ts —
// this is the thin presenter over it, the same division cmdConfig keeps with
// config.ts.

const VERIFY_HELP = `Usage: atrium verify [dir]

Checks that this room is internally consistent: every artifact.written
event's hash either has a blob on disk or was named in a recorded
artifact.pruned event; every stored blob's bytes still hash to the name
it is filed under; the log's sequence numbers start at 1 with no gaps;
room.json and tokens.json parse and hold the types they are supposed to.

A version whose content was legitimately dropped by "atrium prune" is not
damage and is not reported as any — that is the ordinary result of running
prune, not evidence of a problem. An unreferenced blob is reported
separately as reclaimable space (what "atrium gc" exists to free), not as
damage either.

Exit code is 0 for a healthy room, 1 for one with findings worth attention.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdVerify(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(VERIFY_HELP);
    return 0;
  }

  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    const report = verifyRoom(room);

    if (values.json) {
      sink.out(JSON.stringify(report, null, 2));
      return report.healthy ? 0 : 1;
    }

    if (report.findings.length === 0) {
      sink.out(`${room.config.name} is healthy: nothing to report.`);
      return 0;
    }

    const bySeverity = (severity: "critical" | "warning" | "info") =>
      report.findings.filter((f) => f.severity === severity);

    for (const severity of ["critical", "warning", "info"] as const) {
      const findings = bySeverity(severity);
      if (findings.length === 0) continue;
      sink.out(bold(`${severity.toUpperCase()} (${findings.length})`));
      for (const finding of findings) sink.out(`  ${finding.message}`);
      sink.out("");
    }

    sink.out(
      report.healthy
        ? dim(`${room.config.name} is healthy; the only findings above are informational.`)
        : red(
            `${room.config.name} has ${bySeverity("critical").length + bySeverity("warning").length} ` +
              `finding(s) worth attention.`,
          ),
    );
    return report.healthy ? 0 : 1;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// leases
// ---------------------------------------------------------------------------
//
// ARCHITECTURE.md §6 makes a lease the thing that stops two agents from
// scribbling over the same path, but until now nothing showed who was
// holding what — `listLeases` had no caller anywhere in the codebase. A room
// where you cannot see who holds a path is hard to debug when a write fails
// with "leased by someone else" and you want to know whether that is still
// true or just hasn't lapsed yet in the log.

/** Whole seconds remaining until `expiresAt`, never negative. `listLeases`
 * already drops anything whose time has passed, so this is cosmetic — it
 * just turns a timestamp into something a human doesn't have to subtract by
 * hand — but it is written defensively anyway rather than assuming the fold
 * upstream can never change. */
function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

function formatRemaining(expiresAt: string): string {
  const total = secondsLeft(expiresAt);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
}

const LEASES_HELP = `Usage: atrium leases [dir]

Every path currently under lease: who holds it, when it was acquired, when
it expires, and how long is left. This is folded through the same
foldLeases rule everything else in the room uses, so a lease whose expiry
has passed is never shown here as held — it is not live even though its
lease.acquired event is still sitting in the log, and reporting it as held
would just be wrong.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdLeases(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(LEASES_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const leases = listLeases(room);
    // Resolved the same way context.ts's describeHistory resolves actors: a
    // holder is a MemberId, and a MemberId means nothing to a human reading
    // this at a terminal without looking the roster up themselves.
    const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
    const holderName = (id: string): string => names.get(id) ?? id;

    if (values.json) {
      sink.out(
        JSON.stringify(
          leases.map((lease) => ({ ...lease, holderName: holderName(lease.holder) })),
          null,
          2,
        ),
      );
      return 0;
    }

    if (leases.length === 0) {
      sink.out(dim("No paths are currently leased."));
      return 0;
    }

    for (const row of table(
      leases.map((lease) => [
        lease.path,
        holderName(lease.holder),
        lease.acquiredAt,
        lease.expiresAt,
        formatRemaining(lease.expiresAt),
      ]),
    )) {
      sink.out(row);
    }
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// lease release — the escape hatch when expiry isn't fast enough
// ---------------------------------------------------------------------------
//
// ARCHITECTURE.md §6 makes a lease's expiry the thing that stops a crashed
// agent from deadlocking the room, but expiry is a safety net, not a tool: an
// operator watching an agent die at 14:02 should not have to wait out
// whatever's left of `leaseSeconds` before the room is usable again.
// `releaseLease` in leases.ts has always let a `human` member take somebody
// else's lease away; until now nothing on the command line could reach it —
// the only "release" command was `atrium task release`, which frees a task
// claim, a different thing from an artifact lease entirely.
//
// This gave "lease" two jobs: a listing (the existing `atrium leases`) and
// now an action. Two shapes were on the table:
//
//   - Leave leases alone: keep `atrium leases` for listing, and add a
//     differently-named top-level command for the action (say
//     `atrium release-lease <path>`), the way `atrium task release`
//     coexists with `atrium board` under unrelated names.
//   - Fold both under one `atrium lease` noun with `list` and `release`
//     subcommands, the same idiom `cmdTask` already established for tasks.
//
// The `task`/`board` split works there because "board" is already its own
// word for "the tasks, listed" — nothing needed disambiguating. Leases don't
// have that; "leases" and "lease release" are visibly the same noun already,
// so giving the action a name that doesn't share it would be the confusing
// choice, not the safe one. `atrium lease release <path> [dir]` mirrors
// `atrium task release <id> [dir]` exactly, and `atrium lease list` sits
// beside it so "lease" reads as one complete noun with subcommands. `atrium
// leases` stays exactly as it was — same function, same output, same tests —
// because it is already documented and possibly already scripted against,
// and there is no cost to a room answering to two spellings of the same read.

const LEASE_RELEASE_HELP = `Usage: atrium lease release <path> [dir]

Forces a live lease off a path, whoever holds it, so somebody else can write
it. The escape hatch for a lease left behind by an agent that crashed or is
stuck — an operator should not have to wait out the remaining lease just to
unblock the room (ARCHITECTURE.md §6: expiry is the safety net, not the
tool).

This is an administrative act — taking something away from another member —
so it acts as the CLI's own "cli" human member, the same identity "atrium
task" uses (see "atrium task --help" for why that identity exists), and is
recorded in the log under that identity so "atrium log" shows who forced the
release and when, distinctly from the member who lost the lease.

Refuses, rather than silently doing nothing, when there is nothing to
release: a path nobody has ever leased, or a lease that already lapsed on
its own before this ran. Both are said plainly, since neither is "release
succeeded."

Options:
  --help, -h   show this help
`;

export function cmdLeaseRelease(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(LEASE_RELEASE_HELP);
    return 0;
  }

  const path = positionals[0];
  if (path === undefined || path.trim() === "") {
    sink.err('lease release needs a path, e.g. "atrium lease release draft.md".');
    return 2;
  }
  const dir = positionals[1] ?? process.cwd();

  const room = openRoom(dir);
  try {
    // Read the holder before releasing — afterwards there is nothing left to
    // ask, and "released X's lease" is the whole point of this command's
    // output over the generic "released" a self-release would print.
    const before = currentLease(room, path);
    const relPath = toArtifactPath(room.dir, resolveArtifact(room.dir, path));
    const actorId = ensureCliHuman(room);
    releaseLease(room, actorId, path);

    const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
    const holderName = before ? (names.get(before.holder) ?? before.holder) : undefined;
    sink.out(
      holderName
        ? `Released ${holderName}'s lease on ${relPath}.`
        : `Released the lease on ${relPath}.`,
    );
    return 0;
  } finally {
    room.close();
  }
}

const LEASE_HELP = `Usage: atrium lease <subcommand> [options]

Subcommands:
  list [dir]              every path currently under lease (same as "atrium leases")
  release <path> [dir]    force a live lease off a path, whoever holds it

Run "atrium lease <subcommand> --help" for details on any one.
`;

export function cmdLease(argv: string[], sink: Sink): number {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "--help" || sub === "-h") {
    sink.out(LEASE_HELP);
    return 0;
  }

  switch (sub) {
    case "list":
      return cmdLeases(rest, sink);
    case "release":
      return cmdLeaseRelease(rest, sink);
    default:
      sink.err(`Unknown "atrium lease" subcommand "${sub}". Run "atrium lease --help" for the list.`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// task — the human's hands on the board
// ---------------------------------------------------------------------------
//
// ARCHITECTURE.md §3.2 gives `human` "everything a reviewer can do, plus
// running the room," but until now the CLI could only look at a room, never
// act on it. These five subcommands are that missing hand: putting a task on
// the board, giving a verdict, forcing a stuck claim back, and restarting a
// task that froze after too many rejections. `atrium context --pin/--unpin`,
// defined above alongside the rest of `cmdContext`, needs the same identity
// for the same reason and reuses `ensureCliHuman` rather than inventing a
// second one.
//
// Every one of them needs a member id to act as. Two designs were on the
// table:
//
//   - `--as <member>` naming any existing member by id, decided per call.
//   - A single, stable, auto-provisioned "human" member the CLI always is.
//
// `--as` is more flexible but more surprising: it lets the same command line
// accept work under one identity and reject it under another, which is
// exactly the self-declared-completion hole ARCHITECTURE.md §5 exists to
// close, and it means whoever runs the CLI has to already know a member id
// before "atrium task add" works at all. A stable local human member needs
// no setup, is always the same "person" across invocations of the CLI on
// this machine, and — because `reviewTask` already refuses a submitter its
// own verdict regardless of role — can never accept its own work by
// accident. `ensureCliHuman` below provisions that member once, the first
// time any of these subcommands touches a room, and finds it by name on
// every call after that so the roster does not grow a new "cli" member per
// invocation.

/** The name the CLI's own, auto-provisioned human member joins under. */
const CLI_HUMAN_NAME = "cli";

function ensureCliHuman(room: Room): MemberId {
  const existing = room.roster().find((m) => m.name === CLI_HUMAN_NAME && m.active);
  if (existing) {
    if (existing.role !== "human") {
      throw new InvalidError(
        `A member named "${CLI_HUMAN_NAME}" already exists in this room but is a ` +
          `${existing.role}, not a human, so the CLI cannot use it to administer tasks. ` +
          "Rename or remove that member first.",
        { memberId: existing.id, role: existing.role },
      );
    }
    return existing.id;
  }
  return room.join({
    name: CLI_HUMAN_NAME,
    role: "human",
    manifest:
      "Auto-provisioned local identity the atrium CLI uses for task administration " +
      "(add, review, release, unblock).",
  }).member.id;
}

function acceptanceLabel(acceptance: Task["acceptance"]): string {
  switch (acceptance.kind) {
    case "command":
      return (
        `command — "${acceptance.command}" must exit 0` +
        (acceptance.timeoutSeconds !== undefined
          ? ` (killed after ${acceptance.timeoutSeconds}s)`
          : "")
      );
    case "reviewer":
      return "reviewer — a different member must accept";
    case "human":
      return "human — a human must accept";
    case "none":
      return "none — auto-accepts on submit";
  }
}

/** Parses `--acceptance`, `--command`, and `--command-timeout` together,
 * since the latter two only make sense with `--acceptance command`. Returns
 * `undefined` (not an error) when none is given, so `createTask`'s own
 * default of `reviewer` applies. `createTask` still validates the timeout
 * itself — this is just where a bad number gets a CLI-shaped message instead
 * of one written for an MCP client. */
function parseAcceptanceFlag(
  sink: Sink,
  kind: string | undefined,
  command: string | undefined,
  commandTimeout: string | undefined,
): { ok: true; value: Acceptance | undefined } | { ok: false } {
  if (kind === undefined) {
    if (command !== undefined) {
      sink.err("--command only makes sense together with --acceptance command.");
      return { ok: false };
    }
    if (commandTimeout !== undefined) {
      sink.err("--command-timeout only makes sense together with --acceptance command.");
      return { ok: false };
    }
    return { ok: true, value: undefined };
  }
  if (kind !== "command" && kind !== "reviewer" && kind !== "human" && kind !== "none") {
    sink.err(`--acceptance must be one of command, reviewer, human, none (got "${kind}").`);
    return { ok: false };
  }
  if (kind === "command") {
    if (!command || !command.trim()) {
      sink.err('--acceptance command needs --command "the shell command to run".');
      return { ok: false };
    }
    let timeoutSeconds: number | undefined;
    if (commandTimeout !== undefined) {
      timeoutSeconds = Number(commandTimeout);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        sink.err(
          `--command-timeout must be a finite number of seconds greater than 0 (got "${commandTimeout}"). ` +
            `Omit it to use the room's commandTimeoutSeconds instead.`,
        );
        return { ok: false };
      }
    }
    return {
      ok: true,
      value: {
        kind: "command",
        command,
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      },
    };
  }
  if (command !== undefined) {
    sink.err("--command only makes sense together with --acceptance command.");
    return { ok: false };
  }
  if (commandTimeout !== undefined) {
    sink.err("--command-timeout only makes sense together with --acceptance command.");
    return { ok: false };
  }
  return { ok: true, value: { kind } };
}

const TASK_ADD_HELP = `Usage: atrium task add <room> --title <title> [options]

Creates a task and puts it on the board. Prints the new task's id.

Options:
  --title <title>            the task's title (required)
  --description <text>       longer description (default: empty)
  --depends-on <id,id,...>   task ids that must be accepted before this one
  --acceptance <kind>        command, reviewer, human, or none (default: reviewer)
  --command <shell command>  required when --acceptance is command
  --command-timeout <secs>  seconds before this task's command is killed and
                              reported as a rejection; only with --acceptance
                              command (default: the room's commandTimeoutSeconds)
  --help, -h                 show this help

A room with allowUncheckedAcceptance turned off (the default) refuses
--acceptance none: self-declared completion is the failure this project
exists to prevent (ARCHITECTURE.md §5).
`;

export function cmdTaskAdd(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      title: { type: "string" },
      description: { type: "string" },
      "depends-on": { type: "string" },
      acceptance: { type: "string" },
      command: { type: "string" },
      "command-timeout": { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_ADD_HELP);
    return 0;
  }

  const acceptance = parseAcceptanceFlag(
    sink,
    values.acceptance,
    values.command,
    values["command-timeout"],
  );
  if (!acceptance.ok) return 2;

  const dependsOn = (values["depends-on"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);
    const task = createTask(room, actorId, {
      title: values.title ?? "",
      description: values.description ?? "",
      dependsOn,
      acceptance: acceptance.value,
    });
    sink.out(`Created ${task.id} ("${task.title}").`);
    return 0;
  } finally {
    room.close();
  }
}

const TASK_SHOW_HELP = `Usage: atrium task show <id> <room>

Full detail on one task: state, acceptance, dependencies and which of them
are still unmet, claim info, attempts, the last rejection reason, and
whether it has been escalated.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdTaskShow(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_SHOW_HELP);
    return 0;
  }

  const taskId = positionals[0];
  if (taskId === undefined) {
    sink.err('task show needs a task id, e.g. "atrium task show task_abc123 ./room".');
    return 2;
  }

  const dir = positionals[1] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const task = getTask(room, taskId);
    const byId = new Map(listTasks(room).map((t) => [t.id, t] as const));
    const unmet = task.dependsOn.filter((id) => byId.get(id)?.state !== "accepted");

    // Leases live on artifact paths, not on tasks, but a lease still held on a
    // path this task's submission touched is exactly the kind of thing a
    // human deciding a stuck task would want to see.
    const leases = (task.submittedArtifacts ?? [])
      .map((path) => ({ path, lease: currentLease(room, path) }))
      .filter(
        (entry): entry is { path: string; lease: NonNullable<typeof entry.lease> } =>
          entry.lease !== undefined,
      );

    if (values.json) {
      sink.out(JSON.stringify({ ...task, unmetDependencies: unmet, activeLeases: leases }, null, 2));
      return 0;
    }

    sink.out(bold(`${task.id} — ${task.title}`));
    if (task.description) sink.out(`  ${task.description}`);
    sink.out("");
    sink.out(
      `  state: ${task.state}` +
        (task.escalated ? " (escalated — needs a human to restart it)" : ""),
    );
    sink.out(`  acceptance: ${acceptanceLabel(task.acceptance)}`);
    sink.out(
      `  depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "(none)"}` +
        (unmet.length > 0 ? ` — unmet: ${unmet.join(", ")}` : ""),
    );
    if (task.claimedBy) {
      sink.out(`  claimed by ${task.claimedBy}, expires ${task.claimExpiresAt}`);
    }
    if (task.submittedBy) {
      sink.out(
        `  submitted by ${task.submittedBy} at ${task.submittedAt}: ${task.submissionSummary}`,
      );
    }
    sink.out(`  attempts: ${task.attempts}`);
    if (task.lastRejection) {
      sink.out(
        `  last rejection: by ${task.lastRejection.by} at ${task.lastRejection.at}: ` +
          task.lastRejection.reason,
      );
    }
    for (const entry of leases) {
      sink.out(`  lease on ${entry.path}: held by ${entry.lease.holder} until ${entry.lease.expiresAt}`);
    }
    return 0;
  } finally {
    room.close();
  }
}

const TASK_REVIEW_HELP = `Usage: atrium task review <id> <room> --accept|--reject [options]

Records a human verdict on submitted work. Goes through the same
reviewTask path every verdict goes through, so the same rules apply — most
importantly, whoever submitted the work can never be the one who accepts or
rejects it (ARCHITECTURE.md §5).

Options:
  --accept          accept the submitted work
  --reject          reject it (needs --reason)
  --reason <text>   why it was rejected (required with --reject)
  --help, -h        show this help
`;

export function cmdTaskReview(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      accept: { type: "boolean" },
      reject: { type: "boolean" },
      reason: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_REVIEW_HELP);
    return 0;
  }

  if (values.accept && values.reject) {
    sink.err("Choose either --accept or --reject, not both.");
    return 2;
  }
  if (!values.accept && !values.reject) {
    sink.err("task review needs a verdict: --accept or --reject.");
    return 2;
  }
  if (values.reject && (!values.reason || !values.reason.trim())) {
    sink.err('--reject needs --reason, e.g. --reject --reason "tests still fail".');
    return 2;
  }

  const taskId = positionals[0];
  if (taskId === undefined) {
    sink.err('task review needs a task id, e.g. "atrium task review task_abc123 ./room --accept".');
    return 2;
  }
  const dir = positionals[1] ?? process.cwd();

  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);
    const verdict: Verdict = values.accept
      ? { accept: true }
      : { accept: false, reason: values.reason! };
    const task = reviewTask(room, actorId, taskId, verdict);
    sink.out(`${taskId} is now ${task.state}.`);
    return 0;
  } finally {
    room.close();
  }
}

const TASK_RELEASE_HELP = `Usage: atrium task release <id> <room>

Forces a claimed task back onto the board, regardless of who holds the
claim — for a worker that is stuck or gone and cannot be waited out until
its lease lapses on its own.

Options:
  --help, -h   show this help
`;

export function cmdTaskRelease(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_RELEASE_HELP);
    return 0;
  }

  const taskId = positionals[0];
  if (taskId === undefined) {
    sink.err('task release needs a task id, e.g. "atrium task release task_abc123 ./room".');
    return 2;
  }
  const dir = positionals[1] ?? process.cwd();

  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);
    const task = releaseTask(room, actorId, taskId);
    sink.out(`${taskId} released; back to ${task.state}.`);
    return 0;
  } finally {
    room.close();
  }
}

const TASK_RENEW_HELP = `Usage: atrium task renew <id> <room>

Extends a claim before it lapses, going through the same renewClaim path
"renew_claim" uses over MCP: only the member actually holding the claim can
renew it, with no human override the way "atrium task release" and "atrium
lease release" have one — see renewClaim's own doc comment in board.ts for
why that is the whole point of the function.

That makes this command narrower than it looks. Task claims are almost
always held by an MCP worker, not by the CLI's own auto-provisioned "cli"
human identity — there is no "atrium task claim" command, so "cli" only
ever holds a claim if something outside the CLI put it there. Run this as
whichever member id actually holds the claim, over MCP, if that is what you
mean; this command exists for symmetry with the rest of "atrium task" and
for the case where "cli" genuinely is the holder.

Refuses with a distinct message for each of: no claim on the task at all, a
claim held by somebody else, and a claim that already lapsed — in the last
case the task is already back on the board and this will not resurrect the
old claim; claim it again instead.

Options:
  --help, -h   show this help
`;

export function cmdTaskRenew(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_RENEW_HELP);
    return 0;
  }

  const taskId = positionals[0];
  if (taskId === undefined) {
    sink.err('task renew needs a task id, e.g. "atrium task renew task_abc123 ./room".');
    return 2;
  }
  const dir = positionals[1] ?? process.cwd();

  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);
    const task = renewClaim(room, actorId, taskId);
    sink.out(`${taskId} renewed; claim now expires ${task.claimExpiresAt}.`);
    return 0;
  } finally {
    room.close();
  }
}

const TASK_UNBLOCK_HELP = `Usage: atrium task unblock <id> <room>

Restarts a task that froze after too many rejections. ARCHITECTURE.md §6:
three rejections escalates a task and only a human can restart it. The
attempt count is left as it was, so the log still shows the task's history
rather than pretending it is fresh.

Options:
  --help, -h   show this help
`;

export function cmdTaskUnblock(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_UNBLOCK_HELP);
    return 0;
  }

  const taskId = positionals[0];
  if (taskId === undefined) {
    sink.err('task unblock needs a task id, e.g. "atrium task unblock task_abc123 ./room".');
    return 2;
  }
  const dir = positionals[1] ?? process.cwd();

  const room = openRoom(dir);
  try {
    const actorId = ensureCliHuman(room);
    const task = restartTask(room, actorId, taskId);
    sink.out(`${taskId} restarted; ${task.state} and claimable again.`);
    return 0;
  } finally {
    room.close();
  }
}

const TASK_SWEEP_HELP = `Usage: atrium task sweep [room]

Reclaims every task whose claim has already lapsed, appending a
task.released event (reason "lease-expired") for each one so the log
records the reclamation explicitly rather than leaving it implicit in
foldTasks's rule that a lapsed claim reads as open again (ARCHITECTURE.md
§6). This changes nothing about what is claimable right now — that rule
already applies with or without anyone running this — it only makes the
"why did this come back on the board" answer sit in the log instead of
having to be inferred from a claim's expiry no longer being live.

A room with nothing lapsed is a normal, successful result, not an error.
Running this twice in a row is harmless: the second run finds nothing left
to sweep, the same guarantee sweepExpiredClaims documents in board.ts.

Options:
  --json       print the reclaimed tasks as machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdTaskSweep(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_SWEEP_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const reclaimed = sweepExpiredClaims(room);

    if (values.json) {
      sink.out(JSON.stringify(reclaimed, null, 2));
      return 0;
    }
    if (reclaimed.length === 0) {
      sink.out(dim("Nothing to sweep; no claims have lapsed."));
      return 0;
    }
    sink.out(
      `Reclaimed ${reclaimed.length} lapsed claim${reclaimed.length === 1 ? "" : "s"}: ` +
        `${reclaimed.map((t) => t.id).join(", ")}.`,
    );
    return 0;
  } finally {
    room.close();
  }
}

const TASK_HELP = `Usage: atrium task <subcommand> [options]

Subcommands:
  add <room> --title T [options]        create a task and print its id
  show <id> <room> [--json]             full detail on one task
  review <id> <room> --accept|--reject  a human verdict on submitted work
  release <id> <room>                   force a claimed task back to the board
  renew <id> <room>                     extend a claim you hold before it lapses
  unblock <id> <room>                   restart a task frozen by escalation
  sweep [room]                          reclaim every lapsed claim, recorded in the log

Run "atrium task <subcommand> --help" for details on any one.
`;

export function cmdTask(argv: string[], sink: Sink): number {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "--help" || sub === "-h") {
    sink.out(TASK_HELP);
    return 0;
  }

  switch (sub) {
    case "add":
      return cmdTaskAdd(rest, sink);
    case "show":
      return cmdTaskShow(rest, sink);
    case "review":
      return cmdTaskReview(rest, sink);
    case "release":
      return cmdTaskRelease(rest, sink);
    case "renew":
      return cmdTaskRenew(rest, sink);
    case "unblock":
      return cmdTaskUnblock(rest, sink);
    case "sweep":
      return cmdTaskSweep(rest, sink);
    default:
      sink.err(`Unknown "atrium task" subcommand "${sub}". Run "atrium task --help" for the list.`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------
//
// ARCHITECTURE.md §3.2: agents self-describe capabilities on join via a short
// manifest (free text) plus tags. Nothing has ever shown that back — `atrium
// open` prints name/role/active and stops there, and there was no MCP tool at
// all. That is a real gap against §2's blackboard model, where specialists
// are supposed to observe each other's contributions, not be told about them
// by an orchestrator: knowing who else is in the room, and what they say they
// are good for, is part of that observing.

const ROSTER_HELP = `Usage: atrium roster [dir]

Every member who has ever joined this room: name, role, whether they are
still active, when they joined, their tags, and the manifest they gave on
join.

A manifest is self-reported free text, nothing more. ARCHITECTURE.md §3.2
deliberately has no capability schema behind it, so this is what a member
says about itself, not a verified claim about what it can actually do.

Options:
  --active     only members who have not left
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

/**
 * A manifest is prose, sometimes a full sentence or two, so it does not fit
 * as a table column: forced into `table()` it would either get truncated or
 * force every other column to the width of the longest one. Each member gets
 * its own block instead — identity on one line, tags and manifest indented
 * under it — so a one-word manifest and a two-sentence one both read cleanly.
 */
function renderRoster(roster: Member[]): string[] {
  const lines: string[] = [];
  roster.forEach((member, i) => {
    lines.push(`  ${bold(member.name)} — ${member.role} — ${member.active ? "active" : "left"}`);
    lines.push(`    joined ${member.joinedAt}`);
    lines.push(`    tags: ${member.tags.length > 0 ? member.tags.join(", ") : dim("(none)")}`);
    lines.push(
      member.manifest.trim() === ""
        ? `    ${dim("(no manifest given)")}`
        : `    "${member.manifest}"`,
    );
    if (i < roster.length - 1) lines.push("");
  });
  return lines;
}

export function cmdRoster(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      active: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(ROSTER_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const roster = room.roster().filter((m) => !values.active || m.active);

    if (values.json) {
      sink.out(JSON.stringify(roster, null, 2));
      return 0;
    }

    if (roster.length === 0) {
      sink.out(dim(values.active ? "No active members." : "Nobody has joined this room yet."));
      return 0;
    }

    sink.out(bold(`Roster (${roster.length})`));
    sink.out(
      dim("  Manifests are self-reported — what a member says it's good for, not a verified capability (ARCHITECTURE.md §3.2)."),
    );
    sink.out("");
    for (const line of renderRoster(roster)) sink.out(line);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// Dispatch and entry point
// ---------------------------------------------------------------------------

const GLOBAL_HELP = `atrium — a shared workspace for AI agents to do one job together

Usage: atrium <command> [options]

Commands:
  init [dir]            create a room in dir (default: current directory)
  open [dir]            show what this room is: name, settings, members, task counts
  board [dir]           the task board, grouped by state
  log [dir]             what has happened, as readable lines
  invite [dir]          add a member and print their session token
  replay <seq> [dir]    the board as it looked at that point in the log
  context [dir]         the shared brief and its token total; --pin/--unpin to curate it
  search <query> [dir]  full-text search over the room's artifacts
  artifacts [dir]       every artifact the room currently has: size, last write, author
  note <text> [dir]     leave a note in the log, optionally attached to a task
  cost [dir]            per-member and room spend totals against the caps
  config [dir]          list room settings; "atrium config <key> <value> [dir]" changes one
  history <path> [dir]  every version an artifact has had
  diff <path> [dir]     a unified diff between two versions of an artifact
  gc [dir]              remove stored content no log entry points at
  prune [dir]           drop the content of old artifact versions (destructive)
  verify [dir]          check the room is internally consistent
  leases [dir]          every path currently under lease: holder, acquired, expires, time left
  lease <subcommand>    list (same as "leases") or force-release an artifact lease
  serve [dir]           serve the room to an MCP client over stdin/stdout
  watch [dir]           a read-only web view of the room, live in a browser
  run [dir]             launch configured workers for one bounded dispatch pass
  task <subcommand>     create, inspect, and administer tasks — see "atrium task --help"
  roster [dir]          every member who has joined, with tags and self-reported manifest

Run "atrium <command> --help" for details on any command.

Global flags:
  --help, -h     show this help
  --version      print the installed version
`;

function dispatch(argv: string[], sink: Sink): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    sink.out(GLOBAL_HELP);
    return 0;
  }
  if (command === "--version") {
    sink.out(PACKAGE_VERSION);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit(rest, sink);
    case "open":
      return cmdOpen(rest, sink);
    case "board":
      return cmdBoard(rest, sink);
    case "log":
      return cmdLog(rest, sink);
    case "invite":
      return cmdInvite(rest, sink);
    case "replay":
      return cmdReplay(rest, sink);
    case "context":
      return cmdContext(rest, sink);
    case "search":
      return cmdSearch(rest, sink);
    case "artifacts":
      return cmdArtifacts(rest, sink);
    case "note":
      return cmdNote(rest, sink);
    case "cost":
      return cmdCost(rest, sink);
    case "config":
      return cmdConfig(rest, sink);
    case "history":
      return cmdHistory(rest, sink);
    case "diff":
      return cmdDiff(rest, sink);
    case "gc":
      return cmdGc(rest, sink);
    case "prune":
      return cmdPrune(rest, sink);
    case "verify":
      return cmdVerify(rest, sink);
    case "leases":
      return cmdLeases(rest, sink);
    case "lease":
      return cmdLease(rest, sink);
    case "task":
      return cmdTask(rest, sink);
    case "roster":
      return cmdRoster(rest, sink);
    default:
      sink.err(`Unknown command "${command}". Run "atrium --help" for the list of commands.`);
      return 2;
  }
}

/**
 * The single place errors are turned into exit codes. An `AtriumError` is the
 * room refusing something for a reason its message already explains, so only
 * the message is worth showing. `parseArgs` reports its own usage mistakes
 * (an unknown flag, say) the same way node itself would, as an error with an
 * `ERR_PARSE_ARGS_*` code, which is treated as a usage problem rather than a
 * bug in this program. Everything else is unexpected, so the stack is left in
 * for whoever has to debug it.
 */
export function runCli(argv: string[], sink: Sink): number {
  try {
    return dispatch(argv, sink);
  } catch (err) {
    if (isAtriumError(err)) {
      sink.err(err.message);
      return 1;
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      sink.err(err instanceof Error ? err.message : String(err));
      return 2;
    }
    sink.err(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}

const RUN_HELP = `atrium run — launch workers for one bounded dispatch pass

Usage: atrium run [dir] [options]

Reads the currently claimable tasks and pairs them with configured worker
slots. Each command receives its assignment in environment variables:

  ATRIUM_ROOM
  ATRIUM_TASK_ID
  ATRIUM_TASK_TITLE
  ATRIUM_TASK_DESCRIPTION
  ATRIUM_WORKER_NAME

The worker must still join and claim the task through Atrium. The runner never
keeps a private task board and never marks work complete.

By default configuration is read from <room>/.atrium/runner.json:

  {
    "workers": [
      { "name": "codex", "command": "node ./codex-worker.mjs" },
      { "name": "claude", "command": "node ./claude-worker.mjs" }
    ],
    "maxConcurrent": 2
  }

Options:
  --config <path>       read a different runner JSON file
  --worker <name=cmd>   define a worker slot inline; repeat for more slots
  --max-workers <n>     override maxConcurrent for this pass
  --dry-run             print assignments without launching commands
  --help, -h            show this help
`;

function inlineRunnerWorker(value: string): RunnerWorker {
  const equals = value.indexOf("=");
  const name = equals < 0 ? "" : value.slice(0, equals).trim();
  const command = equals < 0 ? "" : value.slice(equals + 1).trim();
  if (!name || !command) {
    throw new InvalidError(
      `--worker must be "name=command" (got ${JSON.stringify(value)}).`,
    );
  }
  return { name, command };
}

export async function cmdRun(argv: string[], sink: Sink): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      config: { type: "string" },
      worker: { type: "string", multiple: true },
      "max-workers": { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(RUN_HELP);
    return 0;
  }
  if (positionals.length > 1) {
    sink.err("run accepts one room directory.");
    return 2;
  }
  if (values.config !== undefined && values.worker !== undefined) {
    sink.err("Use either --config or --worker, not both.");
    return 2;
  }

  let maxConcurrent: number | undefined;
  if (values["max-workers"] !== undefined) {
    maxConcurrent = Number(values["max-workers"]);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      sink.err(
        `--max-workers must be a positive whole number (got "${values["max-workers"]}").`,
      );
      return 2;
    }
  }

  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    let config: RunnerConfig;
    if (values.worker !== undefined) {
      config = parseRunnerConfig({ workers: values.worker.map(inlineRunnerWorker) });
    } else {
      config = loadRunnerConfig(room, values.config);
    }
    if (maxConcurrent !== undefined) config = { ...config, maxConcurrent };

    const dryRun = values["dry-run"] ?? false;
    const summary = await runRoomOnce(room, config, {
      dryRun,
      hooks: {
        onStart: ({ worker, task }) => {
          sink.out(`Starting ${worker.name} on ${task.id} — ${task.title}`);
        },
        onExit: ({ worker, task, exitCode }) => {
          const status = exitCode === 0 ? "finished" : `failed (exit ${exitCode})`;
          sink.out(`${worker.name} ${status} on ${task.id} — ${task.title}`);
        },
      },
    });

    if (summary.assignments.length === 0) {
      sink.out("No claimable tasks.");
      return 0;
    }
    if (dryRun) {
      sink.out(`Dispatch plan (${summary.assignments.length})`);
      for (const { worker, task } of summary.assignments) {
        sink.out(`  ${worker.name} → ${task.id} — ${task.title}`);
      }
      sink.out(dim("Dry run only; no workers were launched."));
      return 0;
    }

    const failures = summary.results.filter((result) => result.exitCode !== 0);
    sink.out(
      failures.length === 0
        ? `Dispatch pass finished: ${summary.results.length} worker(s) exited cleanly.`
        : `Dispatch pass finished: ${failures.length} of ${summary.results.length} worker(s) failed.`,
    );
    return failures.length === 0 ? 0 : 1;
  } finally {
    room.close();
  }
}

const SERVE_HELP = `atrium serve — serve a room to an MCP client

Usage: atrium serve [dir] [options]

By default this speaks MCP over stdin/stdout. Point an MCP client at it with
a config entry along the lines of:

  { "command": "atrium", "args": ["serve", "/path/to/room"] }

The agent calls the "join" tool first, which hands back a session token
and the room's shared brief.

Pass --http for a client that cannot spawn a process — a browser, or
anything across a container boundary. That serves the same tools over
HTTP instead, as a single POST endpoint (default "/mcp") taking JSON-RPC
messages. Every request needs "Authorization: Bearer <token>": run
"atrium invite" first to mint one, since there is no anonymous "join"
over HTTP. The server binds to 127.0.0.1 only, by design; pass --host to
change that deliberately.

Options:
  --token <token>  rejoin as an existing member instead of joining afresh
                    (stdio only)
  --http           serve over HTTP instead of stdio
  --port <n>       HTTP port (default: an OS-assigned free port)
  --host <host>    HTTP bind address (default: 127.0.0.1)
  --help, -h       show this help

Nothing but protocol messages is written to stdout in stdio mode, so
that mode is not one to run by hand expecting output.
`;

/**
 * Kept apart from the other commands because it is a different shape: it runs
 * until the client closes the connection (stdio) or the process is signalled
 * to stop (HTTP), rather than printing something and returning an exit code.
 * In stdio mode its stdout belongs to the protocol.
 */
export async function cmdServe(argv: string[], sink: Sink): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      token: { type: "string" },
      http: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(SERVE_HELP);
    return 0;
  }

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      sink.err(`--port must be a whole number between 0 and 65535 (got "${values.port}").`);
      return 2;
    }
  }

  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    if (values.http) {
      const handle = await serveHttp(room, { port, host: values.host });
      process.stderr.write(`atrium: serving ${room.config.name} over http at ${handle.url}\n`);
      process.stderr.write(
        `atrium: every request needs "Authorization: Bearer <token>" — run "atrium invite" for one\n`,
      );
      // Runs until told to stop: there is no equivalent of stdin closing for
      // an HTTP server, so this command's own lifetime is a signal handler.
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          handle.close().then(resolve, resolve);
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      return 0;
    }

    // Announced on stderr: stdout is the protocol stream and must stay clean.
    process.stderr.write(`atrium: serving ${room.config.name} (${room.dir})\n`);
    await serveStdio(room, values.token ? { token: values.token } : {});
    return 0;
  } finally {
    room.close();
  }
}

const WATCH_HELP = `atrium watch — a read-only web view of a running room

Usage: atrium watch [dir] [options]

Opens a local web page showing the board, the members, the artifacts, and the
event log as it happens. Nothing here can change the room: the server refuses
every method except GET, and no page it serves writes anything.

This runs on its own port, separate from "atrium serve --http", and needs no
token. That is only safe because it binds to 127.0.0.1 by default — anything
running on this machine can read the room through it while it is open. Passing
--host to bind wider publishes the room's briefs, drafts and diffs to whoever
can reach the port. Do that deliberately or not at all.

Options:
  --port <n>   port to listen on (default: any free port)
  --host <h>   interface to bind (default: 127.0.0.1)
  --help, -h   show this help
`;

export async function cmdWatch(argv: string[], sink: Sink): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      host: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(WATCH_HELP);
    return 0;
  }

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      sink.err(`--port must be a whole number between 0 and 65535 (got "${values.port}").`);
      return 2;
    }
  }

  const room = openRoom(positionals[0] ?? process.cwd());
  try {
    const handle = await serveWatch(room, { port, host: values.host });
    sink.out(`Watching ${room.config.name} at ${handle.url}`);
    if (values.host !== undefined && values.host !== "127.0.0.1" && values.host !== "localhost") {
      sink.out(
        dim(`Bound to ${handle.host}, so this room is readable by anything that can reach it.`),
      );
    }
    sink.out(dim("Read-only. Press Ctrl-C to stop."));

    // Same shape as "serve --http": nothing ends this but a signal.
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        handle.close().then(resolve, resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  } finally {
    room.close();
  }
}

/**
 * Exported so the single-executable build has something to call. A packaged
 * binary cannot use `isEntryPoint` below — there is no module URL to compare
 * against argv — so it imports this directly instead of relying on the
 * side effect at the bottom of this file.
 */
export function main(): void {
  const sink: Sink = {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };

  const argv = process.argv.slice(2);

  // These commands are asynchronous or do not finish on their own, so they
  // get their own path rather than making every other handler async.
  const longRunning: Record<string, (args: string[], sink: Sink) => Promise<number>> = {
    run: cmdRun,
    serve: cmdServe,
    watch: cmdWatch,
  };
  const run = argv[0] === undefined ? undefined : longRunning[argv[0]];
  if (run) {
    run(argv.slice(1), sink)
      .then((code) => process.exit(code))
      .catch((err: unknown) => {
        sink.err(isAtriumError(err) ? err.message : err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    return;
  }

  process.exit(runCli(argv, sink));
}

// Importing this module (from a test, say) must never launch a command —
// only running it directly as `node cli.js ...` should.
function isEntryPoint(): boolean {
  // No module URL means this is the bundled single-executable build, where
  // `import.meta` is compiled away to an empty object. There is nothing to
  // compare against argv there, and nothing to decide: sea.ts is the entry and
  // calls main() itself. Answering "no" is both true and what keeps this from
  // running twice. Reading it defensively rather than assuming a string is the
  // point — assuming threw, and it threw before the binary could print
  // anything at all.
  const moduleUrl: string | undefined = import.meta?.url;
  if (typeof moduleUrl !== "string") return false;

  return process.argv[1] !== undefined && fileURLToPath(moduleUrl) === resolve(process.argv[1]);
}

if (isEntryPoint()) {
  main();
}
