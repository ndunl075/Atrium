import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { HaltedError, NotFoundError, PermissionError } from "./errors.js";
import { sha256 } from "./util.js";

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

  it("fills in settings a room predating them was never written with", () => {
    const room = tempRoom({ name: "old-room" });
    room.close();

    // A room created before a config field existed, written back without it.
    const stored = JSON.parse(readFileSync(room.paths.config, "utf8")) as Record<string, unknown>;
    delete stored["roomSpendCapUsd"];
    delete stored["maxAttempts"];
    delete stored["commandTimeoutSeconds"];
    writeFileSync(room.paths.config, JSON.stringify(stored, null, 2), "utf8");

    const again = Room.open(room.dir);
    try {
      // The default, not `undefined`: RoomConfig says these are numbers, and
      // every reader is entitled to believe it.
      expect(again.config.roomSpendCapUsd).toBe(0);
      expect(again.config.maxAttempts).toBe(3);
      // A room from before commandTimeoutSeconds existed gets exactly the
      // limit every command acceptance had before this setting existed, so
      // opening an old room changes nothing about how its tasks behave.
      expect(again.config.commandTimeoutSeconds).toBe(60);
      // Settings that were on disk still win over the defaults.
      expect(again.config.name).toBe("old-room");
    } finally {
      again.close();
    }
  });
});

describe("updateConfig", () => {
  it("changes a setting on the open room immediately", () => {
    const room = tempRoom();
    const updated = room.updateConfig({ maxAttempts: 5 });
    expect(updated.maxAttempts).toBe(5);
    expect(room.config.maxAttempts).toBe(5);
  });

  it("persists the change so a reopened room sees it, not just the handle that made it", () => {
    const room = tempRoom({ config: { maxAttempts: 3 } });
    room.updateConfig({ maxAttempts: 9 });
    room.close();

    const again = Room.open(room.dir);
    try {
      expect(again.config.maxAttempts).toBe(9);
    } finally {
      again.close();
    }
  });

  it("leaves every other setting untouched", () => {
    const room = tempRoom();
    room.updateConfig({ maxAttempts: 5 });
    expect(room.config.leaseSeconds).toBe(300);
    expect(room.config.actionBudget).toBe(1000);
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

  it("revokes a member's session token when they leave", () => {
    const room = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" });
    const editor = room.join({ name: "editor", role: "reviewer" });

    room.leave(scout.member.id);

    expect(() => room.authenticate(scout.token)).toThrow(PermissionError);
    expect(room.authenticate(editor.token).id).toBe(editor.member.id);

    const stored = JSON.parse(
      readFileSync(room.paths.tokens, "utf8"),
    ) as Record<string, string>;
    expect(Object.values(stored)).not.toContain(scout.member.id);
    expect(Object.values(stored)).toContain(editor.member.id);
  });

  it("refuses a stale token for an inactive member even if it remains on disk", () => {
    const room = tempRoom();
    const { member, token } = room.join({ name: "scout", role: "worker" });
    room.leave(member.id);

    // Simulate an old room or interrupted cleanup that still has the mapping.
    writeFileSync(
      room.paths.tokens,
      JSON.stringify({ [sha256(token)]: member.id }),
      "utf8",
    );

    expect(() => room.authenticate(token)).toThrow(/member who has left/);
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
