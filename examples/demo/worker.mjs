/**
 * A reference worker: joins a room, claims the task it was given, does the
 * work, and hands it in.
 *
 * This is what `atrium run` launches. The runner puts the assignment in the
 * environment (ATRIUM_ROOM, ATRIUM_TASK_ID, ...) and nothing else — it does
 * not hand over a claim, because the runner is not allowed to hold board
 * state. The worker claims through Atrium itself, which is also what makes
 * the race real: if two workers are launched for the same task, exactly one
 * claim succeeds and the other gets a conflict and stops.
 *
 * ## What this worker does not do
 *
 * It does not call a model. The text it produces is written into this file,
 * and the reviewer's rejection is triggered by a deliberate flaw in the first
 * draft rather than by anybody's judgement. That is a real limitation and
 * worth being clear about: this proves the *plumbing* — claims, leases,
 * artifact writes, hand-in, rejection, rework, acceptance — and proves
 * nothing about whether real agents coordinate well.
 *
 * What makes it still worth shipping is that the plumbing is the part that is
 * hard to believe without seeing, and the part that a test can check on every
 * commit. A worker that called a model would demonstrate more and could be
 * relied on for less.
 *
 * Everything below the "the work" heading is the scripted part. Everything
 * above it is how any worker, scripted or not, has to behave.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openRoomAs } from "./mcp.mjs";

const room = process.env.ATRIUM_ROOM;
const taskId = process.env.ATRIUM_TASK_ID;
const workerName = process.env.ATRIUM_WORKER_NAME ?? "worker";
const cliPath = process.env.ATRIUM_DEMO_CLI;

if (!room || !taskId || !cliPath) {
  console.error(
    "This worker expects to be launched by `atrium run`, which sets ATRIUM_ROOM and\n" +
      "ATRIUM_TASK_ID. ATRIUM_DEMO_CLI must point at the built cli.js. Run the demo\n" +
      "with `npm run demo` instead of running this file directly.",
  );
  process.exit(2);
}

/**
 * A function rather than top-level statements, so that the scripted text at
 * the bottom of the file has been initialised by the time the work reaches
 * it. Reading order and evaluation order pull in opposite directions here,
 * and reading order is the one worth keeping.
 */
async function main() {
  // The runner launches this once per task, so the token is what keeps
  // "scout" one member across all of them rather than one per task.
  const session = await openRoomAs({
    cliPath,
    roomDir: room,
    name: workerName,
    role: "worker",
    manifest: "Scripted demo worker. Writes the newsroom artifacts. Does not call a model.",
  });

  try {
    const claim = await session.call("claim_task", { task_id: taskId });
    if (!claim.ok) {
      // Losing a claim is a normal outcome, not a failure: somebody else got
      // there first, and the right response is to stop rather than to retry
      // into a race. Exiting 0 keeps the runner's summary honest about that.
      console.log(`[${workerName}] ${taskId} was already taken — ${claim.error.message}`);
      return;
    }

    const task = claim.value.task ?? claim.value;
    const attempt = task.attempts ?? 0;
    console.log(
      `[${workerName}] claimed "${task.title}"${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`,
    );

    if (attempt > 0 && task.lastRejection) {
      // The rejection is on the board, not in a message somebody forwarded.
      // This is the shared-state claim doing something concrete: a worker that
      // has never seen the previous attempt can still read exactly why it came
      // back, in the reviewer's own words.
      console.log(`[${workerName}] previous attempt was rejected: ${task.lastRejection.reason}`);
    }

    const work = produce(task, attempt);

    for (const [path, contents] of Object.entries(work.files)) {
      const written = await session.call("write_artifact", { path, content: contents });
      if (!written.ok) throw new Error(`could not write ${path}: ${written.error.message}`);
      console.log(`[${workerName}] wrote ${path}`);
    }

    await session.must("submit_task", {
      task_id: taskId,
      summary: work.summary,
      artifacts: Object.keys(work.files),
    });
    console.log(
      `[${workerName}] handed in "${task.title}" — waiting on somebody else to accept it`,
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// the work
//
// Scripted from here down. A real worker would call a model; this one looks
// up what to produce from the task title, and deliberately gets the draft
// wrong the first time so the rejection in the demo is a real rejection of
// work that really is not good enough, rather than a rejection staged by the
// reviewer.
// ---------------------------------------------------------------------------

const SOURCES = `# Sources

- https://example.com/henley-barrow-filing — the merger filing itself, 12 June.
- https://example.com/barrow-q2 — Barrow's Q2 results, where the debt figure comes from.
- https://example.com/regulator-statement — the regulator's statement on the review period.
- https://example.com/henley-staff-letter — the internal letter to Henley staff, leaked 14 June.
`;

/** The first draft. Its final sentence is not supported by sources.md, which
 * is what the fact-check is supposed to catch. */
const DRAFT_FLAWED = `# Henley and Barrow to merge

Henley and Barrow confirmed on 12 June that they intend to merge, in a filing
that sets out a combined balance sheet and a timetable running to the end of
the year. Barrow's most recent results show the debt position that made the
approach possible, and the regulator has said it will take the standard review
period before deciding.

Staff at Henley were told by letter on 14 June, two days after the filing.

The merger is expected to result in around 400 job losses.
`;

/** The same draft with the unsupported claim replaced by what the sources
 * actually say. */
const DRAFT_FIXED = `# Henley and Barrow to merge

Henley and Barrow confirmed on 12 June that they intend to merge, in a filing
that sets out a combined balance sheet and a timetable running to the end of
the year. Barrow's most recent results show the debt position that made the
approach possible, and the regulator has said it will take the standard review
period before deciding.

Staff at Henley were told by letter on 14 June, two days after the filing. The
letter does not mention job losses, and neither the filing nor the regulator's
statement puts a figure on them.
`;

function produce(task, attempt) {
  const title = task.title.toLowerCase();

  if (title.includes("gather sources")) {
    return {
      files: { "sources.md": SOURCES },
      summary: "Four sources, each with what it supports.",
    };
  }

  if (title.includes("write")) {
    return {
      files: { "draft.md": attempt === 0 ? DRAFT_FLAWED : DRAFT_FIXED },
      summary:
        attempt === 0
          ? "First draft from sources.md."
          : "Removed the job-losses figure, which no source supported.",
    };
  }

  if (title.includes("verify")) {
    // The fact-check produces a note rather than editing the draft: whoever
    // wrote the draft is the one who should fix it, and the board is how that
    // gets back to them.
    return {
      files: { "factcheck.md": factcheck() },
      summary: "Checked every claim in draft.md against sources.md.",
    };
  }

  if (title.includes("check the draft")) {
    // Nothing to write. Handing this in runs the room's acceptance command,
    // and its exit code decides — the worker does not get an opinion, which
    // is the whole point of a `command` acceptance.
    return { files: {}, summary: "Handing in for the automated check." };
  }

  return {
    files: {},
    summary: `Nothing scripted for "${task.title}" — the demo worker only knows the newsroom job.`,
  };
}

function factcheck() {
  const draft = readFileSync(join(room, "draft.md"), "utf8");
  const unsupported = draft.includes("400 job losses");
  return unsupported
    ? `# Fact-check\n\nNOT SUPPORTED: "around 400 job losses". No source in sources.md gives a\nfigure for job losses. The staff letter does not mention them at all.\n`
    : `# Fact-check\n\nEvery claim in draft.md traces to a source in sources.md.\n`;
}

await main();
