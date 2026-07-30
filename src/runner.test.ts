import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTask, listTasks } from "./board.js";
import { Room } from "./room.js";
import {
  parseRunnerConfig,
  pollingWorkerEnvironment,
  startPollingWorkers,
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

/**
 * ARCHITECTURE.md §12.9. The section's objection was that a long-lived worker
 * could hold private state and become a second source of truth. The answer is
 * the other way round: a polling worker is told nothing, so the runner stops
 * making the one scheduling decision it used to make.
 */
describe("polling workers", () => {
  it("accepts poll on a worker slot", () => {
    const config = parseRunnerConfig({
      workers: [
        { name: "resident", command: "node worker.mjs", poll: true },
        { name: "oneshot", command: "node worker.mjs" },
      ],
    });

    expect(config.workers[0]).toEqual({
      name: "resident",
      command: "node worker.mjs",
      poll: true,
    });
    expect(config.workers[1]).not.toHaveProperty("poll");
  });

  it("refuses a poll flag that is not a boolean", () => {
    expect(() =>
      parseRunnerConfig({ workers: [{ name: "a", command: "x", poll: "yes" }] }),
    ).toThrow(/poll must be true or false/);
  });

  it("never assigns a task to a polling worker", () => {
    const room = tempRoom();
    const editor = room.join({ name: "editor", role: "reviewer" }).member.id;
    createTask(room, editor, { title: "One" });
    createTask(room, editor, { title: "Two" });

    const config = parseRunnerConfig({
      workers: [
        { name: "resident", command: "x", poll: true },
        { name: "oneshot", command: "y" },
      ],
    });

    const assignments = planRunnerAssignments(listTasks(room, { claimable: true }), config);

    expect(assignments.map((a) => a.worker.name)).toEqual(["oneshot"]);
  });

  it("tells a polling worker nothing but which room it is in", () => {
    const room = tempRoom();
    const env = pollingWorkerEnvironment({ name: "resident", command: "x", poll: true }, room.dir);

    expect(env.ATRIUM_ROOM).toBe(room.dir);
    expect(env.ATRIUM_WORKER_NAME).toBe("resident");
    expect(env.ATRIUM_POLL).toBe("1");
    // The point of the whole design: no assignment, so nothing for the worker
    // to hold that the room does not already know.
    expect(env.ATRIUM_TASK_ID).toBeUndefined();
    expect(env.ATRIUM_TASK_TITLE).toBeUndefined();
  });

  it("starts each polling worker exactly once", async () => {
    const room = tempRoom();
    const started: string[] = [];
    const config = parseRunnerConfig({
      workers: [
        { name: "a", command: "x", poll: true },
        { name: "b", command: "y", poll: true },
        { name: "oneshot", command: "z" },
      ],
    });

    const handle = startPollingWorkers(room, config, {
      launcher: async (worker) => {
        started.push(worker.name);
        return 0;
      },
    });
    const codes = await handle.done;

    expect(started).toEqual(["a", "b"]);
    expect(codes).toEqual([0, 0]);
    expect(handle.started.map((w) => w.name)).toEqual(["a", "b"]);
  });

  it("does not restart a worker that exits", async () => {
    const room = tempRoom();
    let launches = 0;
    const config = parseRunnerConfig({
      workers: [{ name: "quitter", command: "x", poll: true }],
    });

    const handle = startPollingWorkers(room, config, {
      launcher: async () => {
        launches++;
        return 1;
      },
    });
    await handle.done;

    // Restarting would be the runner deciding the job is not finished, which
    // is a conclusion about the board it has no business drawing.
    expect(launches).toBe(1);
  });

  it("starts nothing when no worker asked to poll", async () => {
    const room = tempRoom();
    const config = parseRunnerConfig({ workers: [{ name: "oneshot", command: "x" }] });

    const handle = startPollingWorkers(room, config, { launcher: async () => 0 });

    expect(handle.started).toEqual([]);
    expect(await handle.done).toEqual([]);
  });
});
