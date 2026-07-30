import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import {
  ConflictError,
  HaltedError,
  InvalidError,
  NotFoundError,
  PermissionError,
} from "./errors.js";
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  releaseTask,
  renewClaim,
  sweepExpiredClaims,
} from "./board.js";

const created: Array<{ rooms: Room[]; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-board-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ rooms: [room], dir });
  return room;
}

/** A second connection to a room already opened by `tempRoom`, tracked for cleanup. */
function reopen(room: Room): Room {
  const again = Room.open(room.dir);
  const entry = created.find((e) => e.rooms.includes(room));
  entry?.rooms.push(again);
  return again;
}

afterEach(() => {
  vi.useRealTimers();
  while (created.length) {
    const entry = created.pop()!;
    for (const room of entry.rooms) {
      try {
        room.close();
      } catch {
        // already closed
      }
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe("createTask", () => {
  it("puts a task on the board with the documented defaults", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    const task = createTask(room, worker.id, { title: "  Draft the memo  " });

    expect(task.id).toMatch(/^task_/);
    expect(task.title).toBe("Draft the memo");
    expect(task.description).toBe("");
    expect(task.dependsOn).toEqual([]);
    expect(task.acceptance).toEqual({ kind: "reviewer" });
    expect(task.state).toBe("open");
  });

  it("refuses an empty title", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() => createTask(room, worker.id, { title: "   " })).toThrow(
      InvalidError,
    );
  });

  it("records an expected-output contract with an optional JSON schema", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    const task = createTask(room, worker.id, {
      title: "Draft the memo",
      expectedOutput: {
        description: "A concise memo with a recommendation.",
        schema: {
          type: "object",
          required: ["recommendation"],
          properties: { recommendation: { type: "string" } },
        },
      },
    });

    expect(task.expectedOutput).toEqual({
      description: "A concise memo with a recommendation.",
      schema: {
        type: "object",
        required: ["recommendation"],
        properties: { recommendation: { type: "string" } },
      },
    });
  });

  it("refuses an expected-output contract without prose", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() =>
      createTask(room, worker.id, {
        title: "Draft",
        expectedOutput: { description: "   " },
      }),
    ).toThrow(/expectedOutput\.description/);
  });

  it("requires every dependency to already exist", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() =>
      createTask(room, worker.id, { title: "draft", dependsOn: ["typo"] }),
    ).toThrow(NotFoundError);
  });

  it("accepts a dependency that was created earlier", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const research = createTask(room, worker.id, { title: "research" });

    const draft = createTask(room, worker.id, {
      title: "draft",
      dependsOn: [research.id],
    });
    expect(draft.dependsOn).toEqual([research.id]);
  });

  it('refuses "none" acceptance unless the room allows it', () => {
    const strict = tempRoom();
    const worker = strict.join({ name: "scout", role: "worker" }).member;
    expect(() =>
      createTask(strict, worker.id, {
        title: "draft",
        acceptance: { kind: "none" },
      }),
    ).toThrow(InvalidError);

    const lenient = tempRoom({ config: { allowUncheckedAcceptance: true } });
    const worker2 = lenient.join({ name: "scout", role: "worker" }).member;
    const task = createTask(lenient, worker2.id, {
      title: "draft",
      acceptance: { kind: "none" },
    });
    expect(task.acceptance).toEqual({ kind: "none" });
  });

  it('requires a "command" acceptance to carry a real command', () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() =>
      createTask(room, worker.id, {
        title: "draft",
        acceptance: { kind: "command", command: "   " },
      }),
    ).toThrow(InvalidError);

    const task = createTask(room, worker.id, {
      title: "draft",
      acceptance: { kind: "command", command: "npm test" },
    });
    expect(task.acceptance).toEqual({ kind: "command", command: "npm test" });
  });

  it("accepts a per-task timeoutSeconds override on a command acceptance", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    const task = createTask(room, worker.id, {
      title: "full suite",
      acceptance: { kind: "command", command: "npm test", timeoutSeconds: 300 },
    });

    expect(task.acceptance).toEqual({
      kind: "command",
      command: "npm test",
      timeoutSeconds: 300,
    });
  });

  it.each([0, -5, NaN, Infinity])(
    "refuses a command acceptance's timeoutSeconds of %p",
    (timeoutSeconds) => {
      const room = tempRoom();
      const worker = room.join({ name: "scout", role: "worker" }).member;

      expect(() =>
        createTask(room, worker.id, {
          title: "draft",
          acceptance: { kind: "command", command: "npm test", timeoutSeconds },
        }),
      ).toThrow(InvalidError);
    },
  );

  it("stops once the room's action budget is spent", () => {
    // room.created + member.joined leaves no room in a budget of 2.
    const room = tempRoom({ config: { actionBudget: 2 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    expect(() => createTask(room, worker.id, { title: "draft" })).toThrow(
      HaltedError,
    );
  });
});

describe("listTasks and getTask", () => {
  it("filters by state, claimant, and claimability", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const t1 = createTask(room, worker.id, { title: "t1" });
    const t2 = createTask(room, worker.id, { title: "t2" });
    claimTask(room, worker.id, t1.id);

    expect(listTasks(room, { state: "claimed" }).map((t) => t.id)).toEqual([
      t1.id,
    ]);
    expect(listTasks(room, { claimedBy: worker.id }).map((t) => t.id)).toEqual([
      t1.id,
    ]);
    expect(listTasks(room, { claimable: true }).map((t) => t.id)).toEqual([
      t2.id,
    ]);
  });

  it("finds a single task by id and complains about ids it does not know", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const t1 = createTask(room, worker.id, { title: "t1" });

    expect(getTask(room, t1.id).id).toBe(t1.id);
    expect(() => getTask(room, "task_does_not_exist")).toThrow(NotFoundError);
  });
});

describe("dependencies", () => {
  it("blocks a claim until the dependency is accepted, then unblocks it", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const reviewer = room.join({ name: "rev", role: "reviewer" }).member;

    const research = createTask(room, worker.id, { title: "research" });
    const draft = createTask(room, worker.id, {
      title: "draft",
      dependsOn: [research.id],
    });

    expect(getTask(room, draft.id).state).toBe("blocked");
    expect(() => claimTask(room, worker.id, draft.id)).toThrow(ConflictError);

    // Accepting the dependency is not this module's job, but the board has to
    // react correctly once it happens, so write the event directly.
    room.log.append(reviewer.id, "task.accepted", {
      taskId: research.id,
      by: reviewer.id,
      via: "reviewer",
    });

    expect(getTask(room, draft.id).state).toBe("open");
    const claimed = claimTask(room, worker.id, draft.id);
    expect(claimed.state).toBe("claimed");
  });
});

describe("claiming", () => {
  it("only lets workers and humans claim", () => {
    const room = tempRoom();
    const reviewer = room.join({ name: "rev", role: "reviewer" }).member;
    const task = createTask(room, reviewer.id, { title: "draft" });

    expect(() => claimTask(room, reviewer.id, task.id)).toThrow(
      PermissionError,
    );
  });

  it("refuses to claim a task that is already claimed, submitted, or accepted", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const other = room.join({ name: "other", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    claimTask(room, worker.id, task.id);
    expect(() => claimTask(room, other.id, task.id)).toThrow(ConflictError);

    room.log.append(worker.id, "task.submitted", {
      taskId: task.id,
      memberId: worker.id,
      summary: "done",
      artifacts: [],
      basedOnSeq: room.log.head(),
    });
    expect(() => claimTask(room, other.id, task.id)).toThrow(ConflictError);
  });

  it("refuses to claim an escalated task, and says so", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    room.log.append("system", "task.escalated", {
      taskId: task.id,
      attempts: room.config.maxAttempts,
    });

    expect(() => claimTask(room, worker.id, task.id)).toThrow(InvalidError);
    expect(() => claimTask(room, worker.id, task.id)).toThrow(/escalated/);
  });

  it("sets a claim that expires claimSeconds from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { claimSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    const claimed = claimTask(room, worker.id, task.id);
    expect(claimed.claimExpiresAt).toBe("2026-01-01T00:01:00.000Z");

    // Still within the lease: nobody else can take it.
    const other = room.join({ name: "other", role: "worker" }).member;
    expect(() => claimTask(room, other.id, task.id)).toThrow(ConflictError);

    // Past the lease: the board frees it on its own, no sweep required.
    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    expect(getTask(room, task.id).state).toBe("open");
    const reclaimed = claimTask(room, other.id, task.id);
    expect(reclaimed.claimedBy).toBe(other.id);
  });
});

describe("releasing", () => {
  it("lets the claim holder release voluntarily", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    const released = releaseTask(room, worker.id, task.id);
    expect(released.state).toBe("open");

    const events = room.log.read({ types: ["task.released"] });
    expect(events).toHaveLength(1);
    if (events[0]?.type === "task.released") {
      expect(events[0].data.reason).toBe("voluntary");
    }
  });

  it("lets a human release someone else's claim", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const human = room.join({ name: "nick", role: "human" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    expect(releaseTask(room, human.id, task.id).state).toBe("open");
  });

  it("refuses to let another worker release a claim that is not theirs", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const other = room.join({ name: "other", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    expect(() => releaseTask(room, other.id, task.id)).toThrow(
      PermissionError,
    );
  });

  it("refuses to release a task that is not claimed", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    expect(() => releaseTask(room, worker.id, task.id)).toThrow(InvalidError);
  });
});

describe("renewClaim", () => {
  it("extends the expiry and keeps the task claimed past its original window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { claimSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    // Halfway through the original window, renew it.
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    const renewed = renewClaim(room, worker.id, task.id);
    expect(renewed.claimExpiresAt).toBe("2026-01-01T00:01:30.000Z");
    expect(renewed.claimedBy).toBe(worker.id);
    expect(renewed.state).toBe("claimed");

    // Past the original expiry (00:01:00) but within the renewed one: still
    // claimed, and still by the same worker — the whole point of renewing.
    vi.setSystemTime(new Date("2026-01-01T00:01:15.000Z"));
    expect(getTask(room, task.id).state).toBe("claimed");
    expect(getTask(room, task.id).claimedBy).toBe(worker.id);

    const other = room.join({ name: "other", role: "worker" }).member;
    expect(() => claimTask(room, other.id, task.id)).toThrow(ConflictError);
  });

  it("refuses a non-holder, distinctly from an unclaimed task", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const other = room.join({ name: "other", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    expect(() => renewClaim(room, other.id, task.id)).toThrow(
      PermissionError,
    );
    expect(() => renewClaim(room, other.id, task.id)).toThrow(/not you/);
  });

  it("refuses a task that was never claimed", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    expect(() => renewClaim(room, worker.id, task.id)).toThrow(InvalidError);
    expect(() => renewClaim(room, worker.id, task.id)).toThrow(/not claimed/);
  });

  it("refuses an unknown task id", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() => renewClaim(room, worker.id, "task_does_not_exist")).toThrow(
      NotFoundError,
    );
  });

  it("refuses a claim that has already lapsed, distinctly from the other two cases, and does not resurrect it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { claimSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    // Past the claim's expiry: the board already reads this as open.
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    expect(getTask(room, task.id).state).toBe("open");

    let error: unknown;
    try {
      renewClaim(room, worker.id, task.id);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toMatch(/expired/);
    expect((error as ConflictError).message).not.toMatch(/not claimed/);
    expect((error as ConflictError).message).not.toMatch(/not you/);

    // Refusing it left the task open, exactly as the live board already
    // showed — renewClaim did not quietly extend a claim that had died.
    expect(getTask(room, task.id).state).toBe("open");

    // Somebody else can now claim it fresh, through the ordinary CAS path —
    // renewClaim pointed here rather than reviving the old claim itself.
    const other = room.join({ name: "other", role: "worker" }).member;
    const reclaimed = claimTask(room, other.id, task.id);
    expect(reclaimed.claimedBy).toBe(other.id);

    // And the original holder trying to renew now correctly sees "claimed by
    // somebody else", not "already lapsed" — the lapse is old news once a new
    // claim exists.
    expect(() => renewClaim(room, worker.id, task.id)).toThrow(
      PermissionError,
    );
  });
});

describe("sweepExpiredClaims", () => {
  it("writes down a lease-expired release for each lapsed claim, and is safe to call twice", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { claimSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    const firstSweep = sweepExpiredClaims(room);
    expect(firstSweep.map((t) => t.id)).toEqual([task.id]);

    const releases = room.log.read({ types: ["task.released"] });
    expect(releases).toHaveLength(1);
    if (releases[0]?.type === "task.released") {
      expect(releases[0].data.reason).toBe("lease-expired");
    }

    const secondSweep = sweepExpiredClaims(room);
    expect(secondSweep).toEqual([]);
    expect(room.log.read({ types: ["task.released"] })).toHaveLength(1);
  });

  it("leaves claims that have not expired alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { claimSeconds: 600 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    expect(sweepExpiredClaims(room)).toEqual([]);
    expect(getTask(room, task.id).state).toBe("claimed");
  });
});

describe("concurrent claims from two connections", () => {
  it("lets exactly one of two connections to the same room win a claim", () => {
    const room1 = tempRoom();
    const worker1 = room1.join({ name: "alice", role: "worker" }).member;
    const worker2 = room1.join({ name: "bob", role: "worker" }).member;
    const task = createTask(room1, worker1.id, { title: "draft" });

    // Two independent SQLite connections onto the same room directory, the
    // way two separate agent processes would each open their own handle.
    const room2 = reopen(room1);

    const results = [
      { name: "alice", room: room1, actorId: worker1.id },
      { name: "bob", room: room2, actorId: worker2.id },
    ].map(({ name, room, actorId }) => {
      try {
        return { name, task: claimTask(room, actorId, task.id), error: null as unknown };
      } catch (err) {
        return { name, task: null, error: err };
      }
    });

    const winners = results.filter((r) => r.task !== null);
    const losers = results.filter((r) => r.task === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.error).toBeInstanceOf(ConflictError);

    const claims = room1.log.read({ types: ["task.claimed"] }).filter((e) => {
      return e.type === "task.claimed" && e.data.taskId === task.id;
    });
    expect(claims).toHaveLength(1);
  });
});
