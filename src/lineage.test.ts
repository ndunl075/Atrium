/**
 * Lineage and `produces` (ARCHITECTURE.md §13.6, from Dagster).
 *
 * The section called this a large change to the core model. It split in two,
 * and only one half is: lineage is *derived* from events already in the log,
 * so it works on rooms that predate the idea, while `produces` is the model
 * change and is deliberately optional.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reviewTask, submitTask } from "./acceptance.js";
import { writeArtifact, deleteArtifact } from "./artifacts.js";
import { claimTask, createTask, listTasks, releaseTask } from "./board.js";
import { cmdLineage, type Sink } from "./cli.js";
import { InvalidError } from "./errors.js";
import { acquireLease } from "./leases.js";
import { artifactLineage, producedGaps } from "./lineage.js";
import { Room } from "./room.js";
import type { MemberId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(): { room: Room; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "atrium-lineage-"));
  dirs.push(base);
  const dir = join(base, "room");
  const room = Room.create(dir);
  rooms.push(room);
  return { room, dir };
}

function member(room: Room, name: string, role: "worker" | "reviewer"): MemberId {
  return room.join({ name, role }).member.id;
}

function write(room: Room, actor: MemberId, path: string, content: string): void {
  acquireLease(room, actor, path);
  writeArtifact(room, actor, path, content);
}

function sink(): Sink & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (l) => outLines.push(l), err: (l) => errLines.push(l) };
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

describe("artifactLineage", () => {
  it("attributes a write to the task its author was holding", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write the piece" });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "first");

    const [entry] = artifactLineage(room, "draft.md");
    expect(entry).toMatchObject({
      author: scout,
      taskId: task.id,
      taskTitle: "Write the piece",
      attempt: 0,
    });
  });

  it("tells the rejected draft apart from the one that replaced it", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write the piece" });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "first, flawed");
    await submitTask(room, scout, task.id, { summary: "first" });
    reviewTask(room, editor, task.id, { accept: false, reason: "unsupported claim" });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "second, fixed");
    await submitTask(room, scout, task.id, { summary: "second" });

    const entries = artifactLineage(room, "draft.md");

    // This is the whole point of lineage over history: history says two
    // versions, this says which was the one that came back.
    expect(entries).toHaveLength(2);
    expect(entries[0]!.attempt).toBe(0);
    expect(entries[1]!.attempt).toBe(1);
    expect(entries.every((e) => e.taskId === task.id)).toBe(true);
  });

  it("shows no task for a write made while holding no claim", () => {
    const { room } = tempRoom();
    const scout = member(room, "scout", "worker");

    write(room, scout, "notes.md", "just dropped this here");

    const [entry] = artifactLineage(room, "notes.md");
    // A real and legitimate case, not a gap to paper over.
    expect(entry!.author).toBe(scout);
    expect(entry!.taskId).toBeUndefined();
  });

  it("stops attributing once the claim is released", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write the piece" });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "while holding");
    releaseTask(room, scout, task.id);
    write(room, scout, "draft.md", "after letting go");

    const entries = artifactLineage(room, "draft.md");
    expect(entries[0]!.taskId).toBe(task.id);
    expect(entries[1]!.taskId).toBeUndefined();
  });

  it("keeps a deleted path's history attributed", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Tidy up" });

    claimTask(room, scout, task.id);
    write(room, scout, "scratch.md", "temporary");
    deleteArtifact(room, scout, "scratch.md");

    const entries = artifactLineage(room, "scratch.md");
    expect(entries.map((e) => e.kind)).toEqual(["written", "deleted"]);
    expect(entries[0]!.taskId).toBe(task.id);
  });

  it("is empty for a path nobody has written", () => {
    const { room } = tempRoom();
    expect(artifactLineage(room, "nothing.md")).toEqual([]);
  });
});

describe("produces", () => {
  it("records what a task says it will write", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    const task = createTask(room, editor, {
      title: "Write the piece",
      produces: ["draft.md"],
    });

    expect(task.produces).toEqual(["draft.md"]);
  });

  it("is optional, because some work produces no file at all", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    // The reason §13.6's open question resolved to "alongside dependsOn"
    // rather than "instead of": a sign-off's whole output is a verdict.
    const task = createTask(room, editor, { title: "Sign it off" });

    expect(task.produces).toBeUndefined();
    expect(task.dependsOn).toEqual([]);
  });

  it("normalizes paths so a declaration and a write are the same path", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    const task = createTask(room, editor, {
      title: "Write",
      produces: ["./draft.md", "draft.md"],
    });

    expect(task.produces).toEqual(["draft.md"]);
  });

  it("refuses a path that escapes the room", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    expect(() =>
      createTask(room, editor, { title: "Sneaky", produces: ["../outside.md"] }),
    ).toThrow(/outside the room/);
  });

  it("refuses an entry that is not a path", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    expect(() =>
      createTask(room, editor, { title: "Bad", produces: [""] }),
    ).toThrow(InvalidError);
  });
});

describe("producedGaps", () => {
  it("reports a task that promised a file and did not write it", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, {
      title: "Write the piece",
      produces: ["draft.md"],
    });

    claimTask(room, scout, task.id);
    await submitTask(room, scout, task.id, { summary: "done, honest" });

    const gaps = producedGaps(room, listTasks(room));
    expect(gaps).toEqual([
      { taskId: task.id, title: "Write the piece", missing: ["draft.md"] },
    ]);
  });

  it("reports nothing once the promised file exists", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, {
      title: "Write the piece",
      produces: ["draft.md"],
    });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "here it is");
    await submitTask(room, scout, task.id, { summary: "done" });

    expect(producedGaps(room, listTasks(room))).toEqual([]);
  });

  it("says nothing about a task still being worked on", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write", produces: ["draft.md"] });
    claimTask(room, scout, task.id);

    // Before hand-in, "not written yet" is just where the task is up to.
    expect(producedGaps(room, listTasks(room))).toEqual([]);
  });

  it("still reports a file that was written and then deleted", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write", produces: ["draft.md"] });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "here");
    deleteArtifact(room, scout, "draft.md");
    await submitTask(room, scout, task.id, { summary: "done" });

    // The path is in the room's history, which is what "produced" means; a
    // reviewer can see the deletion in the log for themselves.
    expect(producedGaps(room, listTasks(room))).toEqual([]);
  });
});

describe("atrium lineage", () => {
  it("names the task and the attempt", async () => {
    const { room, dir } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");
    const task = createTask(room, editor, { title: "Write the piece" });

    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "first");
    await submitTask(room, scout, task.id, { summary: "x" });
    reviewTask(room, editor, task.id, { accept: false, reason: "no" });
    claimTask(room, scout, task.id);
    write(room, scout, "draft.md", "second");

    const s = sink();
    expect(cmdLineage(["draft.md", dir], s)).toBe(0);
    const out = s.outLines.join("\n");

    expect(out).toContain("written by scout");
    expect(out).toContain("Write the piece");
    expect(out).toContain("attempt 2");
  });

  it("says so plainly for a path nobody wrote", () => {
    const { dir } = tempRoom();
    const s = sink();

    expect(cmdLineage(["nothing.md", dir], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/has ever been written/);
  });

  it("needs a path", () => {
    const s = sink();
    expect(cmdLineage([], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/needs a path/);
  });
});
