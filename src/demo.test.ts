/**
 * The shipped demo, run for real.
 *
 * This is the reason the reference worker is scripted rather than backed by a
 * model. A demo nobody checks rots quietly — the interesting failure is not
 * that it crashes, which anyone would notice, but that it stops demonstrating
 * the thing it exists to demonstrate while still exiting 0. A rejection that
 * silently stopped happening would leave `npm run demo` looking fine and
 * saying nothing.
 *
 * So the assertions are about the *story*, not just the exit code: work was
 * handed in, it was turned down for a stated reason, it came back changed,
 * and a different member accepted it. If any of that stops being true this
 * test fails, whatever the demo prints.
 *
 * It shells out to the real script against the real built CLI, because a test
 * that reimplemented the demo's steps would pass while the demo itself was
 * broken.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "cli.js");
const demo = join(repo, "examples", "demo", "run.mjs");

/** The demo spawns a process per task per round; give it room on a cold CI box. */
const TIMEOUT_MS = 120_000;

let workspace: string;
let roomDir: string;
let output: string;

/** The whole demo runs once and every assertion reads the same run. */
beforeAll(() => {
  // Checked before anything is spawned, because the failure otherwise is a
  // child process exiting non-zero with nothing useful on stderr.
  if (!existsSync(cli)) {
    throw new Error(
      `${cli} is missing, so the demo has nothing to run against.\n` +
        'Run "npm run build" first. CI builds before it tests for this reason.',
    );
  }

  workspace = mkdtempSync(join(tmpdir(), "atrium-demo-"));
  roomDir = join(workspace, "newsroom");

  const result = spawnSync(process.execPath, [demo, roomDir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: TIMEOUT_MS,
  });

  output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  expect(result.status, `the demo exited ${result.status}:\n${output}`).toBe(0);
}, TIMEOUT_MS);

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

function board(): Array<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [cli, "board", roomDir, "--json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

interface LoggedEvent {
  seq: number;
  actor: string;
  type: string;
  /** The rendered line. `atrium log --json` gives no structured payload, so
   * the task id is read back out of it. */
  line: string;
}

function events(type: string): LoggedEvent[] {
  const result = spawnSync(
    process.execPath,
    [cli, "log", roomDir, "--type", type, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function taskIdIn(event: LoggedEvent): string {
  const id = /task_[0-9a-f]+/.exec(event.line)?.[0];
  expect(id, `no task id in: ${event.line}`).toBeDefined();
  return id!;
}

function versionsOf(path: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    process.execPath,
    [cli, "history", path, roomDir, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("the shipped demo", () => {
  it("finishes every task on the board", () => {
    const tasks = board();
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task) => task.state === "accepted")).toBe(true);
  });

  it("rejects the first draft, which is the point of the whole thing", () => {
    const rejections = events("task.rejected");
    expect(rejections).toHaveLength(1);
    expect(output).toMatch(/REJECTED "Write the piece"/);
  });

  it("rejects it for a reason drawn from the draft, not a canned string", () => {
    // The reviewer's rule is "every number in the draft appears in the
    // sources". If the rejection stopped naming the figure that broke it, the
    // reviewer would have stopped actually reading the draft.
    expect(output).toMatch(/"400" does not appear in sources\.md/);
  });

  it("hands the rejection back through the board rather than a message", () => {
    // The second attempt reads the reason out of the room, having never seen
    // the first attempt. This is section 2's claim doing something concrete.
    expect(output).toMatch(/previous attempt was rejected: "400" does not appear/);
  });

  it("produces a second version of the draft that fixes what was wrong", () => {
    const draft = readFileSync(join(roomDir, "draft.md"), "utf8");
    expect(draft).not.toMatch(/400 job losses/);
    expect(draft).toMatch(/does not mention job losses/);

    // Both versions are still readable, which is what makes the rejection
    // inspectable afterwards rather than just recorded.
    expect(versionsOf("draft.md").length).toBeGreaterThanOrEqual(2);
  });

  it("never lets the member that submitted work be the one that judged it", () => {
    // The rule from section 5, checked against the log rather than trusted.
    //
    // Command acceptances are excluded, and the reason is worth stating
    // because the log looks like a violation at a glance: a `command` verdict
    // is recorded against the member that submitted the work, since that is
    // who triggered it. No judgement was involved — the exit code decided —
    // so there is no self-approval to find. The line says "via command", and
    // that phrase is the only thing separating the two cases in the log.
    const submitter = new Map<string, string>();
    for (const event of events("task.submitted")) {
      submitter.set(taskIdIn(event), event.actor);
    }

    const judged = [...events("task.accepted"), ...events("task.rejected")].filter(
      (event) => !event.line.includes("via command"),
    );
    expect(judged.length).toBeGreaterThan(0);

    let checked = 0;
    for (const verdict of judged) {
      const taskId = taskIdIn(verdict);
      const submitted = submitter.get(taskId);
      if (submitted === undefined) continue;
      expect(verdict.actor, `${taskId} was judged by the member that submitted it`).not.toBe(
        submitted,
      );
      checked++;
    }
    expect(checked, "no member-judged verdicts to check").toBeGreaterThan(0);
  });

  it("keeps each demo member as one member across all its launches", () => {
    // Both processes are relaunched repeatedly. Without the saved token they
    // would join afresh every time and the roster would grow one "editor"
    // and one "scout" per round.
    const roster = JSON.parse(
      spawnSync(process.execPath, [cli, "roster", roomDir, "--json"], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout,
    ) as Array<{ name: string }>;

    const byName = new Map<string, number>();
    for (const member of roster) byName.set(member.name, (byName.get(member.name) ?? 0) + 1);

    // Not "exactly one", which would be asserting that the documented
    // fallback never fires. A saved token that stops working is survivable by
    // design — the worker says so and joins fresh — and that is a legitimate
    // extra member rather than a failure. What would be a failure is the
    // token mechanism not working at all, and that looks completely
    // different: the demo runs five rounds, so a worker joining fresh every
    // launch leaves five scouts, not two.
    expect(byName.get("scout")).toBeLessThanOrEqual(2);
    expect(byName.get("editor")).toBeLessThanOrEqual(2);
  });

  it("settles the command-acceptance task on an exit code", () => {
    const signoff = board().find((task) => String(task.title).includes("Check the draft"));
    expect(signoff?.state).toBe("accepted");

    const viaCommand = events("task.accepted").filter((event) =>
      event.line.includes("via command"),
    );
    expect(viaCommand).toHaveLength(1);
    // The script's own output becomes the reason, so the record says what the
    // check actually verified rather than only that something passed.
    expect(viaCommand[0]!.line).toMatch(/at least 60 words/);
  });
});
