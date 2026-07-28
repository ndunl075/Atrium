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
  costSummary,
  createTask,
  currentLease,
  describeHistory,
  diffArtifact,
  foldTasks,
  gcBlobs,
  getContext,
  getTask,
  listTasks,
  listVersions,
  pruneVersions,
  releaseTask,
  restartTask,
  reviewTask,
  searchArtifacts,
} from "./index.js";
import { serveHttp } from "./http.js";
import { serveStdio } from "./mcp.js";
import type { Acceptance, MemberId, MemberRole, Task, TaskState, Verdict } from "./index.js";

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

const INIT_HELP = `Usage: atrium init [dir]

Creates a room in dir (default: the current directory). Refuses to run
twice on the same directory — a room is created once, then joined.

Options:
  --help, -h   show this help
`;

export function cmdInit(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(INIT_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = Room.create(dir);
  try {
    sink.out(`Created room "${room.config.name}" in ${room.dir}`);
    sink.out(`Write ${room.paths.context} before anyone joins — it's the first thing every agent reads.`);
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

Options:
  --limit <n>  show at most n lines
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdLog(argv: string[], sink: Sink): number {
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
    sink.out(LOG_HELP);
    return 0;
  }

  const limit = parseLimit(sink, values.limit);
  if (!limit.ok) return 2;

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
    const lines = describeHistory(room, limit.value === undefined ? {} : { limit: limit.value });

    if (values.json) {
      sink.out(JSON.stringify(lines, null, 2));
      return 0;
    }
    if (lines.length === 0) {
      sink.out(dim("Nothing has happened yet."));
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

The task board as it looked right after event <seq>, not as it looks now.
Folds the log up to that point and judges claim expiry against the
timestamp of that event, so a claim that had not yet lapsed back then still
reads as claimed even if it has since lapsed for real.

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
    // a real replay: a claim that was still live at #seq must still read as
    // claimed, even though wall-clock time has moved on since.
    const tasks = [
      ...foldTasks(room.log.read({ to: seq }), {
        maxAttempts: room.config.maxAttempts,
        at: event.ts,
      }).values(),
    ];

    if (values.json) {
      sink.out(JSON.stringify({ seq, at: event.ts, tasks }, null, 2));
      return 0;
    }

    sink.out(bold(`Board as of #${seq} (${event.ts})`));
    sink.out("");
    for (const line of renderBoard(tasks)) sink.out(line);
    return 0;
  } finally {
    room.close();
  }
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

const CONTEXT_HELP = `Usage: atrium context [dir]

The shared brief (CONTEXT.md plus pinned artifacts) and its token total
against the room's ceiling.

Options:
  --json       print machine-readable JSON instead
  --help, -h   show this help
`;

export function cmdContext(argv: string[], sink: Sink): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(CONTEXT_HELP);
    return 0;
  }

  const dir = positionals[0] ?? process.cwd();
  const room = openRoom(dir);
  try {
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
// task — the human's hands on the board
// ---------------------------------------------------------------------------
//
// ARCHITECTURE.md §3.2 gives `human` "everything a reviewer can do, plus
// running the room," but until now the CLI could only look at a room, never
// act on it. These five subcommands are that missing hand: putting a task on
// the board, giving a verdict, forcing a stuck claim back, and restarting a
// task that froze after too many rejections.
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
      return `command — "${acceptance.command}" must exit 0`;
    case "reviewer":
      return "reviewer — a different member must accept";
    case "human":
      return "human — a human must accept";
    case "none":
      return "none — auto-accepts on submit";
  }
}

/** Parses `--acceptance` and `--command` together, since one only makes sense
 * with the other. Returns `undefined` (not an error) when neither is given,
 * so `createTask`'s own default of `reviewer` applies. */
function parseAcceptanceFlag(
  sink: Sink,
  kind: string | undefined,
  command: string | undefined,
): { ok: true; value: Acceptance | undefined } | { ok: false } {
  if (kind === undefined) {
    if (command !== undefined) {
      sink.err("--command only makes sense together with --acceptance command.");
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
    return { ok: true, value: { kind: "command", command } };
  }
  if (command !== undefined) {
    sink.err("--command only makes sense together with --acceptance command.");
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
    },
    allowPositionals: true,
  });
  if (values.help) {
    sink.out(TASK_ADD_HELP);
    return 0;
  }

  const acceptance = parseAcceptanceFlag(sink, values.acceptance, values.command);
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

const TASK_HELP = `Usage: atrium task <subcommand> [options]

Subcommands:
  add <room> --title T [options]        create a task and print its id
  show <id> <room> [--json]             full detail on one task
  review <id> <room> --accept|--reject  a human verdict on submitted work
  release <id> <room>                   force a claimed task back to the board
  unblock <id> <room>                   restart a task frozen by escalation

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
    case "unblock":
      return cmdTaskUnblock(rest, sink);
    default:
      sink.err(`Unknown "atrium task" subcommand "${sub}". Run "atrium task --help" for the list.`);
      return 2;
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
  context [dir]         the shared brief and its token total against the ceiling
  search <query> [dir]  full-text search over the room's artifacts
  cost [dir]            per-member and room spend totals against the caps
  history <path> [dir]  every version an artifact has had
  diff <path> [dir]     a unified diff between two versions of an artifact
  gc [dir]              remove stored content no log entry points at
  prune [dir]           drop the content of old artifact versions (destructive)
  serve [dir]           serve the room to an MCP client over stdin/stdout
  task <subcommand>     create, inspect, and administer tasks — see "atrium task --help"

Run "atrium <command> --help" for details on any command.

Global flags:
  --help, -h     show this help
  --version      print the installed version
`;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function dispatch(argv: string[], sink: Sink): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    sink.out(GLOBAL_HELP);
    return 0;
  }
  if (command === "--version") {
    sink.out(readVersion());
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
    case "cost":
      return cmdCost(rest, sink);
    case "history":
      return cmdHistory(rest, sink);
    case "diff":
      return cmdDiff(rest, sink);
    case "gc":
      return cmdGc(rest, sink);
    case "prune":
      return cmdPrune(rest, sink);
    case "task":
      return cmdTask(rest, sink);
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

function main(): void {
  const sink: Sink = {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };

  const argv = process.argv.slice(2);

  // serve is the one command that does not finish on its own, so it gets its
  // own path rather than making every other command's handler async.
  if (argv[0] === "serve") {
    cmdServe(argv.slice(1), sink)
      .then((code) => process.exit(code))
      .catch((err: unknown) => {
        sink.err(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    return;
  }

  process.exit(runCli(argv, sink));
}

// Importing this module (from a test, say) must never launch a command —
// only running it directly as `node cli.js ...` should.
function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isEntryPoint()) {
  main();
}
