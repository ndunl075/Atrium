/**
 * The demo: one command, and you watch an agent's work get sent back.
 *
 * This is what ARCHITECTURE.md section 9 means by the v0.3 definition of
 * done. Everything Atrium does has been testable since v0.1 and visible to
 * nobody who was not reading the test suite. This script closes that gap by
 * driving a real room with real MCP clients and narrating what happens.
 *
 * It is a driver, not a scheduler. Every decision it makes is "run a dispatch
 * pass" or "let the reviewer look at what is waiting" — it never touches the
 * board itself, never decides that a task is finished, and holds no state
 * between rounds. The room does all of that, and this script would find out
 * about any of it the same way you do, by asking.
 *
 * Usage:
 *   node examples/demo/run.mjs [dir] [--fresh] [--keep]
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const cli = join(repo, "dist", "cli.js");

const argv = process.argv.slice(2);
const fresh = argv.includes("--fresh");
const keep = argv.includes("--keep");
const roomDir = resolve(argv.find((arg) => !arg.startsWith("--")) ?? join(repo, "demo-newsroom"));

/** Enough rounds for the job plus the rework, and a stop if it ever loops. */
const MAX_ROUNDS = 12;

if (!existsSync(cli)) {
  fail(`No build at ${cli}. Run "npm run build" first, or use "npm run demo".`);
}

// ---------------------------------------------------------------------------
// set the room up
// ---------------------------------------------------------------------------

if (existsSync(roomDir)) {
  if (!fresh) {
    fail(
      `${roomDir} already exists.\n` +
        "Pass --fresh to delete and recreate it, or give another directory:\n" +
        "  npm run demo -- --fresh",
    );
  }
  // Only ever deletes a directory that is a room this script made, so a
  // mistyped path cannot take something else with it.
  if (!existsSync(join(roomDir, ".atrium")) || !existsSync(join(roomDir, ".demo"))) {
    fail(
      `${roomDir} exists but was not created by this demo, so --fresh will not delete it.\n` +
        "Point the demo somewhere else.",
    );
  }
  rmSync(roomDir, { recursive: true, force: true });
}

say("Creating the room from examples/demo/job.yaml");
atrium(["init", roomDir, "--from", join(here, "job.yaml")]);

// The acceptance command runs with the room as its working directory, so the
// script it names has to be in the room.
mkdirSync(join(roomDir, ".demo"), { recursive: true });
cpSync(join(here, "check-draft.mjs"), join(roomDir, ".demo", "check-draft.mjs"));

// Two worker slots so the runner has somewhere to put work. The job's
// dependencies mean only one task is claimable at a time here, but the
// runner does not know that and does not need to.
writeFileSync(
  join(roomDir, ".atrium", "runner.json"),
  JSON.stringify(
    {
      workers: [
        { name: "scout", command: `node ${quote(join(here, "worker.mjs"))}` },
        { name: "scribe", command: `node ${quote(join(here, "worker.mjs"))}` },
      ],
      maxConcurrent: 2,
    },
    null,
    2,
  ),
  "utf8",
);

// ---------------------------------------------------------------------------
// run it
// ---------------------------------------------------------------------------

const env = { ...process.env, ATRIUM_DEMO_CLI: cli, ATRIUM_ROOM: roomDir };
let rejections = 0;
let round = 0;

for (; round < MAX_ROUNDS; round++) {
  const board = boardState();
  if (board.claimable === 0 && board.submitted === 0) break;

  say(`Round ${round + 1}`);

  // Workers pick up whatever is claimable. The runner launches them; they
  // claim through Atrium themselves.
  if (board.claimable > 0) atrium(["run", roomDir], env);

  // Then whoever is waiting on a verdict gets one. Nothing here decides
  // anything — the reviewer is a member of the room like any other.
  if (boardState().submitted > 0) {
    const before = rejectionCount();
    run(process.execPath, [join(here, "reviewer.mjs")], env);
    rejections += rejectionCount() - before;
  }
}

// ---------------------------------------------------------------------------
// say what happened
// ---------------------------------------------------------------------------

const final = boardState();

console.log("");
say("Final board");
atrium(["board", roomDir]);

console.log("");
if (final.accepted === final.total && final.total > 0) {
  console.log(`Every task finished, in ${round} rounds.`);
} else {
  console.log(`Stopped after ${round} rounds with ${final.accepted}/${final.total} accepted.`);
}

if (rejections > 0) {
  console.log(
    `\n${rejections} submission${rejections === 1 ? " was" : "s were"} rejected and sent back.\n` +
      "That is the part worth looking at. The worker that wrote the draft did not\n" +
      "get to decide it was finished, and the reviewer that rejected it could not\n" +
      "have accepted its own work either — the room refuses that outright, whatever\n" +
      "role a member holds.\n\n" +
      "The rejection reason went onto the board, not into a message. When the\n" +
      "worker picked the task back up it read the reason from the room itself.",
  );
} else {
  console.log(
    "\nNothing was rejected this run, which is not what the demo is meant to show.\n" +
      "That probably means something is wrong — try --fresh.",
  );
}

console.log(
  `\nThe room is at ${roomDir}\n` +
    `  node dist/cli.js log ${rel(roomDir)}            everything that happened, in order\n` +
    `  node dist/cli.js history draft.md ${rel(roomDir)}   every version of the draft\n` +
    `  node dist/cli.js diff draft.md ${rel(roomDir)}      what changed after the rejection\n` +
    `  node dist/cli.js watch ${rel(roomDir)}          the same thing in a browser`,
);

if (!keep && !fresh) {
  console.log(`\nRun again with --fresh to start over, or --keep to leave this room in place.`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The board, asked for rather than remembered. This script keeps no count of
 * what it thinks the state is; every round it asks the room, which is the
 * same discipline the runner is held to.
 */
function boardState() {
  const tasks = JSON.parse(captureAtrium(["board", roomDir, "--json"]));
  return {
    total: tasks.length,
    accepted: tasks.filter((task) => task.state === "accepted").length,
    submitted: tasks.filter((task) => task.state === "submitted").length,
    // A rejected task is back on the board, not finished with: `rejected` and
    // `open` are both claimable states, and the difference between them is
    // that one of them remembers why it came back. A task frozen after too
    // many rejections is escalated and nobody can pick it up.
    claimable: tasks.filter(
      (task) => (task.state === "open" || task.state === "rejected") && !task.escalated,
    ).length,
  };
}

/** How many rejections the log has recorded so far. */
function rejectionCount() {
  return JSON.parse(captureAtrium(["log", roomDir, "--type", "task.rejected", "--json"])).length;
}

/** `atrium <args>`, shown to the reader and inherited straight to the terminal. */
function atrium(args, environment = process.env) {
  run(process.execPath, [cli, ...args], environment);
}

/** The same, when the output is for this script rather than for the reader. */
function captureAtrium(args) {
  return capture(process.execPath, [cli, ...args]);
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function quote(path) {
  return path.includes(" ") ? `"${path}"` : path;
}

function rel(path) {
  const relative = path.startsWith(repo) ? "." + path.slice(repo.length) : path;
  return quote(relative.replace(/\\/g, "/"));
}

function say(message) {
  console.log(`\n=== ${message} ===`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
