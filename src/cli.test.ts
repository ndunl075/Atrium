import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { claimTask, createTask } from "./board.js";
import { acquireLease } from "./leases.js";
import { writeArtifact } from "./artifacts.js";
import {
  cmdBoard,
  cmdContext,
  cmdDiff,
  cmdHistory,
  cmdInit,
  cmdInvite,
  cmdLog,
  cmdOpen,
  cmdReplay,
  cmdSearch,
  cmdServe,
  runCli,
  type Sink,
} from "./cli.js";

const created: Array<{ room?: Room; dir: string }> = [];

/** A fresh, empty directory — not yet a room. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atrium-cli-"));
  created.push({ dir });
  return dir;
}

/** A room ready to point commands at, tracked for cleanup like the other test files. */
function tempRoom(config?: Parameters<typeof Room.create>[1]): { dir: string; room: Room } {
  const base = tempDir();
  const dir = join(base, "job");
  const room = Room.create(dir, config);
  created[created.length - 1]!.room = room;
  return { dir, room };
}

afterEach(() => {
  vi.useRealTimers();
  while (created.length) {
    const entry = created.pop()!;
    try {
      entry.room?.close();
    } catch {
      // already closed
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

/** A sink that just remembers what it was told, so a test can inspect it. */
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

describe("init", () => {
  it("creates a room in the given directory", () => {
    const dir = tempDir();
    const roomDir = join(dir, "job");
    const s = sink();

    const code = cmdInit([roomDir], s);

    expect(code).toBe(0);
    expect(Room.isRoom(roomDir)).toBe(true);
    expect(s.outLines.join("\n")).toContain("Created room");
  });

  it("defaults to the current directory when none is given", () => {
    const dir = tempDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const code = cmdInit([], sink());
      expect(code).toBe(0);
      expect(Room.isRoom(dir)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("refuses to create a room on top of one that already exists", () => {
    const dir = tempDir();
    const roomDir = join(dir, "job");
    cmdInit([roomDir], sink());

    // The second call has to go through runCli, not cmdInit directly: cmdInit
    // lets AtriumError propagate, and runCli is where that becomes a message
    // plus an exit code rather than a thrown exception.
    const s = sink();
    const code = runCli(["init", roomDir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/already a room/);
  });
});

describe("board", () => {
  it("groups tasks by state", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    createTask(room, worker.id, { title: "Write the draft" });
    const toClaim = createTask(room, worker.id, { title: "Research the topic" });
    claimTask(room, worker.id, toClaim.id);

    const s = sink();
    const code = cmdBoard([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/OPEN/);
    expect(text).toContain("Write the draft");
    expect(text).toMatch(/CLAIMED/);
    expect(text).toContain("Research the topic");
  });

  it("--json produces parseable JSON reflecting the same board", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    createTask(room, worker.id, { title: "Write the draft" });

    const s = sink();
    const code = cmdBoard(["--json", dir], s);
    const tasks = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Write the draft");
    expect(tasks[0].state).toBe("open");
  });
});

describe("open", () => {
  it("shows the room's name, members, and task counts", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "scout", role: "worker" });

    const s = sink();
    const code = cmdOpen([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain(room.config.name);
    expect(text).toContain("scout");
    expect(text).toMatch(/open: 0/);
  });

  it("--json produces parseable JSON with the room's id and config", () => {
    const { dir, room } = tempRoom();

    const s = sink();
    const code = cmdOpen(["--json", dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(data.id).toBe(room.config.id);
    expect(data.name).toBe(room.config.name);
    expect(data.taskCounts).toEqual({});
  });
});

describe("log", () => {
  it("renders the log as readable lines", () => {
    const { dir } = tempRoom();

    const s = sink();
    const code = cmdLog([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/was created/);
  });

  it("--json produces parseable JSON matching describeHistory's shape", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "scout", role: "worker" });

    const s = sink();
    const code = cmdLog(["--json", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.some((l: { line: string }) => /scout joined as worker/.test(l.line))).toBe(true);
  });

  it("--limit caps how many lines come back", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "a", role: "worker" });
    room.join({ name: "b", role: "worker" });

    const s = sink();
    const code = cmdLog(["--json", "--limit", "1", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("rejects a nonsense --limit rather than passing it through", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdLog(["--limit", "not-a-number", dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/--limit/);
  });
});

describe("invite", () => {
  it("prints a token that actually authenticates the new member", () => {
    const { dir, room } = tempRoom();

    const s = sink();
    const code = cmdInvite(["--name", "scout", "--role", "worker", dir], s);

    expect(code).toBe(0);
    const token = s.outLines[s.outLines.length - 1]!;
    const member = room.authenticate(token);
    expect(member.name).toBe("scout");
    expect(member.role).toBe("worker");
  });

  it("warns that the token is shown once and cannot be recovered", () => {
    const { dir } = tempRoom();
    const s = sink();
    cmdInvite(["--name", "scout", dir], s);
    expect(s.outLines.join("\n")).toMatch(/shown once|cannot be recovered/);
  });

  it("defaults to the worker role", () => {
    const { dir, room } = tempRoom();
    const s = sink();
    cmdInvite(["--name", "scout", dir], s);
    const token = s.outLines[s.outLines.length - 1]!;
    expect(room.authenticate(token).role).toBe("worker");
  });

  it("requires --name", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdInvite([dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/--name/);
  });
});

describe("replay", () => {
  it("shows the board as it was, not as it is now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { claimSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);
    const claimSeq = room.log.head();

    // Move well past the claim's lease so the live board now reads it open.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

    const live = sink();
    expect(cmdBoard([dir], live)).toBe(0);
    const liveText = live.outLines.join("\n");
    expect(liveText).toMatch(/OPEN/);
    expect(liveText).not.toMatch(/CLAIMED/);

    const replayed = sink();
    const code = cmdReplay([String(claimSeq), dir], replayed);
    const replayedText = replayed.outLines.join("\n");

    expect(code).toBe(0);
    expect(replayedText).toMatch(/CLAIMED/);
    expect(replayedText).toContain("claimed by");
  });

  it("--json includes the sequence and timestamp it replayed to", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    createTask(room, worker.id, { title: "draft" });
    const seq = room.log.head();

    const s = sink();
    const code = cmdReplay(["--json", String(seq), dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(data.seq).toBe(seq);
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it("gives a clear message for a sequence number past the end of the log", () => {
    const { dir, room } = tempRoom();
    const s = sink();
    const code = cmdReplay([String(room.log.head() + 100), dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/no event/);
  });

  it("rejects a sequence number that isn't a positive whole number", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdReplay(["nope", dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/valid sequence number/);
  });
});

describe("context", () => {
  it("reports the token total against the ceiling", () => {
    const { dir, room } = tempRoom();
    const s = sink();
    const code = cmdContext([dir], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(new RegExp(`Tokens: \\d+ / ${room.config.contextTokenCeiling}`));
  });

  it("--json produces parseable JSON with tokens and ceiling", () => {
    const { dir, room } = tempRoom();
    const s = sink();
    const code = cmdContext(["--json", dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(typeof data.tokens).toBe("number");
    expect(data.ceiling).toBe(room.config.contextTokenCeiling);
  });
});

describe("search", () => {
  it("finds a match in an artifact and prints it", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "notes.md"), "the quick brown fox jumps");

    const s = sink();
    const code = cmdSearch(["fox", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toContain("notes.md");
  });

  it("--json produces parseable JSON hits", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "notes.md"), "the quick brown fox jumps");

    const s = sink();
    const code = cmdSearch(["--json", "fox", dir], s);
    const hits = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0].path).toBe("notes.md");
  });

  it("requires a query", () => {
    const s = sink();
    const code = cmdSearch([], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/query/);
  });

  it("reads a lone argument as the query, not as a directory", () => {
    // `atrium search <query> [dir]`, so `atrium search /tmp/notes` searches the
    // current room for that text rather than searching /tmp/notes for nothing.
    const { dir } = tempRoom();
    writeFileSync(join(dir, "notes.md"), "a path like /tmp/notes appears here");

    const s = sink();
    const code = cmdSearch(["--json", "/tmp/notes", dir], s);

    expect(code).toBe(0);
    expect(JSON.parse(s.outLines.join("\n"))[0].path).toBe("notes.md");
  });
});

describe("history", () => {
  it("lists every version with seq, author and size", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v1");
    writeArtifact(room, a.id, "draft.md", "v2!");

    const s = sink();
    const code = cmdHistory(["draft.md", dir], s);

    expect(code).toBe(0);
    const text = s.outLines.join("\n");
    expect(text).toContain("2 bytes");
    expect(text).toContain("3 bytes");
    expect(text).toContain(a.id);
  });

  it("--json produces parseable version records", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "hello");

    const s = sink();
    const code = cmdHistory(["--json", "draft.md", dir], s);
    const versions = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ path: "draft.md", kind: "written", bytes: 5 });
  });

  it("says so plainly when a path has no history", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdHistory(["never-written.md", dir], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/No history/);
  });

  it("requires a path", () => {
    const s = sink();
    const code = cmdHistory([], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/path/);
  });
});

describe("diff", () => {
  it("defaults to the last two versions and prints a unified diff", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "one\ntwo\n");
    writeArtifact(room, a.id, "draft.md", "one\nTWO\n");

    const s = sink();
    const code = cmdDiff(["draft.md", dir], s);

    expect(code).toBe(0);
    const text = s.outLines.join("\n");
    expect(text).toContain("-two");
    expect(text).toContain("+TWO");
  });

  it("accepts explicit --from and --to", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "first");
    writeArtifact(room, a.id, "draft.md", "second");
    const v3 = writeArtifact(room, a.id, "draft.md", "third");

    const s = sink();
    const code = cmdDiff(["draft.md", dir, "--from", String(v1.seq), "--to", String(v3.seq)], s);

    expect(code).toBe(0);
    const text = s.outLines.join("\n");
    expect(text).toContain("-first");
    expect(text).toContain("+third");
  });

  it("reports no differences instead of an empty diff", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "same");
    writeArtifact(room, a.id, "draft.md", "same");

    const s = sink();
    const code = cmdDiff(["draft.md", dir], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/No differences/);
  });

  it("refuses when there are fewer than two versions to compare", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "only one");

    const s = sink();
    const code = cmdDiff(["draft.md", dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/one recorded version/);
  });

  it("requires a path", () => {
    const s = sink();
    const code = cmdDiff([], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/path/);
  });
});

describe("running outside a room", () => {
  it("says so clearly and points at atrium init", () => {
    const dir = tempDir();
    const s = sink();

    // openRoom's error is an AtriumError, so it has to go through runCli the
    // same way a real invocation would, rather than being caught by cmdBoard.
    const code = runCli(["board", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/not an Atrium room/);
    expect(s.errLines.join("\n")).toMatch(/atrium init/);
  });
});

describe("help and usage", () => {
  it("--help at the top level exits cleanly with usage text", () => {
    const s = sink();
    const code = runCli(["--help"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium/);
  });

  it("shows the same help when run with no arguments", () => {
    const s = sink();
    const code = runCli([], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium/);
  });

  it("--help on a subcommand exits cleanly with that command's usage", () => {
    const s = sink();
    const code = cmdBoard(["--help"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium board/);
  });

  it("--version prints something", () => {
    const s = sink();
    const code = runCli(["--version"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n").trim().length).toBeGreaterThan(0);
  });

  it("gives a clear message for an unknown command", () => {
    const s = sink();
    const code = runCli(["frobnicate"], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/Unknown command/);
  });
});

describe("serve", () => {
  it("explains itself without starting a server", async () => {
    const s = sink();
    const code = await cmdServe(["--help"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/stdin\/stdout/);
    // Worth stating in the help: this command's stdout belongs to the protocol.
    expect(s.outLines.join("\n")).toMatch(/stdout/);
  });

  it("refuses a directory that is not a room", async () => {
    const dir = tempDir();
    await expect(cmdServe([dir], sink())).rejects.toThrow(/not an Atrium room/);
  });
});
