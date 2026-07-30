/**
 * A command acceptance: the strongest kind Atrium has.
 *
 * ARCHITECTURE.md section 5 ranks the four ways a task can be called done,
 * and this is the top of that list — an exit code decides, so no opinion is
 * involved and nobody's judgement has to be trusted. A passing test suite is
 * worth more than an agent's belief that the code looks correct.
 *
 * Atrium runs this with the room as the working directory, which is why every
 * path here is relative and why the script can be this short. Exit 0 and the
 * task is accepted; exit anything else and the output below becomes the
 * rejection reason the worker reads.
 */

import { readFileSync } from "node:fs";

const MINIMUM_WORDS = 60;

const problems = [];

function read(name) {
  try {
    return readFileSync(name, "utf8");
  } catch {
    problems.push(`${name} is missing.`);
    return undefined;
  }
}

const draft = read("draft.md");
const factcheck = read("factcheck.md");

if (draft !== undefined) {
  const words = draft.split(/\s+/).filter(Boolean).length;
  if (words < MINIMUM_WORDS) {
    problems.push(`draft.md is ${words} words; the brief asks for at least ${MINIMUM_WORDS}.`);
  }
}

if (factcheck !== undefined && factcheck.includes("NOT SUPPORTED")) {
  problems.push("factcheck.md still lists an unsupported claim.");
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`draft.md passes: at least ${MINIMUM_WORDS} words, and the fact-check is clean.`);
