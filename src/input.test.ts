/**
 * `needs_input`: a worker saying it is stuck rather than guessing.
 *
 * ARCHITECTURE.md §12.6. The state exists because its absence pushed work
 * toward the failure §5 is about — an agent with no way to say "I cannot
 * continue" releases its claim, sits on it, or guesses, and an LLM guesses.
 *
 * Two properties carry most of the weight here and both are tested below:
 * the claim is kept and stops expiring while a task waits, and the question
 * and its answer are events rather than a message between two members.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  askForInput,
  claimTask,
  createTask,
  getTask,
  listTasks,
  supplyInput,
  withdrawQuestion,
} from "./board.js";
import { cmdTaskAnswer, type Sink } from "./cli.js";
import { ConflictError, InvalidError, PermissionError } from "./errors.js";
import { Room } from "./room.js";
import type { MemberId, TaskId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): { room: Room; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "atrium-input-"));
  dirs.push(base);
  const dir = join(base, "room");
  const room = Room.create(dir, config);
  rooms.push(room);
  return { room, dir };
}

function member(room: Room, name: string, role: "worker" | "reviewer" | "human"): MemberId {
  return room.join({ name, role }).member.id;
}

/** A room with one task claimed by `scout`, ready to get stuck. */
function claimed(config?: Parameters<typeof Room.create>[1]): {
  room: Room;
  dir: string;
  scout: MemberId;
  editor: MemberId;
  taskId: TaskId;
} {
  const { room, dir } = tempRoom(config);
  const editor = member(room, "editor", "reviewer");
  const scout = member(room, "scout", "worker");
  const task = createTask(room, editor, { title: "Write the piece" });
  claimTask(room, scout, task.id);
  return { room, dir, scout, editor, taskId: task.id };
}

afterEach(() => {
  vi.useRealTimers();
  while (rooms.length) {
    try {
      rooms.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("asking for input", () => {
  it("moves the task to needs_input and keeps the claim", () => {
    const { room, scout, taskId } = claimed();

    const task = askForInput(room, scout, taskId, "Which merger figure should I use?");

    expect(task.state).toBe("needs_input");
    // Asking is not giving up. The claim is the difference.
    expect(task.claimedBy).toBe(scout);
    expect(task.pendingQuestion).toMatchObject({
      by: scout,
      text: "Which merger figure should I use?",
    });
  });

  it("keeps the task off the board while it waits", () => {
    const { room, scout, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    // Nobody else can pick it up, and the runner will not dispatch it.
    expect(listTasks(room, { claimable: true }).map((t) => t.id)).not.toContain(taskId);
  });

  it("lets only the member doing the work say it is stuck", () => {
    const { room, editor, taskId } = claimed();

    expect(() => askForInput(room, editor, taskId, "why?")).toThrow(PermissionError);
    expect(() => askForInput(room, editor, taskId, "why?")).toThrow(/Only the member doing/);
  });

  it("refuses on a task nobody has claimed", () => {
    const { room, editor, scout } = claimed();
    const spare = createTask(room, editor, { title: "Unclaimed" });

    expect(() => askForInput(room, scout, spare.id, "why?")).toThrow(/not claimed/);
  });

  it("refuses a second question while one is already pending", () => {
    const { room, scout, taskId } = claimed();
    askForInput(room, scout, taskId, "first question");

    expect(() => askForInput(room, scout, taskId, "second question")).toThrow(ConflictError);
    expect(() => askForInput(room, scout, taskId, "second")).toThrow(/already waiting/);
  });

  it("refuses an empty question, which nobody could answer", () => {
    const { room, scout, taskId } = claimed();
    expect(() => askForInput(room, scout, taskId, "   ")).toThrow(InvalidError);
  });
});

describe("answering", () => {
  it("puts the task back to work with the answer on the log", () => {
    const { room, scout, editor, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    const task = supplyInput(room, editor, taskId, "Use the one in the filing.");

    expect(task.state).toBe("claimed");
    expect(task.claimedBy).toBe(scout);
    expect(task.pendingQuestion).toBeUndefined();
    expect(task.lastAnswer).toMatchObject({ by: editor, text: "Use the one in the filing." });
  });

  it("leaves the answer readable to whoever picks the task up", () => {
    const { room, scout, editor, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");
    supplyInput(room, editor, taskId, "The one in the filing.");

    // Not a message to the asker: a third member reading the room afterwards
    // sees the question and the answer in order, which is §2's whole claim.
    const events = room.log.read({
      types: ["task.input_requested", "task.input_supplied"],
    });
    expect(events.map((event) => event.type)).toEqual([
      "task.input_requested",
      "task.input_supplied",
    ]);
    expect(getTask(room, taskId).lastAnswer?.text).toBe("The one in the filing.");
  });

  it("refuses to let the asker answer its own question", () => {
    const { room, scout, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    expect(() => supplyInput(room, scout, taskId, "this one")).toThrow(PermissionError);
    expect(() => supplyInput(room, scout, taskId, "this one")).toThrow(/withdraw the question/);
  });

  it("refuses on a task that is not waiting on anything", () => {
    const { room, editor, taskId } = claimed();
    expect(() => supplyInput(room, editor, taskId, "unasked-for")).toThrow(/not waiting on anything/);
  });

  it("refuses an empty answer", () => {
    const { room, scout, editor, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    expect(() => supplyInput(room, editor, taskId, "  ")).toThrow(InvalidError);
  });
});

describe("withdrawing", () => {
  it("lets the asker take its own question back and carry on", () => {
    const { room, scout, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    const task = withdrawQuestion(room, scout, taskId);

    expect(task.state).toBe("claimed");
    expect(task.claimedBy).toBe(scout);
    expect(task.pendingQuestion).toBeUndefined();
    expect(task.lastAnswer).toBeUndefined();
  });

  it("refuses to let somebody else withdraw a question", () => {
    const { room, scout, editor, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");

    expect(() => withdrawQuestion(room, editor, taskId)).toThrow(PermissionError);
    expect(() => withdrawQuestion(room, editor, taskId)).toThrow(/Answer it instead/);
  });
});

/**
 * The open question §12.6 raised, and the answer this design settles on.
 */
describe("what happens to the claim while it waits", () => {
  it("does not let the claim lapse, however long the answer takes", () => {
    vi.useFakeTimers();
    const { room, scout, taskId } = claimed({ config: { claimSeconds: 60 } });
    askForInput(room, scout, taskId, "Which figure?");

    // Overnight. A claim that expired here would cost the asker its place for
    // the crime of asking at five o'clock.
    vi.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));

    const task = getTask(room, taskId);
    expect(task.state).toBe("needs_input");
    expect(task.claimedBy).toBe(scout);
  });

  it("hands out a fresh claim window when the answer arrives", () => {
    vi.useFakeTimers();
    const { room, scout, editor, taskId } = claimed({ config: { claimSeconds: 60 } });
    askForInput(room, scout, taskId, "Which figure?");
    vi.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));

    const task = supplyInput(room, editor, taskId, "the one in the filing");

    // Restoring the original window would drop the task the instant it was
    // unblocked, since that window closed hours ago.
    expect(task.state).toBe("claimed");
    expect(new Date(task.claimExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("frees a task whose asker died, once the answer's fresh window lapses", () => {
    vi.useFakeTimers();
    const { room, scout, editor, taskId } = claimed({ config: { claimSeconds: 60 } });
    askForInput(room, scout, taskId, "Which figure?");
    supplyInput(room, editor, taskId, "the one in the filing");

    // scout never renews, because scout is gone. This is the answer to the
    // objection against pausing at all: nothing is held forever, and no
    // sweeper had to run to notice.
    vi.setSystemTime(new Date(Date.now() + 61 * 1000));

    const task = getTask(room, taskId);
    expect(task.state).toBe("open");
    expect(task.claimedBy).toBeUndefined();
    expect(listTasks(room, { claimable: true }).map((t) => t.id)).toContain(taskId);
  });
});

describe("atrium task answer", () => {
  function sink(): Sink & { outLines: string[]; errLines: string[] } {
    const outLines: string[] = [];
    const errLines: string[] = [];
    return {
      outLines,
      errLines,
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    };
  }

  it("answers as the CLI's own human member", () => {
    const { room, dir, scout, taskId } = claimed();
    askForInput(room, scout, taskId, "Which figure?");
    const s = sink();

    expect(cmdTaskAnswer([taskId, dir, "--text", "The one in the filing."], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/is claimed again by/);
    expect(getTask(room, taskId).lastAnswer?.text).toBe("The one in the filing.");
  });

  it("needs the answer text", () => {
    const { dir } = claimed();
    const s = sink();

    expect(cmdTaskAnswer(["task_whatever", dir], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/needs --text/);
  });

  it("explains the state in its help rather than only the flags", () => {
    const s = sink();
    expect(cmdTaskAnswer(["--help"], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/rather than\s+guessing/);
  });
});
