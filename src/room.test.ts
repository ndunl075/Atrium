import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { HaltedError, NotFoundError, PermissionError } from "./errors.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-room-"));
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

describe("Room.create", () => {
  it("lays out the room and records that it was created", () => {
    const room = tempRoom({ name: "research" });

    expect(existsSync(room.paths.config)).toBe(true);
    expect(existsSync(room.paths.db)).toBe(true);
    expect(existsSync(room.paths.context)).toBe(true);
    expect(Room.isRoom(room.dir)).toBe(true);

    const [event] = room.log.read();
    expect(event?.type).toBe("room.created");
    expect(room.config.name).toBe("research");
  });

  it("uses the documented defaults", () => {
    const room = tempRoom();
    expect(room.config.allowUncheckedAcceptance).toBe(false);
    expect(room.config.maxAttempts).toBe(3);
    expect(room.config.leaseSeconds).toBe(300);
  });

  it("takes settings that differ from the defaults", () => {
    const room = tempRoom({ config: { maxAttempts: 1, leaseSeconds: 30 } });
    expect(room.config.maxAttempts).toBe(1);
    expect(room.config.leaseSeconds).toBe(30);
  });

  it("will not create a room on top of an existing one", () => {
    const room = tempRoom();
    expect(() => Room.create(room.dir)).toThrow(/already a room/);
  });

  it("refuses to open a directory that is not a room", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-empty-"));
    try {
      expect(() => Room.open(dir)).toThrow(NotFoundError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens with its settings and history intact", () => {
    const room = tempRoom({ name: "reopen-me", config: { maxAttempts: 7 } });
    room.join({ name: "scout", role: "worker" });
    room.close();

    const again = Room.open(room.dir);
    try {
      expect(again.config.name).toBe("reopen-me");
      expect(again.config.maxAttempts).toBe(7);
      expect(again.roster()).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});

describe("membership", () => {
  it("adds a member and hands back a token that identifies them", () => {
    const room = tempRoom();
    const { member, token } = room.join({
      name: "scout",
      role: "worker",
      manifest: "finds sources",
      tags: ["research"],
    });

    expect(member.role).toBe("worker");
    expect(member.active).toBe(true);
    expect(room.authenticate(token).id).toBe(member.id);
  });

  it("rejects an unknown token", () => {
    const room = tempRoom();
    expect(() => room.authenticate("not-a-real-token")).toThrow(PermissionError);
  });

  it("does not keep the raw token on disk", () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    expect(readFileSync(room.paths.tokens, "utf8")).not.toContain(token);
  });

  it("keeps members in the roster after they leave, marked inactive", () => {
    const room = tempRoom();
    const { member } = room.join({ name: "scout", role: "worker" });
    room.leave(member.id);

    const roster = room.roster();
    expect(roster).toHaveLength(1);
    expect(roster[0]?.active).toBe(false);
  });

  it("checks roles", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const human = room.join({ name: "nick", role: "human" }).member;

    expect(() => room.requireRole(worker.id, ["reviewer", "human"])).toThrow(
      PermissionError,
    );
    expect(room.requireRole(human.id, ["reviewer", "human"]).name).toBe("nick");
  });

  it("rejects a member with no name or an unknown role", () => {
    const room = tempRoom();
    expect(() => room.join({ name: "  ", role: "worker" })).toThrow(/needs a name/);
    expect(() =>
      room.join({ name: "x", role: "supervisor" as never }),
    ).toThrow(/Unknown role/);
  });
});

describe("action budget", () => {
  it("spends the budget one event at a time", () => {
    // Creating the room is itself an event, so a budget of 3 leaves room for
    // exactly two joins.
    const room = tempRoom({ config: { actionBudget: 3 } });

    room.join({ name: "a", role: "worker" });
    room.join({ name: "b", role: "worker" });
    expect(() => room.join({ name: "c", role: "worker" })).toThrow(HaltedError);
  });

  it("stops the room once the budget is gone and writes down why", () => {
    const room = tempRoom({ config: { actionBudget: 2 } });

    room.join({ name: "a", role: "worker" });
    expect(() => room.join({ name: "b", role: "worker" })).toThrow(HaltedError);

    expect(room.isHalted()).toBe(true);
    expect(() => room.assertUsable()).toThrow(/used up its action budget/);

    const halted = room.log.read({ types: ["room.halted"] });
    expect(halted).toHaveLength(1);
    if (halted[0]?.type === "room.halted") {
      expect(halted[0].data.reason).toMatch(/limit of 2 actions/);
    }
  });

  it("stays readable after it stops", () => {
    const room = tempRoom({ config: { actionBudget: 2 } });
    room.join({ name: "a", role: "worker" });
    expect(() => room.join({ name: "b", role: "worker" })).toThrow(HaltedError);

    expect(room.roster()).toHaveLength(1);
    expect(room.log.read().length).toBeGreaterThan(0);
  });
});
