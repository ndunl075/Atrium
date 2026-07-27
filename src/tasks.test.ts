import { describe, expect, it } from "vitest";

import { foldTasks, isClaimable, needsEscalation } from "./tasks.js";
import type { AnyEvent, EventMap, EventType } from "./types.js";

let seq = 0;
function ev<T extends EventType>(
  type: T,
  data: EventMap[T],
  actor = "m1",
  ts = "2026-01-01T00:00:00.000Z",
): AnyEvent {
  return { seq: ++seq, ts, actor, type, data } as AnyEvent;
}

function created(id: string, dependsOn: string[] = []) {
  return ev("task.created", {
    taskId: id,
    title: id,
    description: "",
    dependsOn,
    acceptance: { kind: "reviewer" },
  });
}

const AT = "2026-01-01T00:10:00.000Z";
const OPTS = { maxAttempts: 3, at: AT };

describe("foldTasks", () => {
  it("starts a new task open", () => {
    const tasks = foldTasks([created("t1")], OPTS);
    expect(tasks.get("t1")?.state).toBe("open");
    expect(tasks.get("t1")?.attempts).toBe(0);
  });

  it("follows a task through to accepted", () => {
    const tasks = foldTasks(
      [
        created("t1"),
        ev("task.claimed", {
          taskId: "t1",
          memberId: "worker",
          expiresAt: "2026-01-01T01:00:00.000Z",
        }),
        ev("task.submitted", {
          taskId: "t1",
          memberId: "worker",
          summary: "done",
          artifacts: ["draft.md"],
          basedOnSeq: 4,
        }),
        ev("task.accepted", { taskId: "t1", by: "reviewer", via: "reviewer" }),
      ],
      OPTS,
    );

    const task = tasks.get("t1")!;
    expect(task.state).toBe("accepted");
    expect(task.submittedArtifacts).toEqual(["draft.md"]);
  });

  it("puts rejected work back on the board and counts the attempt", () => {
    const tasks = foldTasks(
      [
        created("t1"),
        ev("task.claimed", {
          taskId: "t1",
          memberId: "worker",
          expiresAt: "2026-01-01T01:00:00.000Z",
        }),
        ev("task.submitted", {
          taskId: "t1",
          memberId: "worker",
          summary: "done",
          artifacts: [],
          basedOnSeq: 2,
        }),
        ev("task.rejected", {
          taskId: "t1",
          by: "reviewer",
          via: "reviewer",
          reason: "no sources",
        }),
      ],
      OPTS,
    );

    const task = tasks.get("t1")!;
    expect(task.state).toBe("rejected");
    expect(task.attempts).toBe(1);
    expect(task.lastRejection?.reason).toBe("no sources");
    expect(task.claimedBy).toBeUndefined();
    expect(isClaimable(task)).toBe(true);
  });

  it("frees a task whose claim has run out", () => {
    const tasks = foldTasks(
      [
        created("t1"),
        ev("task.claimed", {
          taskId: "t1",
          memberId: "worker",
          expiresAt: "2026-01-01T00:05:00.000Z",
        }),
      ],
      OPTS,
    );

    const task = tasks.get("t1")!;
    expect(task.state).toBe("open");
    expect(task.claimedBy).toBeUndefined();
  });

  it("leaves a claim alone while it is still in date", () => {
    const tasks = foldTasks(
      [
        created("t1"),
        ev("task.claimed", {
          taskId: "t1",
          memberId: "worker",
          expiresAt: "2026-01-01T00:30:00.000Z",
        }),
      ],
      OPTS,
    );

    expect(tasks.get("t1")?.state).toBe("claimed");
    expect(tasks.get("t1")?.claimedBy).toBe("worker");
  });

  it("does not free submitted work just because the claim lapsed", () => {
    const tasks = foldTasks(
      [
        created("t1"),
        ev("task.claimed", {
          taskId: "t1",
          memberId: "worker",
          expiresAt: "2026-01-01T00:05:00.000Z",
        }),
        ev("task.submitted", {
          taskId: "t1",
          memberId: "worker",
          summary: "done",
          artifacts: [],
          basedOnSeq: 2,
        }),
      ],
      OPTS,
    );

    expect(tasks.get("t1")?.state).toBe("submitted");
  });
});

describe("dependencies", () => {
  it("blocks a task until what it depends on is accepted", () => {
    const events = [created("research"), created("draft", ["research"])];
    let tasks = foldTasks(events, OPTS);

    expect(tasks.get("draft")?.state).toBe("blocked");
    expect(tasks.get("draft")?.waitingOn).toEqual(["research"]);
    expect(isClaimable(tasks.get("draft")!)).toBe(false);

    tasks = foldTasks(
      [
        ...events,
        ev("task.accepted", {
          taskId: "research",
          by: "reviewer",
          via: "reviewer",
        }),
      ],
      OPTS,
    );

    expect(tasks.get("draft")?.state).toBe("open");
    expect(tasks.get("draft")?.waitingOn).toBeUndefined();
  });

  it("stays blocked when a dependency was only submitted, not accepted", () => {
    const tasks = foldTasks(
      [
        created("research"),
        created("draft", ["research"]),
        ev("task.submitted", {
          taskId: "research",
          memberId: "worker",
          summary: "",
          artifacts: [],
          basedOnSeq: 1,
        }),
      ],
      OPTS,
    );

    expect(tasks.get("draft")?.state).toBe("blocked");
  });

  it("treats a dependency on a task that does not exist as unfinished", () => {
    const tasks = foldTasks([created("draft", ["typo"])], OPTS);
    expect(tasks.get("draft")?.state).toBe("blocked");
    expect(tasks.get("draft")?.waitingOn).toEqual(["typo"]);
  });
});

describe("escalation", () => {
  it("is due once rejections reach the room's limit", () => {
    const events: AnyEvent[] = [created("t1")];
    for (let i = 0; i < 3; i++) {
      events.push(
        ev("task.rejected", {
          taskId: "t1",
          by: "reviewer",
          via: "reviewer",
          reason: `no (${i})`,
        }),
      );
    }

    const task = foldTasks(events, OPTS).get("t1")!;
    expect(task.attempts).toBe(3);
    expect(needsEscalation(task, 3)).toBe(true);
    expect(needsEscalation(task, 5)).toBe(false);
  });

  it("freezes a task once it has been escalated", () => {
    const tasks = foldTasks(
      [created("t1"), ev("task.escalated", { taskId: "t1", attempts: 3 })],
      OPTS,
    );

    const task = tasks.get("t1")!;
    expect(task.escalated).toBe(true);
    expect(isClaimable(task)).toBe(false);
    expect(needsEscalation(task, 3)).toBe(false);
  });
});

describe("replay", () => {
  it("shows the board as it was, not as it is now", () => {
    const events = [
      created("t1"),
      ev("task.claimed", {
        taskId: "t1",
        memberId: "worker",
        expiresAt: "2026-01-01T00:20:00.000Z",
      }),
    ];

    // Asked about a moment while the claim was still good.
    expect(
      foldTasks(events, { maxAttempts: 3, at: "2026-01-01T00:10:00.000Z" }).get(
        "t1",
      )?.state,
    ).toBe("claimed");

    // Asked about a moment after it lapsed.
    expect(
      foldTasks(events, { maxAttempts: 3, at: "2026-01-01T09:00:00.000Z" }).get(
        "t1",
      )?.state,
    ).toBe("open");
  });

  it("ignores events for tasks it has never heard of", () => {
    const tasks = foldTasks(
      [ev("task.accepted", { taskId: "ghost", by: "r", via: "reviewer" })],
      OPTS,
    );
    expect(tasks.size).toBe(0);
  });
});
