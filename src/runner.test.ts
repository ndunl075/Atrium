import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTask } from "./board.js";
import { Room } from "./room.js";
import {
  parseRunnerConfig,
  planRunnerAssignments,
  runRoomOnce,
  workerEnvironment,
  type RunnerAssignment,
} from "./runner.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-"));
  dirs.push(dir);
  const room = Room.create(join(dir, "room"));
  rooms.push(room);
  return room;
}

afterEach(() => {
  while (rooms.length) rooms.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("runner config", () => {
  it("accepts named worker slots and a concurrency cap", () => {
    expect(parseRunnerConfig({
      workers: [
        { name: "codex", command: "codex exec" },
        { name: "claude", command: "claude -p" },
      ],
      maxConcurrent: 1,
    })).toEqual({
      workers: [
        { name: "codex", command: "codex exec" },
        { name: "claude", command: "claude -p" },
      ],
      maxConcurrent: 1,
    });
  });

  it("refuses empty commands and duplicate names", () => {
    expect(() => parseRunnerConfig({
      workers: [{ name: "codex", command: " " }],
    })).toThrow(/command/);
    expect(() => parseRunnerConfig({
      workers: [
        { name: "codex", command: "one" },
        { name: "codex", command: "two" },
      ],
    })).toThrow(/unique/);
  });
});

describe("one dispatch pass", () => {
  it("pairs claimable tasks with bounded worker slots in board order", () => {
    const room = tempRoom();
    const owner = room.join({ name: "owner", role: "human" }).member;
    const first = createTask(room, owner.id, { title: "first" });
    createTask(room, owner.id, { title: "second" });

    const assignments = planRunnerAssignments(
      [first],
      {
        workers: [
          { name: "one", command: "worker-one" },
          { name: "two", command: "worker-two" },
        ],
        maxConcurrent: 1,
      },
    );

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.worker.name).toBe("one");
    expect(assignments[0]!.task.id).toBe(first.id);
  });

  it("launches each assignment with room and task context", async () => {
    const room = tempRoom();
    const owner = room.join({ name: "owner", role: "human" }).member;
    const task = createTask(room, owner.id, {
      title: "Write the brief",
      expectedOutput: {
        description: "A two-paragraph brief.",
        schema: { type: "object" },
      },
    });
    const launched: RunnerAssignment[] = [];

    const summary = await runRoomOnce(
      room,
      { workers: [{ name: "codex", command: "unused-in-test" }] },
      {
        launcher: async (assignment, roomDir) => {
          launched.push(assignment);
          const env = workerEnvironment(assignment, roomDir);
          expect(env.ATRIUM_ROOM).toBe(room.dir);
          expect(env.ATRIUM_TASK_ID).toBe(task.id);
          expect(env.ATRIUM_TASK_TITLE).toBe("Write the brief");
          expect(env.ATRIUM_EXPECTED_OUTPUT).toBe("A two-paragraph brief.");
          expect(env.ATRIUM_EXPECTED_OUTPUT_SCHEMA).toBe('{"type":"object"}');
          expect(env.ATRIUM_WORKER_NAME).toBe("codex");
          return 0;
        },
      },
    );

    expect(launched).toHaveLength(1);
    expect(summary.results[0]!.exitCode).toBe(0);
  });

  it("does not launch anything during a dry run", async () => {
    const room = tempRoom();
    const owner = room.join({ name: "owner", role: "human" }).member;
    createTask(room, owner.id, { title: "Inspect this" });
    let launched = false;

    const summary = await runRoomOnce(
      room,
      { workers: [{ name: "codex", command: "unused-in-test" }] },
      {
        dryRun: true,
        launcher: async () => {
          launched = true;
          return 0;
        },
      },
    );

    expect(summary.assignments).toHaveLength(1);
    expect(summary.results).toEqual([]);
    expect(launched).toBe(false);
  });
});
