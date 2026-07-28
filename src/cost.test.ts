import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { costSummary, foldCosts, reportCost, spendTotals } from "./cost.js";
import { HaltedError, InvalidError, NotFoundError } from "./errors.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-cost-"));
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
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

function worker(room: Room, name: string) {
  return room.join({ name, role: "worker" }).member;
}

describe("reportCost", () => {
  it("accumulates across members, per-member and for the room", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");

    reportCost(room, a.id, { amountUsd: 1.5 });
    reportCost(room, a.id, { amountUsd: 2.25 });
    reportCost(room, b.id, { amountUsd: 4 });

    const totals = spendTotals(room);
    expect(totals.perMember[a.id]).toBeCloseTo(3.75);
    expect(totals.perMember[b.id]).toBeCloseTo(4);
    expect(totals.room).toBeCloseTo(7.75);
  });

  it("records model, tokens, and a note when given", () => {
    const room = tempRoom();
    const a = worker(room, "a");

    const event = reportCost(room, a.id, {
      amountUsd: 0.02,
      model: "claude-sonnet",
      inputTokens: 100,
      outputTokens: 50,
      note: "draft pass",
    });

    expect(event.data.model).toBe("claude-sonnet");
    expect(event.data.inputTokens).toBe(100);
    expect(event.data.outputTokens).toBe(50);
    expect(event.data.note).toBe("draft pass");
  });

  it("rejects a negative amount", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => reportCost(room, a.id, { amountUsd: -1 })).toThrow(InvalidError);
    expect(spendTotals(room).room).toBe(0);
  });

  it("rejects NaN and non-finite amounts", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => reportCost(room, a.id, { amountUsd: NaN })).toThrow(InvalidError);
    expect(() => reportCost(room, a.id, { amountUsd: Infinity })).toThrow(InvalidError);
    expect(spendTotals(room).room).toBe(0);
  });

  it("rejects a report from a member who does not exist", () => {
    const room = tempRoom();
    expect(() => reportCost(room, "member_nope", { amountUsd: 1 })).toThrow(
      NotFoundError,
    );
  });

  it("does nothing to a room that never set a cap, however much is reported", () => {
    const room = tempRoom();
    const a = worker(room, "a");

    reportCost(room, a.id, { amountUsd: 1_000_000 });

    expect(room.isHalted()).toBe(false);
    // Everything else still works exactly as it did before cost accounting.
    expect(() => room.join({ name: "b", role: "worker" })).not.toThrow();
  });

  it("halts the room once the room-wide cap is crossed, but the crossing report still lands", () => {
    const room = tempRoom({ config: { roomSpendCapUsd: 10 } });
    const a = worker(room, "a");

    reportCost(room, a.id, { amountUsd: 6 });
    expect(room.isHalted()).toBe(false);

    reportCost(room, a.id, { amountUsd: 5 }); // 11 > 10, crosses the cap

    expect(room.isHalted()).toBe(true);
    expect(spendTotals(room).room).toBeCloseTo(11); // the report that crossed it still landed

    expect(() => worker(room, "b")).toThrow(HaltedError);
  });

  it("halts the room once a member's own cap is crossed", () => {
    const room = tempRoom({ config: { memberSpendCapUsd: 5 } });
    const a = worker(room, "a");
    const b = worker(room, "b");

    reportCost(room, b.id, { amountUsd: 3 }); // under b's cap, room stays open
    expect(room.isHalted()).toBe(false);

    reportCost(room, a.id, { amountUsd: 6 }); // over a's cap alone

    expect(room.isHalted()).toBe(true);
    expect(spendTotals(room).perMember[a.id]).toBeCloseTo(6);
    expect(() => reportCost(room, b.id, { amountUsd: 1 })).toThrow(HaltedError);
  });

  it("refuses to report at all once the room is already halted", () => {
    const room = tempRoom({ config: { roomSpendCapUsd: 1 } });
    const a = worker(room, "a");

    reportCost(room, a.id, { amountUsd: 2 }); // crosses the cap and halts
    expect(room.isHalted()).toBe(true);

    expect(() => reportCost(room, a.id, { amountUsd: 0.01 })).toThrow(HaltedError);
    // The failed attempt did not add to the total.
    expect(spendTotals(room).room).toBeCloseTo(2);
  });
});

describe("foldCosts", () => {
  it("survives a replay from the log, not just a live room", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");

    reportCost(room, a.id, { amountUsd: 1 });
    reportCost(room, b.id, { amountUsd: 2 });
    reportCost(room, a.id, { amountUsd: 3 });

    const events = room.log.read({ types: ["cost.reported"] });
    const totals = foldCosts(events);

    expect(totals.room).toBeCloseTo(6);
    expect(totals.perMember[a.id]).toBeCloseTo(4);
    expect(totals.perMember[b.id]).toBeCloseTo(2);

    // Reopening the room folds from disk and gets the same answer.
    room.close();
    const reopened = Room.open(room.dir);
    try {
      expect(spendTotals(reopened).room).toBeCloseTo(6);
    } finally {
      reopened.close();
    }
  });
});

describe("costSummary", () => {
  it("lists only members who have reported, with names and caps", () => {
    const room = tempRoom({ config: { roomSpendCapUsd: 100, memberSpendCapUsd: 40 } });
    const a = worker(room, "alice");
    worker(room, "bob"); // never reports, so never appears

    reportCost(room, a.id, { amountUsd: 12 });

    const summary = costSummary(room);
    expect(summary.roomCapUsd).toBe(100);
    expect(summary.roomTotalUsd).toBeCloseTo(12);
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0]).toMatchObject({ name: "alice", capUsd: 40 });
    expect(summary.members[0]?.totalUsd).toBeCloseTo(12);
  });

  it("reports 0 caps for a room that never configured any", () => {
    const room = tempRoom();
    const summary = costSummary(room);
    expect(summary.roomCapUsd).toBe(0);
    expect(summary.members).toHaveLength(0);
  });
});
