/**
 * A reference reviewer: reads what other members handed in and decides
 * whether it is finished.
 *
 * This is the half of Atrium that the task board on its own does not show.
 * ARCHITECTURE.md section 5 is the whole project in one rule — an agent
 * cannot mark its own work done — and the mechanism only means something if
 * somebody is actually on the other side of it. That is this file.
 *
 * Two things here are worth watching rather than reading past.
 *
 * The reviewer is a *different member*, and the room enforces that. If this
 * process tried to accept work it had submitted itself, `review_task` would
 * refuse it, whatever role it holds. Nothing about the rule depends on the
 * reviewer being well-behaved.
 *
 * And the rejection is real. The check below is crude — every number in the
 * draft has to appear somewhere in the sources — but it is a rule applied to
 * the text rather than a decision written into the demo. The first draft
 * fails it because it contains a figure that no source supports. Nobody told
 * the reviewer to reject that draft; it rejected it because the draft did not
 * pass.
 *
 * A reviewer backed by a model would apply a far better rule. It would not
 * change anything about the structure around it, which is the point.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openRoomAs } from "./mcp.mjs";

const room = process.env.ATRIUM_ROOM;
const cliPath = process.env.ATRIUM_DEMO_CLI;

if (!room || !cliPath) {
  console.error("Run the demo with `npm run demo` rather than running this file directly.");
  process.exit(2);
}

// The same editor every round, not a new one each time — see openRoomAs.
const session = await openRoomAs({
  cliPath,
  roomDir: room,
  name: "editor",
  role: "reviewer",
  manifest: "Scripted demo reviewer. Checks drafts against the sources they cite.",
});

try {
  const submitted = await session.must("list_tasks", { state: "submitted" });

  if (submitted.length === 0) {
    console.log("[editor] nothing waiting on me");
  }

  for (const task of submitted) {
    const verdict = judge(task);

    const outcome = await session.call("review_task", {
      task_id: task.id,
      accept: verdict.accept,
      ...(verdict.accept ? { note: verdict.note ?? "" } : { reason: verdict.reason }),
    });

    if (!outcome.ok) {
      // The interesting refusal is `permission`: it means the submitter and
      // this reviewer are the same member, which the room will not allow. In
      // this demo they never are, so it would mean the demo is wrong.
      console.log(`[editor] could not review "${task.title}" — ${outcome.error.message}`);
      continue;
    }

    console.log(
      verdict.accept
        ? `[editor] accepted "${task.title}"`
        : `[editor] REJECTED "${task.title}" — ${verdict.reason}`,
    );
  }
} finally {
  await session.close();
}

// ---------------------------------------------------------------------------
// the judgement
// ---------------------------------------------------------------------------

function judge(task) {
  const title = task.title.toLowerCase();

  if (title.includes("write")) return judgeDraft();
  if (title.includes("verify")) return judgeFactcheck();
  return { accept: true, note: "Looks like what was asked for." };
}

/**
 * Every number in the draft has to appear in the sources. Crude, and it is
 * meant to be: the point is that it is a rule about the text, so the verdict
 * is produced by the draft rather than by the script.
 */
function judgeDraft() {
  const draft = read("draft.md");
  const sources = read("sources.md");

  if (draft === undefined) {
    return { accept: false, reason: "There is no draft.md in the room." };
  }
  if (sources === undefined) {
    return { accept: false, reason: "There is no sources.md to check the draft against." };
  }

  const inSources = new Set(numbersIn(sources));
  const unsupported = [...new Set(numbersIn(draft))].filter((n) => !inSources.has(n));

  if (unsupported.length > 0) {
    const sentence = sentenceContaining(draft, unsupported[0]);
    return {
      accept: false,
      reason:
        `"${unsupported[0]}" does not appear in sources.md, so nothing supports it` +
        (sentence ? `: "${sentence}"` : "") +
        ". Cite it or take it out.",
    };
  }

  return { accept: true, note: "Every figure traces to sources.md." };
}

function judgeFactcheck() {
  const report = read("factcheck.md");
  if (report === undefined) {
    return { accept: false, reason: "There is no factcheck.md in the room." };
  }
  if (report.includes("NOT SUPPORTED")) {
    // The fact-checker did its job; the draft is what is wrong. Accepting the
    // report and leaving the draft alone would quietly bless a document
    // everybody involved knows is wrong.
    return {
      accept: false,
      reason:
        "The fact-check found an unsupported claim, so the draft is not finished. " +
        "Fix the draft rather than filing the report against it.",
    };
  }
  return { accept: true, note: "Checked." };
}

function read(name) {
  try {
    return readFileSync(join(room, name), "utf8");
  } catch {
    return undefined;
  }
}

/** Bare numbers, ignoring anything attached to a word like "Q2". */
function numbersIn(text) {
  return [...text.matchAll(/(?<![\w.])\d+(?![\w.])/g)].map((match) => match[0]);
}

function sentenceContaining(text, needle) {
  const flat = text.replace(/\s+/g, " ");
  const sentence = flat
    .split(/(?<=\.)\s+/)
    .find((candidate) => candidate.includes(needle));
  return sentence?.trim();
}
