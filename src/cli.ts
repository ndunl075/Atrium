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
  describeHistory,
  foldTasks,
  getContext,
  listTasks,
  searchArtifacts,
} from "./index.js";
import { serveHttp } from "./http.js";
import { serveStdio } from "./mcp.js";
import type { MemberRole, Task, TaskState } from "./index.js";

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
  serve [dir]           serve the room to an MCP client over stdin/stdout

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
