import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeHistory,
  getContext,
  listPinned,
  pinArtifact,
  unpinArtifact,
} from "./context.js";
import { InvalidError, NotFoundError } from "./errors.js";
import { Room } from "./room.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-context-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
}

function write(room: Room, relPath: string, content: string): void {
  writeFileSync(join(room.dir, relPath), content, "utf8");
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

describe("getContext", () => {
  it("reads the brief that Room.create wrote", () => {
    const room = tempRoom({ name: "research" });
    const ctx = getContext(room);
    expect(ctx.brief).toContain("research");
    expect(ctx.pinned).toEqual([]);
    expect(ctx.tokens).toBeGreaterThan(0);
    expect(ctx.ceiling).toBe(room.config.contextTokenCeiling);
  });

  it("returns an empty brief rather than throwing when CONTEXT.md is missing", () => {
    const room = tempRoom();
    rmSync(room.paths.context);

    const ctx = getContext(room);
    expect(ctx.brief).toBe("");
    expect(ctx.tokens).toBe(0);
  });
});

describe("pinning", () => {
  it("pins an artifact and folds it into the context", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "notes.md", "things worth knowing");

    pinArtifact(room, worker.id, "notes.md");

    const ctx = getContext(room);
    expect(ctx.pinned).toEqual([{ path: "notes.md", content: "things worth knowing" }]);
    expect(listPinned(room)).toEqual(["notes.md"]);
  });

  it("unpins an artifact", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "notes.md", "things worth knowing");
    pinArtifact(room, worker.id, "notes.md");

    unpinArtifact(room, worker.id, "notes.md");

    expect(listPinned(room)).toEqual([]);
    expect(getContext(room).pinned).toEqual([]);
  });

  it("is a no-op to pin the same file twice", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "notes.md", "things worth knowing");

    pinArtifact(room, worker.id, "notes.md");
    const before = room.log.head();
    pinArtifact(room, worker.id, "notes.md");

    expect(room.log.head()).toBe(before);
    expect(listPinned(room)).toEqual(["notes.md"]);
  });

  it("is a no-op to unpin something that was never pinned", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const before = room.log.head();

    unpinArtifact(room, worker.id, "notes.md");

    expect(room.log.head()).toBe(before);
  });

  it("refuses to pin a file that does not exist", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() => pinArtifact(room, worker.id, "missing.md")).toThrow(NotFoundError);
    expect(() => pinArtifact(room, worker.id, "missing.md")).toThrow(/Write it first/);
  });

  it("keeps paths inside the room, refusing escapes and .atrium", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    expect(() => pinArtifact(room, worker.id, "../secrets.txt")).toThrow(/outside the room/);
    expect(() => pinArtifact(room, worker.id, ".atrium/room.json")).toThrow(/not writable/);
  });

  it("refuses a pin that would push the total over the ceiling, and says why", () => {
    const room = tempRoom({ config: { contextTokenCeiling: 20 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    // estimateTokens is text.length / 4, so this is comfortably over a ceiling of 20.
    const big = "x".repeat(200);
    write(room, "big.md", big);

    const before = getContext(room);
    let thrown: unknown;
    try {
      pinArtifact(room, worker.id, "big.md");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidError);
    const err = thrown as InstanceType<typeof InvalidError>;
    expect(err.message).toContain(String(before.tokens));
    expect(err.message).toContain("20");
    expect(err.message).toContain("50"); // 200 chars / 4 = 50 tokens for big.md
    expect(err.details.ceilingTokens).toBe(20);
    expect(err.details.fileTokens).toBe(50);

    // The refusal did not touch the log or the brief.
    expect(listPinned(room)).toEqual([]);
  });

  it("still reports the real total even when the hand-edited brief is already over the ceiling", () => {
    const room = tempRoom({ config: { contextTokenCeiling: 5 } });
    // CONTEXT.md as written by Room.create is already bigger than 5 tokens.
    const ctx = getContext(room);
    expect(ctx.tokens).toBeGreaterThan(ctx.ceiling);
  });

  it("checks the actor is a real member", () => {
    const room = tempRoom();
    write(room, "notes.md", "hello");
    expect(() => pinArtifact(room, "not-a-member", "notes.md")).toThrow(NotFoundError);
  });

  it("drops a pinned file from context without crashing if it is deleted off disk", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "notes.md", "things worth knowing");
    pinArtifact(room, worker.id, "notes.md");

    rmSync(join(room.dir, "notes.md"));

    // Still listed as pinned (nobody unpinned it)...
    expect(listPinned(room)).toEqual(["notes.md"]);
    // ...but does not appear, or blow up, when reading the actual context.
    expect(getContext(room).pinned).toEqual([]);
  });
});

describe("describeHistory", () => {
  it("turns a realistic run into readable lines", () => {
    const room = tempRoom({ name: "draft-room" });
    const worker = room.join({ name: "worker-2", role: "worker" }).member;
    const reviewer = room.join({ name: "reviewer-1", role: "reviewer" }).member;

    room.log.append("system", "task.created", {
      taskId: "task_1a2b",
      title: "Write the draft",
      description: "",
      dependsOn: [],
      acceptance: { kind: "reviewer" },
    });
    room.log.append(worker.id, "task.claimed", {
      taskId: "task_1a2b",
      memberId: worker.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    room.log.append(worker.id, "task.submitted", {
      taskId: "task_1a2b",
      memberId: worker.id,
      summary: "first pass",
      artifacts: ["draft.md"],
      basedOnSeq: room.log.head(),
    });
    room.log.append(reviewer.id, "task.rejected", {
      taskId: "task_1a2b",
      by: reviewer.id,
      via: "reviewer",
      reason: "no sources",
    });

    const lines = describeHistory(room).map((h) => h.line);

    expect(lines.some((l) => l.includes("worker-2 claimed task_1a2b (Write the draft)"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("reviewer-1 rejected task_1a2b") && l.includes("no sources")),
    ).toBe(true);
  });

  it("respects from/to/limit/types like the log's own read options", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "one" });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "two" });

    const notesOnly = describeHistory(room, { types: ["note.posted"] });
    expect(notesOnly).toHaveLength(2);
    expect(notesOnly[0]?.line).toContain("one");

    const limited = describeHistory(room, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("does not crash on any event type in EventMap, including unusual ones", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;

    room.log.append("system", "task.blocked", { taskId: "ghost", waitingOn: ["other"] });
    room.log.append("system", "task.unblocked", { taskId: "ghost" });
    room.log.append(worker.id, "task.escalated", { taskId: "ghost", attempts: 3 });
    room.log.append(worker.id, "artifact.written", {
      path: "draft.md",
      bytes: 12,
      hash: "abc",
      memberId: worker.id,
    });
    room.log.append(worker.id, "artifact.deleted", { path: "draft.md", memberId: worker.id });
    room.log.append(worker.id, "lease.acquired", {
      path: "draft.md",
      memberId: worker.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    room.log.append(worker.id, "lease.renewed", {
      path: "draft.md",
      memberId: worker.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    room.log.append(worker.id, "lease.released", {
      path: "draft.md",
      memberId: worker.id,
      reason: "voluntary",
    });
    room.log.append(worker.id, "context.pinned", { path: "notes.md", memberId: worker.id });
    room.log.append(worker.id, "context.unpinned", { path: "notes.md", memberId: worker.id });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "hi" });
    room.log.append("system", "room.halted", { reason: "out of budget" });
    room.log.append(worker.id, "member.left", { memberId: worker.id });

    const lines = describeHistory(room);
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) {
      expect(typeof entry.line).toBe("string");
      expect(entry.line.length).toBeGreaterThan(0);
    }
  });

  it("falls back to something sensible for an event type it does not recognize", () => {
    const room = tempRoom();
    // Simulating a log written by a future version of Atrium, or hand-crafted
    // test data: something with a `type` outside today's EventMap.
    room.log.append("system", "some.future.event" as never, { anything: true } as never);

    const lines = describeHistory(room);
    const last = lines[lines.length - 1];
    expect(last?.line).toMatch(/does not know how to describe/);
    expect(last?.line).toContain("some.future.event");
  });
});
