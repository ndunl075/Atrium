/**
 * The `manager` role (ARCHITECTURE.md §12.5).
 *
 * What it is: a reviewer that can also take a stuck claim off somebody else.
 * What it deliberately is not: a member that can un-freeze an escalated task.
 * That freeze is §5's backstop, and handing an agent the key to it would
 * defeat the point of having one — so the boundary is tested here rather
 * than only stated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reviewTask, submitTask } from "./acceptance.js";
import { claimTask, createTask, listTasks, releaseTask, restartTask } from "./board.js";
import { PermissionError } from "./errors.js";
import { Room } from "./room.js";
import type { MemberId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const base = mkdtempSync(join(tmpdir(), "atrium-manager-"));
  dirs.push(base);
  const room = Room.create(join(base, "room"), config);
  rooms.push(room);
  return room;
}

function member(room: Room, name: string, role: Parameters<Room["join"]>[0]["role"]): MemberId {
  return room.join({ name, role }).member.id;
}

afterEach(() => {
  while (rooms.length) {
    try {
      rooms.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("the manager role", () => {
  it("is a role a member can join as", () => {
    const room = tempRoom();
    const id = member(room, "chief", "manager");

    expect(room.member(id).role).toBe("manager");
  });

  it("can accept and reject other members' work, like a reviewer", async () => {
    const room = tempRoom();
    const chief = member(room, "chief", "manager");
    const scout = member(room, "scout", "worker");

    const task = createTask(room, chief, { title: "Write the piece" });
    claimTask(room, scout, task.id);
    await submitTask(room, scout, task.id, { summary: "first go" });

    const rejected = reviewTask(room, chief, task.id, {
      accept: false,
      reason: "not sourced",
    });
    expect(rejected.state).toBe("rejected");

    claimTask(room, scout, task.id);
    await submitTask(room, scout, task.id, { summary: "second go" });
    expect(reviewTask(room, chief, task.id, { accept: true }).state).toBe("accepted");
  });

  it("cannot claim work, because it judges rather than produces", () => {
    const room = tempRoom();
    const chief = member(room, "chief", "manager");

    const task = createTask(room, chief, { title: "Something" });

    // Same line a reviewer sits behind, and it is what makes the §5 rule
    // unreachable for this role rather than merely enforced: a member that
    // cannot claim can never be the submitter it would have to be to approve
    // its own work.
    expect(() => claimTask(room, chief, task.id)).toThrow(PermissionError);
    expect(() => claimTask(room, chief, task.id)).toThrow(/needs worker or human/);
  });

  it("can take a stuck claim off somebody else", () => {
    const room = tempRoom();
    const chief = member(room, "chief", "manager");
    const scout = member(room, "scout", "worker");

    const task = createTask(room, chief, { title: "Write the piece" });
    claimTask(room, scout, task.id);

    // Housekeeping, not a judgement about the work — so it does not need a
    // person to be awake.
    const released = releaseTask(room, chief, task.id);

    expect(released.state).toBe("open");
    expect(released.claimedBy).toBeUndefined();
    expect(listTasks(room, { claimable: true }).map((t) => t.id)).toContain(task.id);
  });

  it("cannot un-freeze a task that was escalated after too many rejections", async () => {
    const room = tempRoom({ config: { maxAttempts: 1 } });
    const chief = member(room, "chief", "manager");
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");

    const task = createTask(room, chief, { title: "Write the piece" });
    claimTask(room, scout, task.id);
    await submitTask(room, scout, task.id, { summary: "go" });
    reviewTask(room, editor, task.id, { accept: false, reason: "no" });

    expect(listTasks(room).find((t) => t.id === task.id)?.escalated).toBe(true);

    // The whole point of the freeze is that it waits for a person. A manager
    // is an agent, so this must refuse however convenient it would be.
    expect(() => restartTask(room, chief, task.id)).toThrow(PermissionError);
    expect(() => restartTask(room, chief, task.id)).toThrow(/needs human/);
  });
});

describe("a plain reviewer, for contrast", () => {
  it("cannot take somebody else's claim", () => {
    const room = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");

    const task = createTask(room, editor, { title: "Write the piece" });
    claimTask(room, scout, task.id);

    expect(() => releaseTask(room, editor, task.id)).toThrow(PermissionError);
    expect(() => releaseTask(room, editor, task.id)).toThrow(/neither a human nor a manager/);
  });
});
