import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pendingReview,
  reviewTask,
  runAcceptanceCommand,
  submitTask,
} from "./acceptance.js";
import { InvalidError, PermissionError } from "./errors.js";
import { Room } from "./room.js";
import { foldTasks, isClaimable } from "./tasks.js";
import type { Acceptance, MemberId, Task, TaskId } from "./types.js";
import { addSeconds, newId, now } from "./util.js";

// src/board.ts is being built on another branch, so tasks are put on the
// board here by appending the same events a board module would append, and
// read back with foldTasks — the same fold acceptance.ts itself uses.

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-acceptance-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
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
    // Retried, unlike the identical cleanup in every other test file, because
    // this is the one that kills processes. `runShell` resolves a timed-out
    // command as soon as it calls `kill`, which is the right thing for the
    // room — the verdict is known and nothing should wait on a process that
    // is already doomed. Windows, though, does not release the child's handle
    // on its working directory the instant the kill returns, and that working
    // directory is the room we are about to delete. So the unlucky ordering
    // is a real one and it happens often: `rmdir` lands before the OS has
    // finished tearing the process down, and fails with EBUSY.
    //
    // These are exactly the retries `maxRetries`/`retryDelay` exist for. The
    // alternative — having `runShell` wait for the process to actually exit
    // after killing it — would make production code slower to answer in order
    // to make a test tidier, which is the wrong way round.
    rmSync(entry.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function createTask(room: Room, acceptance: Acceptance, title = "task"): TaskId {
  const taskId = newId("task");
  room.log.append("system", "task.created", {
    taskId,
    title,
    description: "",
    dependsOn: [],
    acceptance,
  });
  return taskId;
}

function claim(room: Room, taskId: TaskId, memberId: MemberId): void {
  room.log.append(memberId, "task.claimed", {
    taskId,
    memberId,
    expiresAt: addSeconds(now(), 300),
  });
}

function readTask(room: Room, taskId: TaskId): Task {
  const tasks = foldTasks(room.log.read(), {
    maxAttempts: room.config.maxAttempts,
  });
  const task = tasks.get(taskId);
  if (!task) throw new Error(`test setup error: no task ${taskId}`);
  return task;
}

describe("submitTask", () => {
  it("only lets the claim holder submit", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const other = room.join({ name: "w2", role: "worker" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);

    await expect(
      submitTask(room, other.id, taskId, { summary: "done" }),
    ).rejects.toThrow(PermissionError);
  });

  it("refuses to submit a task that is not claimed", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const taskId = createTask(room, { kind: "reviewer" });

    await expect(
      submitTask(room, worker.id, taskId, { summary: "done" }),
    ).rejects.toThrow(InvalidError);
  });

  it("leaves a reviewer task waiting for a verdict", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);

    const task = await submitTask(room, worker.id, taskId, {
      summary: "draft ready",
      artifacts: ["draft.md"],
    });

    expect(task.state).toBe("submitted");
    expect(task.submittedBy).toBe(worker.id);
    expect(task.submittedArtifacts).toEqual(["draft.md"]);
    expect(readTask(room, taskId).state).toBe("submitted");
  });

  it("defaults basedOnSeq to the log head at submission time", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);

    const headBefore = room.log.head();
    const task = await submitTask(room, worker.id, taskId, { summary: "done" });
    expect(task.submittedAtSeq).toBe(headBefore);
  });

  describe("command acceptance", () => {
    it("accepts automatically when the command exits 0", async () => {
      const room = tempRoom();
      const worker = room.join({ name: "w1", role: "worker" }).member;
      // `exit 0` rather than `true`: a shell builtin everywhere, where `true`
      // is a coreutils binary that only happens to be on PATH on Windows when
      // something like Git for Windows has put it there.
      const taskId = createTask(room, { kind: "command", command: "exit 0" });
      claim(room, taskId, worker.id);

      const task = await submitTask(room, worker.id, taskId, { summary: "done" });

      expect(task.state).toBe("accepted");
      const events = room.log.read({ types: ["task.accepted"] });
      expect(events).toHaveLength(1);
      if (events[0]?.type === "task.accepted") {
        expect(events[0].data.via).toBe("command");
      }
    });

    it("rejects automatically when the command exits non-zero, with the output as the reason", async () => {
      const room = tempRoom();
      const worker = room.join({ name: "w1", role: "worker" }).member;
      const taskId = createTask(room, {
        kind: "command",
        // `&&` rather than `;`: this runs through whatever shell the host
        // has, and cmd.exe treats `;` as an argument separator rather than a
        // command one, so the POSIX spelling passes on Linux and silently
        // exits 0 on Windows.
        command: "echo something went wrong && exit 1",
      });
      claim(room, taskId, worker.id);

      const task = await submitTask(room, worker.id, taskId, { summary: "done" });

      expect(task.state).toBe("rejected");
      expect(task.lastRejection?.reason).toContain("something went wrong");
      expect(isClaimable(task)).toBe(true);
    });

    it("never leaves a submission without a verdict, even the command fails", async () => {
      const room = tempRoom();
      const worker = room.join({ name: "w1", role: "worker" }).member;
      const taskId = createTask(room, { kind: "command", command: "exit 1" });
      claim(room, taskId, worker.id);

      await submitTask(room, worker.id, taskId, { summary: "done" });

      const types = room.log.read().map((e) => e.type);
      const submittedIndex = types.indexOf("task.submitted");
      expect(submittedIndex).toBeGreaterThanOrEqual(0);
      // The very next event has to be the verdict: appendMany landed both as
      // one unit, so nothing else could have been interleaved between them.
      expect(types[submittedIndex + 1]).toBe("task.rejected");
    });
  });

  describe("configured command timeout", () => {
    it("kills the command at the room's commandTimeoutSeconds when the task sets none, and reports a rejection naming the room setting", async () => {
      const room = tempRoom({ config: { commandTimeoutSeconds: 1 } });
      const worker = room.join({ name: "w1", role: "worker" }).member;
      // See the comment on the "sleep 5" test in the runAcceptanceCommand
      // block below for why "sleep" rather than a platform-specific idle
      // command.
      const taskId = createTask(room, { kind: "command", command: "sleep 5" });
      claim(room, taskId, worker.id);

      const task = await submitTask(room, worker.id, taskId, { summary: "done" });

      // A timeout is a rejection with a verdict, never a thrown error — the
      // caller of submitTask gets a task back, not an exception.
      expect(task.state).toBe("rejected");
      expect(task.lastRejection?.reason).toContain("timed out");
      expect(task.lastRejection?.reason).toContain("room's commandTimeoutSeconds");
    }, 10_000);

    it("lets a task's own timeoutSeconds override a much longer room default, and names the task setting", async () => {
      const room = tempRoom({ config: { commandTimeoutSeconds: 60 } });
      const worker = room.join({ name: "w1", role: "worker" }).member;
      const taskId = createTask(room, {
        kind: "command",
        command: "sleep 5",
        timeoutSeconds: 1,
      });
      claim(room, taskId, worker.id);

      const task = await submitTask(room, worker.id, taskId, { summary: "done" });

      expect(task.state).toBe("rejected");
      expect(task.lastRejection?.reason).toContain("timed out");
      expect(task.lastRejection?.reason).toContain("task's own acceptance.timeoutSeconds");
    }, 10_000);
  });

  describe("none acceptance", () => {
    it("is refused in a default room", async () => {
      const room = tempRoom();
      const worker = room.join({ name: "w1", role: "worker" }).member;
      const taskId = createTask(room, { kind: "none" });
      claim(room, taskId, worker.id);

      await expect(
        submitTask(room, worker.id, taskId, { summary: "done" }),
      ).rejects.toThrow(InvalidError);
      expect(readTask(room, taskId).state).toBe("claimed");
    });

    it("auto-accepts in a room with allowUncheckedAcceptance turned on", async () => {
      const room = tempRoom({ config: { allowUncheckedAcceptance: true } });
      const worker = room.join({ name: "w1", role: "worker" }).member;
      const taskId = createTask(room, { kind: "none" });
      claim(room, taskId, worker.id);

      const task = await submitTask(room, worker.id, taskId, { summary: "done" });
      expect(task.state).toBe("accepted");
    });
  });
});

describe("reviewTask", () => {
  it("never lets the submitter accept or reject their own work", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    room.join({ name: "r1", role: "reviewer" });
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "done" });

    expect(() => reviewTask(room, worker.id, taskId, { accept: true })).toThrow(
      PermissionError,
    );
    expect(() =>
      reviewTask(room, worker.id, taskId, { accept: false, reason: "no" }),
    ).toThrow(PermissionError);

    // Still sitting there waiting on somebody else, not silently resolved.
    expect(readTask(room, taskId).state).toBe("submitted");
  });

  it("still refuses a submitter with role human, human role or not", async () => {
    const room = tempRoom();
    const human = room.join({ name: "h1", role: "human" }).member;
    const taskId = createTask(room, { kind: "human" });
    claim(room, taskId, human.id);
    await submitTask(room, human.id, taskId, { summary: "done" });

    expect(() => reviewTask(room, human.id, taskId, { accept: true })).toThrow(
      PermissionError,
    );
    expect(readTask(room, taskId).state).toBe("submitted");
  });

  it("lets a different reviewer accept", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "done" });

    const task = reviewTask(room, reviewer.id, taskId, {
      accept: true,
      note: "looks right",
    });

    expect(task.state).toBe("accepted");
  });

  it("lets a different reviewer reject, which puts the task back on the board and counts the attempt", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "done" });

    const task = reviewTask(room, reviewer.id, taskId, {
      accept: false,
      reason: "missing citations",
    });

    expect(task.state).toBe("rejected");
    expect(task.attempts).toBe(1);
    expect(task.lastRejection).toEqual({
      by: reviewer.id,
      reason: "missing citations",
      at: task.lastRejection?.at,
    });
    expect(isClaimable(task)).toBe(true);
    expect(task.escalated).toBe(false);
  });

  it("escalates and freezes a task after three rejections", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "reviewer" });

    let task: Task | undefined;
    for (let i = 0; i < 3; i++) {
      claim(room, taskId, worker.id);
      await submitTask(room, worker.id, taskId, { summary: `attempt ${i}` });
      task = reviewTask(room, reviewer.id, taskId, {
        accept: false,
        reason: `no (${i})`,
      });
    }

    expect(task?.attempts).toBe(3);
    expect(task?.escalated).toBe(true);
    expect(isClaimable(task!)).toBe(false);

    const escalations = room.log.read({ types: ["task.escalated"] });
    expect(escalations).toHaveLength(1);
  });

  it("refuses a manual verdict on a command task", () => {
    // submitTask always resolves a command task's verdict itself, so the only
    // way to see one sitting in "submitted" is to put it there directly, the
    // way a crash-recovered board or a stray event might. reviewTask has to
    // refuse it regardless of how it got there.
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "command", command: "exit 1" });
    claim(room, taskId, worker.id);
    room.log.append(worker.id, "task.submitted", {
      taskId,
      memberId: worker.id,
      summary: "done",
      artifacts: [],
      basedOnSeq: room.log.head(),
    });

    expect(readTask(room, taskId).state).toBe("submitted");
    expect(() => reviewTask(room, reviewer.id, taskId, { accept: true })).toThrow(
      PermissionError,
    );
  });

  it("requires the reviewer role (or human) for reviewer-kind tasks", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const otherWorker = room.join({ name: "w2", role: "worker" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "done" });

    expect(() =>
      reviewTask(room, otherWorker.id, taskId, { accept: true }),
    ).toThrow(PermissionError);
  });

  it("requires the human role specifically for human-kind tasks", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "human" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "done" });

    expect(() => reviewTask(room, reviewer.id, taskId, { accept: true })).toThrow(
      PermissionError,
    );
  });

  it("fails to review a task that is not submitted", () => {
    const room = tempRoom();
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "reviewer" });

    expect(() => reviewTask(room, reviewer.id, taskId, { accept: true })).toThrow(
      InvalidError,
    );
  });
});

describe("runAcceptanceCommand", () => {
  it("kills a hanging command at the timeout and counts it as a failure", async () => {
    const room = tempRoom();
    const task = {
      ...readTaskShapeStub(),
      acceptance: { kind: "command", command: "sleep 5" } as const,
    };

    const result = await runAcceptanceCommand(room, task, 200);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("timed out");
  }, 10_000);

  it("truncates very long output", async () => {
    const room = tempRoom();
    const task = {
      ...readTaskShapeStub(),
      acceptance: {
        kind: "command",
        command: "node -e \"process.stdout.write('x'.repeat(20000))\"",
      } as const,
    };

    const result = await runAcceptanceCommand(room, task, 5_000);

    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThan(20_000);
    expect(result.output).toContain("truncated");
  });

  it("makes the expected-output contract available to the command", async () => {
    const room = tempRoom();
    const task = {
      ...readTaskShapeStub(),
      expectedOutput: {
        description: "A JSON object with a summary.",
        schema: { type: "object", required: ["summary"] },
      },
      acceptance: {
        kind: "command",
        command:
          "node -e \"process.stdout.write(process.env.ATRIUM_EXPECTED_OUTPUT + '|' + process.env.ATRIUM_EXPECTED_OUTPUT_SCHEMA)\"",
      } as const,
    };

    const result = await runAcceptanceCommand(room, task, 5_000);

    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      'A JSON object with a summary.|{"type":"object","required":["summary"]}',
    );
  });

  it("refuses to run a non-command task", async () => {
    const room = tempRoom();
    const task = { ...readTaskShapeStub(), acceptance: { kind: "reviewer" } as const };

    await expect(runAcceptanceCommand(room, task)).rejects.toThrow(InvalidError);
  });
});

describe("pendingReview", () => {
  it("lists tasks waiting on a verdict and drops them once reviewed", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer = room.join({ name: "r1", role: "reviewer" }).member;
    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);

    expect(pendingReview(room)).toHaveLength(0);

    await submitTask(room, worker.id, taskId, { summary: "done" });
    expect(pendingReview(room).map((t) => t.id)).toEqual([taskId]);

    reviewTask(room, reviewer.id, taskId, { accept: true });
    expect(pendingReview(room)).toHaveLength(0);
  });
});

/**
 * A minimal task shape for exercising `runAcceptanceCommand` directly,
 * without going through the whole claim/submit dance — the function only
 * looks at `id` and `acceptance`.
 */
function readTaskShapeStub(): Task {
  return {
    id: "task_stub",
    title: "stub",
    description: "",
    dependsOn: [],
    acceptance: { kind: "reviewer" },
    state: "claimed",
    createdBy: "system",
    createdAt: now(),
    attempts: 0,
    escalated: false,
    seq: 0,
  };
}

describe("two reviewers reaching the same task at once", () => {
  it("counts only one of two competing rejections", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    const reviewer1 = room.join({ name: "r1", role: "reviewer" }).member;
    const reviewer2 = room.join({ name: "r2", role: "reviewer" }).member;

    const taskId = createTask(room, { kind: "reviewer" });
    claim(room, taskId, worker.id);
    await submitTask(room, worker.id, taskId, { summary: "have a look" });

    // A second connection onto the same room, the way a second reviewer in its
    // own process would open it.
    const other = Room.open(room.dir);
    try {
      const outcomes = [
        { room, actorId: reviewer1.id },
        { room: other, actorId: reviewer2.id },
      ].map(({ room: handle, actorId }) => {
        try {
          reviewTask(handle, actorId, taskId, {
            accept: false,
            reason: "not good enough",
          });
          return "recorded";
        } catch {
          return "refused";
        }
      });

      expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "refused")).toHaveLength(1);

      // The attempt counter moved by one, not two, so the task did not burn an
      // extra go towards being frozen.
      //
      // Note what this does and does not show. node:sqlite is synchronous, so
      // these two calls cannot genuinely overlap in one process: the second
      // reviewer reads a task that is already rejected and is turned away on
      // state alone. What is pinned down here is the behaviour. The reason it
      // also holds for two real processes, where the reads *can* interleave, is
      // that reviewTask does its read and its append inside one transaction.
      expect(readTask(room, taskId).attempts).toBe(1);
      expect(room.log.read({ types: ["task.rejected"] })).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});
