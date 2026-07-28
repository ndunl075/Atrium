/**
 * The v0.1 job, start to finish: research, then draft, then review.
 *
 * ARCHITECTURE.md section 9 sets this as the definition of done — three
 * members in one room producing one document, "where the reviewer genuinely
 * rejects bad drafts and the rejection genuinely sends work back". Everything
 * else in the test suite checks one module. This checks that the modules add
 * up to the thing the project is for, so if a change breaks the actual job
 * while every unit test still passes, this is what says so.
 *
 * Written against the same functions an agent reaches through MCP, in the same
 * order an agent would reach for them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimTask, createTask, getTask, listTasks } from "./board.js";
import { describeHistory, getContext } from "./context.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { acquireLease, releaseLease } from "./leases.js";
import { pendingReview, reviewTask, submitTask } from "./acceptance.js";
import { Room } from "./room.js";
import { searchArtifacts } from "./search.js";

const created: Array<{ room: Room; dir: string }> = [];

function newsroom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-workflow-"));
  const room = Room.create(join(dir, "newsroom"), config);
  created.push({ room, dir });
  writeFileSync(
    room.paths.context,
    "# Newsroom\n\nSummarise the quarterly numbers for a general reader.\n",
    "utf8",
  );
  return room;
}

afterEach(() => {
  while (created.length) {
    const entry = created.pop()!;
    try {
      entry.room.close();
    } catch {
      // already closed
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

/** Everything a worker does with one file, the way an agent would. */
function produce(room: Room, memberId: string, path: string, content: string): void {
  acquireLease(room, memberId, path);
  writeArtifact(room, memberId, path, content);
  releaseLease(room, memberId, path);
}

describe("research, draft, review", () => {
  it("gets one reviewed document out of three members, with a rejection on the way", async () => {
    const room = newsroom();

    const scout = room.join({
      name: "scout",
      role: "worker",
      manifest: "finds and checks sources",
    }).member;
    const writer = room.join({
      name: "writer",
      role: "worker",
      manifest: "turns notes into prose",
    }).member;
    const editor = room.join({
      name: "editor",
      role: "reviewer",
      manifest: "will not sign off on something thin",
    }).member;

    // Everyone who joins reads the same brief. Nobody had to be told it.
    expect(getContext(room).brief).toContain("quarterly numbers");

    // --- the board is set up so drafting cannot start before research lands
    const research = createTask(room, editor.id, {
      title: "Gather the quarterly numbers",
      description: "Revenue, headcount, churn. Cite each one.",
    });
    const draft = createTask(room, editor.id, {
      title: "Draft the summary",
      description: "One page, plain language.",
      dependsOn: [research.id],
    });

    expect(getTask(room, draft.id).state).toBe("blocked");
    expect(getTask(room, draft.id).waitingOn).toEqual([research.id]);

    // A worker looking for something to pick up is not offered the blocked one.
    expect(listTasks(room, { claimable: true }).map((t) => t.id)).toEqual([
      research.id,
    ]);

    // --- research
    claimTask(room, scout.id, research.id);
    produce(
      room,
      scout.id,
      "notes/numbers.md",
      "# Numbers\n\n- Revenue: 4.2m (finance, Q3 close)\n- Headcount: 61 (HR export)\n- Churn: 3.1% (billing)\n",
    );
    await submitTask(room, scout.id, research.id, {
      summary: "Three figures, each with a source.",
      artifacts: ["notes/numbers.md"],
    });

    expect(pendingReview(room).map((t) => t.id)).toEqual([research.id]);
    reviewTask(room, editor.id, research.id, { accept: true, note: "Sourced." });

    // Accepting the research is what unblocks the draft. Nobody scheduled it.
    expect(getTask(room, draft.id).state).toBe("open");

    // --- a thin first draft, which comes back
    claimTask(room, writer.id, draft.id);

    // The writer finds the research by searching the room, not by being handed it.
    const found = searchArtifacts(room, "churn");
    expect(found[0]?.path).toBe("notes/numbers.md");
    expect(readArtifact(room, "notes/numbers.md").content).toContain("3.1%");

    produce(room, writer.id, "summary.md", "# Summary\n\nThings went fine.\n");
    await submitTask(room, writer.id, draft.id, {
      summary: "First pass.",
      artifacts: ["summary.md"],
    });

    // The writer cannot wave its own work through. This is the whole point.
    expect(() =>
      reviewTask(room, writer.id, draft.id, { accept: true }),
    ).toThrow(/somebody else/);

    reviewTask(room, editor.id, draft.id, {
      accept: false,
      reason: "No numbers in it. Use the figures from notes/numbers.md.",
    });

    const rejected = getTask(room, draft.id);
    expect(rejected.state).toBe("rejected");
    expect(rejected.attempts).toBe(1);
    expect(rejected.claimedBy).toBeUndefined();
    expect(rejected.lastRejection?.reason).toMatch(/No numbers/);

    // --- second attempt, this time with the numbers
    claimTask(room, writer.id, draft.id);
    produce(
      room,
      writer.id,
      "summary.md",
      "# Summary\n\nRevenue reached 4.2m this quarter against a headcount of 61, with churn at 3.1%.\n",
    );
    await submitTask(room, writer.id, draft.id, {
      summary: "Rewritten around the three figures.",
      artifacts: ["summary.md"],
    });

    reviewTask(room, editor.id, draft.id, { accept: true, note: "Ship it." });

    // --- the job is done, and the room can say how it got there
    const finished = getTask(room, draft.id);
    expect(finished.state).toBe("accepted");
    expect(finished.attempts).toBe(1);
    expect(listTasks(room, { state: "accepted" })).toHaveLength(2);

    expect(readArtifact(room, "summary.md").content).toContain("4.2m");

    const history = describeHistory(room).map((h) => h.line).join("\n");
    expect(history).toMatch(/scout joined/);
    expect(history).toMatch(/rejected/);
    expect(history).toMatch(/accepted/);
  });

  it("stops a task that keeps coming back rather than letting it loop", async () => {
    const room = newsroom({ config: { maxAttempts: 2 } });
    const writer = room.join({ name: "writer", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;

    const task = createTask(room, editor.id, { title: "Draft the summary" });

    for (let attempt = 1; attempt <= 2; attempt++) {
      claimTask(room, writer.id, task.id);
      produce(room, writer.id, "summary.md", `attempt ${attempt}\n`);
      await submitTask(room, writer.id, task.id, { summary: `attempt ${attempt}` });
      reviewTask(room, editor.id, task.id, {
        accept: false,
        reason: "Still not good enough.",
      });
    }

    const frozen = getTask(room, task.id);
    expect(frozen.attempts).toBe(2);
    expect(frozen.escalated).toBe(true);

    // Frozen means frozen: nobody picks it up again until a human steps in.
    expect(() => claimTask(room, writer.id, task.id)).toThrow(/human/);
    expect(listTasks(room, { claimable: true })).toHaveLength(0);
  });

  it("lets a test suite do the accepting, with nobody's opinion involved", async () => {
    const room = newsroom();
    const writer = room.join({ name: "writer", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;

    const task = createTask(room, editor.id, {
      title: "Write the totals file",
      // Passes only once the file says what it should.
      acceptance: { kind: "command", command: "grep -q 4.2m summary.md" },
    });

    claimTask(room, writer.id, task.id);
    produce(room, writer.id, "summary.md", "no figures here\n");
    await submitTask(room, writer.id, task.id, { summary: "first go" });

    // No reviewer was asked. The command decided.
    expect(getTask(room, task.id).state).toBe("rejected");

    claimTask(room, writer.id, task.id);
    produce(room, writer.id, "summary.md", "revenue was 4.2m\n");
    await submitTask(room, writer.id, task.id, { summary: "with the figure" });

    expect(getTask(room, task.id).state).toBe("accepted");
  });

  it("can be replayed to show how the room looked partway through", async () => {
    const room = newsroom();
    const writer = room.join({ name: "writer", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;

    const task = createTask(room, editor.id, { title: "Draft the summary" });
    claimTask(room, writer.id, task.id);
    const midpoint = room.log.head();

    produce(room, writer.id, "summary.md", "done\n");
    await submitTask(room, writer.id, task.id, { summary: "done" });
    reviewTask(room, editor.id, task.id, { accept: true });

    expect(getTask(room, task.id).state).toBe("accepted");

    // The log is the source of truth, so any earlier moment can be recovered.
    const { foldTasks } = await import("./tasks.js");
    const back = foldTasks(room.log.read({ to: midpoint }), {
      maxAttempts: room.config.maxAttempts,
      at: room.log.at(midpoint)!.ts,
    });
    expect(back.get(task.id)?.state).toBe("claimed");
  });
});
