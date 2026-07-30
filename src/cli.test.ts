import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { claimTask, createTask } from "./board.js";
import { reviewTask, submitTask } from "./acceptance.js";
import { acquireLease, currentLease } from "./leases.js";
import { deleteArtifact, writeArtifact } from "./artifacts.js";
import { getContext, describeHistory } from "./context.js";
import { contentAt, loadBlob, storeBlob } from "./snapshots.js";
import { sha256 } from "./util.js";
import {
  cmdArtifacts,
  cmdBoard,
  cmdConfig,
  cmdContext,
  cmdDiff,
  cmdGc,
  cmdHistory,
  cmdInit,
  cmdInvite,
  cmdLease,
  cmdLeaseRelease,
  cmdLeases,
  cmdLog,
  cmdNote,
  cmdPrune,
  cmdOpen,
  cmdReplay,
  cmdRoster,
  cmdRun,
  cmdSearch,
  cmdServe,
  cmdTaskAdd,
  cmdTaskRelease,
  cmdTaskRenew,
  cmdTaskReview,
  cmdTaskShow,
  cmdTaskSweep,
  cmdTaskUnblock,
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

  it("--type filters to just that event type", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "hi" });

    const s = sink();
    const code = cmdLog(["--json", "--type", "note.posted", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain("hi");
  });

  it("--actor filters to just that member's events, by name", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "scout", role: "worker" });
    room.join({ name: "editor", role: "reviewer" });

    const s = sink();
    const code = cmdLog(["--json", "--actor", "editor", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toMatch(/editor joined/);
  });

  it("--contains filters to lines matching the text, case-insensitively", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "check the DRAFT" });

    const s = sink();
    const code = cmdLog(["--json", "--contains", "draft", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines.some((l: { line: string }) => l.line.includes("DRAFT"))).toBe(true);
  });

  it("--from and --to select an inclusive sequence range", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const a = room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "a" });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "b" });
    const c = room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "c" });

    const s = sink();
    const code = cmdLog(["--json", "--from", String(a.seq), "--to", String(c.seq), "--type", "note.posted", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines.map((l: { seq: number }) => l.seq)).toEqual([a.seq, a.seq + 1, c.seq]);
  });

  it("combining two filters intersects them rather than widening the result", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;
    room.log.append(scout.id, "note.posted", { memberId: scout.id, text: "draft ready" });
    room.log.append(editor.id, "note.posted", { memberId: editor.id, text: "draft ready" });

    const s = sink();
    const code = cmdLog(["--json", "--actor", "scout", "--contains", "draft", dir], s);
    const lines = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toMatch(/^scout/);
  });

  it("refuses an unknown --type and names the valid ones", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = runCli(["log", "--type", "task.acepted", dir], s);

    expect(code).not.toBe(0);
    const message = s.errLines.join("\n");
    expect(message).toMatch(/Unknown event type/);
    expect(message).toContain("task.accepted");
  });

  it("reports an empty result plainly, echoing back what was filtered on", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdLog(["--contains", "nothing will ever match this", dir], s);

    expect(code).toBe(0);
    const text = s.outLines.join("\n");
    expect(text).toMatch(/Nothing matched/);
    expect(text).toContain("nothing will ever match this");
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
    acquireLease(room, worker.id, "draft.md");
    const seq = room.log.head();

    const s = sink();
    const code = cmdReplay(["--json", String(seq), dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(data.seq).toBe(seq);
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.members).toEqual([
      expect.objectContaining({
        id: worker.id,
        name: "scout",
        active: true,
      }),
    ]);
    expect(data.leases).toEqual([
      expect.objectContaining({
        path: "draft.md",
        holder: worker.id,
        holderName: "scout",
      }),
    ]);
  });

  it("replays leases against the event's clock instead of the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { leaseSeconds: 60 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, worker.id, "draft.md");
    const leaseSeq = room.log.head();

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(currentLease(room, "draft.md")).toBeUndefined();

    const replayed = sink();
    const code = cmdReplay([String(leaseSeq), dir], replayed);
    const text = replayed.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("Artifact leases");
    expect(text).toContain("draft.md");
    expect(text).toContain("scout");
  });

  it("shows the roster as it was at the replayed sequence", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const replaySeq = room.log.head();

    room.leave(scout.id);
    room.join({ name: "future-editor", role: "reviewer" });

    const replayed = sink();
    const code = cmdReplay([String(replaySeq), dir], replayed);
    const text = replayed.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("Room roster");
    expect(text).toContain("scout");
    expect(text).toContain("active");
    expect(text).not.toContain("future-editor");
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

  it("--pin adds an artifact and --unpin removes it, round-tripping through the CLI", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "notes.md"), "things worth knowing");

    const pinned = sink();
    expect(cmdContext(["--pin", "notes.md", dir], pinned)).toBe(0);
    expect(pinned.outLines.join("\n")).toMatch(/Pinned notes\.md/);
    expect(getContext(room).pinned.map((p) => p.path)).toEqual(["notes.md"]);

    const unpinned = sink();
    expect(cmdContext(["--unpin", "notes.md", dir], unpinned)).toBe(0);
    expect(unpinned.outLines.join("\n")).toMatch(/Unpinned notes\.md/);
    expect(getContext(room).pinned).toEqual([]);
  });

  it("--pin provisions the CLI's own human member rather than requiring one already exist", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "notes.md"), "hello");

    expect(cmdContext(["--pin", "notes.md", dir], sink())).toBe(0);

    const humans = room.roster().filter((m) => m.role === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0]?.name).toBe("cli");
  });

  it("says a file is already pinned rather than pinning it again", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "notes.md"), "hello");
    cmdContext(["--pin", "notes.md", dir], sink());

    const before = room.log.head();
    const s = sink();
    const code = cmdContext(["--pin", "notes.md", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/already pinned/);
    expect(room.log.head()).toBe(before); // no duplicate context.pinned event
  });

  it("says a file was not pinned rather than silently succeeding on --unpin", () => {
    const { dir, room } = tempRoom();
    // ensureCliHuman provisions the "cli" member on its first touch of the
    // room, so the log gains that one event; what matters here is that no
    // context.unpinned event follows it.
    const before = room.log.head();
    const s = sink();
    const code = cmdContext(["--unpin", "never-pinned.md", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/was not pinned/);
    expect(room.log.head()).toBe(before + 1); // the "cli" member joining, nothing else
  });

  it("refuses --pin and --unpin together", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdContext(["--pin", "a.md", "--unpin", "b.md", dir], s);
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/either --pin or --unpin/);
  });

  it("a pin refused by the ceiling names the ceiling, the cost, and what's already pinned", () => {
    const { dir, room } = tempRoom({ config: { contextTokenCeiling: 30 } });
    writeFileSync(join(room.dir, "small.md"), "keep me");
    writeFileSync(join(room.dir, "big.md"), "x".repeat(400));
    expect(cmdContext(["--pin", "small.md", dir], sink())).toBe(0);

    const s = sink();
    const code = runCli(["context", "--pin", "big.md", dir], s);
    const msg = s.errLines.join("\n");

    expect(code).not.toBe(0);
    expect(msg).toContain(String(room.config.contextTokenCeiling));
    expect(msg).toContain("small.md"); // the concrete thing to unpin instead
    expect(msg).toMatch(/raise contextTokenCeiling/);

    // The refusal did not pin anything.
    expect(getContext(room).pinned.map((p) => p.path)).toEqual(["small.md"]);
  });
});

describe("config", () => {
  it("lists every setting with its current value, marking the shipped default", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/actionBudget\s+1000\s+\(default\)/);
    expect(text).toMatch(/allowUncheckedAcceptance\s+false\s+\(default\)/);
  });

  it("marks a setting that differs from the default as set, not default", () => {
    const { dir } = tempRoom({ config: { maxAttempts: 1 } });
    const s = sink();
    const code = cmdConfig([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/maxAttempts\s+1\s+\(set\)/);
    expect(text).toMatch(/leaseSeconds\s+300\s+\(default\)/);
  });

  it("--json produces a parseable listing with key, value, default, and isDefault", () => {
    const { dir } = tempRoom({ config: { maxAttempts: 1 } });
    const s = sink();
    const code = cmdConfig(["--json", dir], s);
    const settings = JSON.parse(s.outLines.join("\n")) as Array<{
      key: string;
      value: unknown;
      default: unknown;
      isDefault: boolean;
    }>;

    expect(code).toBe(0);
    const maxAttempts = settings.find((x) => x.key === "maxAttempts");
    expect(maxAttempts).toMatchObject({ value: 1, default: 3, isDefault: false });
    const leaseSeconds = settings.find((x) => x.key === "leaseSeconds");
    expect(leaseSeconds).toMatchObject({ value: 300, isDefault: true });
  });

  it("sets one setting and it round-trips through a reopened room", () => {
    const { dir, room } = tempRoom();
    const s = sink();
    const code = cmdConfig(["actionBudget", "5000", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/actionBudget is now 5000 \(was 1000\)/);

    room.close();
    const again = Room.open(dir);
    try {
      expect(again.config.actionBudget).toBe(5000);
    } finally {
      again.close();
    }
  });

  it("rejects a value that cannot be coerced to the setting's type", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["actionBudget", "banana", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/actionBudget must be/);
  });

  it("rejects a negative actionBudget, saying what is allowed instead", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["actionBudget", "-5", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/1 or more/);
  });

  it("rejects a maxAttempts of zero", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["maxAttempts", "0", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/1 or more/);
  });

  it("rejects a leaseSeconds of zero", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["leaseSeconds", "0", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/1 or more/);
  });

  it("accepts 0 for the settings that document 0 as meaning no cap", () => {
    const { dir, room } = tempRoom({
      config: { roomSpendCapUsd: 5, memberSpendCapUsd: 5, retainVersionsPerPath: 3 },
    });

    for (const key of ["roomSpendCapUsd", "memberSpendCapUsd", "retainVersionsPerPath"]) {
      const s = sink();
      const code = cmdConfig([key, "0", dir], s);
      expect(code).toBe(0);
    }

    room.close();
    const again = Room.open(dir);
    try {
      expect(again.config.roomSpendCapUsd).toBe(0);
      expect(again.config.memberSpendCapUsd).toBe(0);
      expect(again.config.retainVersionsPerPath).toBe(0);
    } finally {
      again.close();
    }
  });

  it("accepts a fractional roomSpendCapUsd, since dollars are not whole numbers", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["roomSpendCapUsd", "12.5", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/roomSpendCapUsd is now 12\.5/);
  });

  it("warns when turning on allowUncheckedAcceptance, but still applies the change", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["allowUncheckedAcceptance", "true", dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/allowUncheckedAcceptance is now true/);
    expect(text).toMatch(/Warning:/);
    expect(text).toMatch(/self-declared completion/);

    const again = Room.open(dir);
    try {
      expect(again.config.allowUncheckedAcceptance).toBe(true);
    } finally {
      again.close();
    }
  });

  it("does not warn turning allowUncheckedAcceptance off, or on an ordinary setting", () => {
    const { dir } = tempRoom({ config: { allowUncheckedAcceptance: true } });
    const s = sink();
    const code = cmdConfig(["allowUncheckedAcceptance", "false", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).not.toMatch(/Warning:/);
  });

  it("warns that lowering actionBudget to or below the recorded action count halts the room next", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "a", role: "worker" });
    room.join({ name: "b", role: "worker" });
    const used = room.log.count();

    const s = sink();
    const code = cmdConfig(["actionBudget", String(used), dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/Warning:/);
    expect(text).toMatch(/halt the next time/);
  });

  it("does not warn when raising actionBudget comfortably above what has been recorded", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "a", role: "worker" });

    const s = sink();
    const code = cmdConfig(["actionBudget", "5000", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).not.toMatch(/Warning:/);
  });

  it("refuses an unknown setting and names the valid ones", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["bogusSetting", "1", dir], s);
    const msg = s.errLines.join("\n");

    expect(code).not.toBe(0);
    expect(msg).toMatch(/Unknown setting/);
    expect(msg).toContain("actionBudget");
    expect(msg).toContain("allowUncheckedAcceptance");
  });

  it("rejects extra positional arguments past key, value, and dir", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdConfig(["actionBudget", "500", dir, "extra"], s);
    expect(code).not.toBe(0);
  });

  it("is wired into the top-level dispatcher", () => {
    const { dir } = tempRoom();
    const s = sink();
    expect(runCli(["config", dir], s)).toBe(0);
  });

  it("--help exits cleanly with usage text", () => {
    const s = sink();
    const code = cmdConfig(["--help"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium config/);
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

describe("artifacts", () => {
  it("lists each artifact with its size, log position, and the member name that wrote it", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");
    writeArtifact(room, scout.id, "draft.md", "hello");

    const s = sink();
    const code = cmdArtifacts([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("draft.md");
    expect(text).toContain("5 bytes");
    expect(text).toContain("scout");
  });

  it("--json resolves the author's name alongside their raw id", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");
    writeArtifact(room, scout.id, "draft.md", "hello");

    const s = sink();
    const code = cmdArtifacts(["--json", dir], s);
    const result = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe("draft.md");
    expect(result.artifacts[0].lastWrittenBy).toBe(scout.id);
    expect(result.artifacts[0].lastWrittenByName).toBe("scout");
    // Not asked for, so it is left out rather than reported as an
    // uninformative empty array.
    expect(result.deleted).toBeUndefined();
  });

  it("leaves a deleted path out of the live list, and only shows it under its own heading when asked", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "gone.md");
    writeArtifact(room, scout.id, "gone.md", "bye");
    deleteArtifact(room, scout.id, "gone.md");

    const withoutFlag = sink();
    cmdArtifacts(["--json", dir], withoutFlag);
    const plain = JSON.parse(withoutFlag.outLines.join("\n"));
    expect(plain.artifacts).toEqual([]);
    expect(plain.deleted).toBeUndefined();

    const withFlag = sink();
    cmdArtifacts(["--json", "--include-deleted", dir], withFlag);
    const withDeleted = JSON.parse(withFlag.outLines.join("\n"));
    expect(withDeleted.artifacts).toEqual([]);
    expect(withDeleted.deleted).toHaveLength(1);
    expect(withDeleted.deleted[0].path).toBe("gone.md");
    expect(withDeleted.deleted[0].deletedByName).toBe("scout");

    // The human-readable form keeps the same separation: two headings, not
    // one table with a deleted row mixed in.
    const text = sink();
    cmdArtifacts(["--include-deleted", dir], text);
    const rendered = text.outLines.join("\n");
    expect(rendered).toMatch(/Deleted \(1\)/);
    expect(rendered).toContain("gone.md");
  });

  it("says plainly that there are no artifacts yet, rather than printing an empty table", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdArtifacts([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/no artifacts/i);
  });

  it("does not surface a file dropped into the room's working directory by hand", () => {
    const { dir, room } = tempRoom();
    writeFileSync(join(room.dir, "untracked.md"), "surprise");

    const s = sink();
    const code = cmdArtifacts(["--json", dir], s);
    const result = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(result.artifacts).toEqual([]);
  });

  it("is wired into the top-level dispatcher", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");
    writeArtifact(room, scout.id, "draft.md", "hi");

    const s = sink();
    expect(runCli(["artifacts", dir], s)).toBe(0);
  });

  it("--help exits cleanly with usage text", () => {
    const s = sink();
    const code = cmdArtifacts(["--help"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium artifacts/);
  });
});

describe("note", () => {
  it("posts a note that lands in the log under the cli's own human identity", () => {
    const { dir, room } = tempRoom();
    const s = sink();

    const code = cmdNote(["the client changed the deadline", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Noted/);

    const lines = describeHistory(room).map((h) => h.line);
    expect(lines.some((l) => l.includes("cli noted: the client changed the deadline"))).toBe(true);

    const cli = room.roster().find((m) => m.name === "cli");
    expect(cli?.role).toBe("human");
  });

  it("attaches a note to a real task", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    const s = sink();
    const code = cmdNote(["ignore the third source, it is wrong", dir, "--task", task.id], s);

    expect(code).toBe(0);
    const lines = describeHistory(room).map((h) => h.line);
    expect(
      lines.some(
        (l) => l.includes(`noted on task ${task.id}`) && l.includes("ignore the third source"),
      ),
    ).toBe(true);
  });

  it("refuses a note naming a task that does not exist", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = runCli(["note", "about a task", dir, "--task", "task_doesnotexist"], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/No task task_doesnotexist/);
  });

  it("refuses an empty note", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdNote(["   ", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/needs text to record/);
  });

  it("refuses a note over the length cap", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdNote(["x".repeat(4001), dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/at most 4000 characters/);
  });

  it("accepts a note right at the length cap", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdNote(["x".repeat(4000), dir], s);

    expect(code).toBe(0);
  });

  it("provisions the cli's own human member rather than requiring one already exist", () => {
    const { dir, room } = tempRoom();
    cmdNote(["hello room", dir], sink());

    const humans = room.roster().filter((m) => m.role === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0]?.name).toBe("cli");
  });

  it("is wired into the top-level dispatcher", () => {
    const { dir } = tempRoom();
    const s = sink();
    expect(runCli(["note", "dispatched fine", dir], s)).toBe(0);
  });

  it("--help exits cleanly with usage text", () => {
    const s = sink();
    const code = cmdNote(["--help"], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Usage: atrium note/);
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

describe("gc", () => {
  it("says there is nothing to reclaim when every object is referenced", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "one");
    writeArtifact(room, a.id, "draft.md", "two");

    const s = sink();
    const code = cmdGc([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Nothing to reclaim/);
  });

  it("reports what it removed, and leaves history readable", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "kept");
    const orphan = Buffer.from("unreferenced", "utf8");
    storeBlob(room, sha256(orphan), orphan);

    const s = sink();
    const code = cmdGc([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Removed 1 unreferenced object/);
    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("kept");
  });

  it("removes nothing on --dry-run", () => {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "kept");
    const orphan = Buffer.from("unreferenced", "utf8");
    const orphanHash = sha256(orphan);
    storeBlob(room, orphanHash, orphan);

    const s = sink();
    const code = cmdGc([dir, "--dry-run"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Would remove 1 unreferenced object/);
    expect(loadBlob(room, orphanHash)).toBeDefined();
  });
});

describe("prune", () => {
  function roomWithVersions() {
    const { dir, room } = tempRoom();
    const a = room.join({ name: "a", role: "worker" }).member;
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    writeArtifact(room, a.id, "draft.md", "two");
    writeArtifact(room, a.id, "draft.md", "three");
    return { dir, room, v1 };
  }

  it("refuses to guess when the room has no retention policy set", () => {
    const { dir } = roomWithVersions();

    const s = sink();
    const code = cmdPrune([dir], s);

    // Discarding history on a default of somebody's choosing would be the
    // wrong kind of helpful.
    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/retainVersionsPerPath/);
  });

  it("applies --keep and reports what went", () => {
    const { dir, room, v1 } = roomWithVersions();

    const s = sink();
    const code = cmdPrune([dir, "--keep", "1"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/dropped 2 versions/);
    expect(contentAt(room, "draft.md", v1.seq)).toBeUndefined();
  });

  it("uses the room's policy when one is set", () => {
    const { dir, room } = roomWithVersions();
    room.updateConfig({ retainVersionsPerPath: 2 });

    const s = sink();
    const code = cmdPrune([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/dropped 1 version\b/);
  });

  it("changes nothing on --dry-run and says so", () => {
    const { dir, room, v1 } = roomWithVersions();

    const s = sink();
    const code = cmdPrune([dir, "--keep", "1", "--dry-run"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/would drop 2 versions/);
    expect(s.outLines.join("\n")).toMatch(/Nothing was changed/);
    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("one");
  });

  it("rejects a --keep that would leave nothing", () => {
    const { dir } = roomWithVersions();
    const s = sink();
    expect(cmdPrune([dir, "--keep", "0"], s)).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/1 or more/);
  });
});

describe("leases", () => {
  it("lists a held lease with the holder's name, not just their id", () => {
    const { dir, room } = tempRoom({ config: { leaseSeconds: 300 } });
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const s = sink();
    const code = cmdLeases([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("draft.md");
    expect(text).toContain("scout");
    expect(text).toMatch(/left/);
  });

  it("--json resolves the holder's name alongside their id", () => {
    const { dir, room } = tempRoom({ config: { leaseSeconds: 300 } });
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const s = sink();
    const code = cmdLeases(["--json", dir], s);
    const leases = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(leases).toHaveLength(1);
    expect(leases[0].path).toBe("draft.md");
    expect(leases[0].holder).toBe(scout.id);
    expect(leases[0].holderName).toBe("scout");
  });

  it("says plainly that nothing is leased, rather than printing an empty table", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdLeases([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/no paths are currently leased/i);
  });

  it("does not report a lapsed lease as held", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { leaseSeconds: 60 } });
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    // Well past the 60-second lease, but the lease.acquired event is still
    // sitting in the log — this is exactly the case foldLeases exists to get
    // right, and the CLI must not paper over it.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

    const s = sink();
    const code = cmdLeases(["--json", dir], s);
    const leases = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(leases).toEqual([]);
  });
});

describe("lease release", () => {
  it("forces another member's live lease off, naming whose it was, and the path becomes writable by someone else", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const other = room.join({ name: "relay", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const s = sink();
    const code = cmdLeaseRelease(["draft.md", dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toContain("scout");
    expect(s.outLines.join("\n")).toContain("draft.md");
    expect(currentLease(room, "draft.md")).toBeUndefined();

    // The point of the command: somebody else can now hold and write the path.
    acquireLease(room, other.id, "draft.md");
    expect(currentLease(room, "draft.md")?.holder).toBe(other.id);
    expect(writeArtifact(room, other.id, "draft.md", "relay's turn").lastWrittenBy).toBe(
      other.id,
    );
  });

  it("records the forced release in the log under the cli's own human identity, distinct from whoever lost the lease", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const code = cmdLeaseRelease(["draft.md", dir], sink());
    expect(code).toBe(0);

    const lines = describeHistory(room).map((h) => h.line);
    const line = lines.find((l) => l.includes("force-released"));
    expect(line).toBeDefined();
    // "cli" is the auto-provisioned human identity documented in
    // ensureCliHuman/atrium task --help, and "scout" is who actually held it —
    // atrium log has to be able to tell a reader both facts, not just that a
    // release happened.
    expect(line).toContain("cli");
    expect(line).toContain("scout");
    expect(line).toContain("draft.md");
  });

  it("refuses plainly when the path has never been leased at all", () => {
    const { dir } = tempRoom();
    const s = sink();
    // releaseLease's LeaseError is an AtriumError, and per this file's header
    // comment those are only turned into an exit code and a message in
    // runCli, not inside the command itself — same as "running outside a
    // room" below.
    const code = runCli(["lease", "release", "never-touched.md", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/nobody has ever leased it/);
  });

  it("refuses plainly when the lease has already lapsed, distinct from 'never leased'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { leaseSeconds: 60 } });
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

    const s = sink();
    const code = runCli(["lease", "release", "draft.md", dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/already lapsed/);
  });

  it("needs a path", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdLeaseRelease([], s);
    expect(code).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/needs a path/);
  });

  it("is reachable both as \"atrium lease release\" and directly", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const s = sink();
    const code = runCli(["lease", "release", "draft.md", dir], s);

    expect(code).toBe(0);
    expect(currentLease(room, "draft.md")).toBeUndefined();
  });

  it("\"atrium lease list\" is the same listing as \"atrium leases\"", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    acquireLease(room, scout.id, "draft.md");

    const viaNoun = sink();
    cmdLease(["list", "--json", dir], viaNoun);
    const viaPlural = sink();
    cmdLeases(["--json", dir], viaPlural);

    expect(viaNoun.outLines.join("\n")).toBe(viaPlural.outLines.join("\n"));
  });

  it("rejects an unknown \"atrium lease\" subcommand", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdLease(["bogus", dir], s);
    expect(code).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/Unknown "atrium lease" subcommand/);
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

// ---------------------------------------------------------------------------
// task — the human's hands on the board
// ---------------------------------------------------------------------------

describe("task add", () => {
  it("creates a task and prints its id", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdTaskAdd([dir, "--title", "Write the draft"], s);

    expect(code).toBe(0);
    const printed = s.outLines.join("\n");
    expect(printed).toMatch(/Created task_/);

    const board = sink();
    cmdBoard(["--json", dir], board);
    const tasks = JSON.parse(board.outLines.join("\n"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Write the draft");
    expect(tasks[0].acceptance).toEqual({ kind: "reviewer" });
  });

  it('refuses "none" acceptance when the room forbids it, and says why', () => {
    // allowUncheckedAcceptance is off by default.
    const { dir } = tempRoom();
    const s = sink();

    const code = runCli(["task", "add", dir, "--title", "Quick thing", "--acceptance", "none"], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/does not allow "none"/);
  });

  it("provisions a stable local human member the first time it runs", () => {
    const { dir, room } = tempRoom();
    cmdTaskAdd([dir, "--title", "one"], sink());
    cmdTaskAdd([dir, "--title", "two"], sink());

    const humans = room.roster().filter((m) => m.role === "human");
    expect(humans).toHaveLength(1);
  });

  it("accepts --command-timeout as a per-task override on a command acceptance", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdTaskAdd(
      [dir, "--title", "full suite", "--acceptance", "command", "--command", "npm test", "--command-timeout", "300"],
      s,
    );

    expect(code).toBe(0);
    const board = sink();
    cmdBoard(["--json", dir], board);
    const tasks = JSON.parse(board.outLines.join("\n"));
    expect(tasks[0].acceptance).toEqual({
      kind: "command",
      command: "npm test",
      timeoutSeconds: 300,
    });
  });

  it("refuses a nonsense --command-timeout with a message saying what is allowed", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdTaskAdd(
      [dir, "--title", "full suite", "--acceptance", "command", "--command", "npm test", "--command-timeout", "0"],
      s,
    );

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/greater than 0/);
  });

  it("refuses --command-timeout without --acceptance command", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdTaskAdd([dir, "--title", "one", "--command-timeout", "30"], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/--command-timeout only makes sense/);
  });
});

describe("task show", () => {
  it("reports state, acceptance, dependencies, attempts, and escalation", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const dep = createTask(room, worker.id, { title: "research" });
    const task = createTask(room, worker.id, { title: "draft", dependsOn: [dep.id] });

    const s = sink();
    const code = cmdTaskShow(["--json", task.id, dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(data.id).toBe(task.id);
    expect(data.state).toBe("blocked");
    expect(data.unmetDependencies).toEqual([dep.id]);
    expect(data.attempts).toBe(0);
    expect(data.escalated).toBe(false);
  });
});

describe("task review", () => {
  it("requires --reason when rejecting", () => {
    const { dir } = tempRoom();
    const s = sink();

    const code = cmdTaskReview(["task_whatever", dir, "--reject"], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/--reason/);
  });

  it("lets a human accept submitted work", async () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);
    await submitTask(room, worker.id, task.id, { summary: "first pass" });

    const s = sink();
    const code = cmdTaskReview([task.id, dir, "--accept"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/accepted/);
  });

  it("still refuses a member accepting its own work, even for the cli's own human identity", async () => {
    const { dir, room } = tempRoom();

    // Provision the CLI's own identity first, exactly as "atrium task add" would.
    cmdTaskAdd([dir, "--title", "solo work"], sink());
    const cli = room.roster().find((m) => m.name === "cli")!;
    const board = sink();
    cmdBoard(["--json", dir], board);
    const taskId = JSON.parse(board.outLines.join("\n"))[0].id as string;

    claimTask(room, cli.id, taskId);
    await submitTask(room, cli.id, taskId, { summary: "did it myself" });

    const s = sink();
    const code = runCli(["task", "review", taskId, dir, "--accept"], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/cannot also be the one who checks it/);
  });
});

describe("task release", () => {
  it("forces a claimed task back onto the board", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);

    const s = sink();
    const code = cmdTaskRelease([task.id, dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/released/);

    const show = sink();
    cmdTaskShow(["--json", task.id, dir], show);
    expect(JSON.parse(show.outLines.join("\n")).state).toBe("open");
  });
});

describe("task renew", () => {
  it("extends a claim held by the CLI's own human identity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { claimSeconds: 60 } });
    // "cli" is the CLI's own auto-provisioned identity (ensureCliHuman).
    // Joining it by hand here and giving it a claim is the only way to make
    // "atrium task renew" actually succeed in a test: claiming a task
    // happens over MCP as a worker, and there is no "atrium task claim"
    // command, which is exactly what this command's help text warns is the
    // unusual case.
    const cli = room.join({ name: "cli", role: "human" }).member;
    const task = createTask(room, cli.id, { title: "draft" });
    claimTask(room, cli.id, task.id);

    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    const s = sink();
    const code = cmdTaskRenew([task.id, dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/renewed/);

    // Past the original 60-second window, still claimed by the same holder.
    vi.setSystemTime(new Date("2026-01-01T00:01:15.000Z"));
    const show = sink();
    cmdTaskShow(["--json", task.id, dir], show);
    expect(JSON.parse(show.outLines.join("\n")).state).toBe("claimed");
  });

  it("refuses a claim held by somebody else", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, scout.id, { title: "draft" });
    claimTask(room, scout.id, task.id);

    const s = sink();
    const code = runCli(["task", "renew", task.id, dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/not you/);
  });

  it("refuses a task that was never claimed", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, scout.id, { title: "draft" });

    const s = sink();
    const code = runCli(["task", "renew", task.id, dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/not claimed/);
  });

  it("refuses a claim that already lapsed, and does not resurrect it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { claimSeconds: 60 } });
    const cli = room.join({ name: "cli", role: "human" }).member;
    const task = createTask(room, cli.id, { title: "draft" });
    claimTask(room, cli.id, task.id);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const s = sink();
    const code = runCli(["task", "renew", task.id, dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/expired/);

    // Left exactly as open as the live board already showed; somebody else
    // can claim it fresh through the ordinary path.
    const other = room.join({ name: "other", role: "worker" }).member;
    expect(claimTask(room, other.id, task.id).claimedBy).toBe(other.id);
  });
});

describe("task sweep", () => {
  it("reclaims a lapsed claim and records it in the log, and is harmless to run again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { dir, room } = tempRoom({ config: { claimSeconds: 60 } });
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, scout.id, { title: "draft" });
    claimTask(room, scout.id, task.id);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    const s = sink();
    const code = cmdTaskSweep([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/reclaimed/i);
    expect(s.outLines.join("\n")).toContain(task.id);

    const lines = describeHistory(room).map((h) => h.line);
    expect(lines.some((l) => l.includes("claim expired"))).toBe(true);

    const again = sink();
    const code2 = cmdTaskSweep([dir], again);
    expect(code2).toBe(0);
    expect(again.outLines.join("\n")).toMatch(/nothing to sweep/i);
  });

  it("reports nothing to sweep when no claims have lapsed", () => {
    const { dir, room } = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, scout.id, { title: "draft" });
    claimTask(room, scout.id, task.id);

    const s = sink();
    const code = cmdTaskSweep([dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/nothing to sweep/i);
  });
});

describe("task unblock", () => {
  it("restarts a task frozen by escalation, leaving its attempt count alone", async () => {
    const { dir, room } = tempRoom({ config: { maxAttempts: 1 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const reviewer = room.join({ name: "critic", role: "reviewer" }).member;
    const task = createTask(room, worker.id, { title: "draft" });
    claimTask(room, worker.id, task.id);
    await submitTask(room, worker.id, task.id, { summary: "v1" });
    reviewTask(room, reviewer.id, task.id, { accept: false, reason: "not good enough" });

    const before = sink();
    cmdTaskShow(["--json", task.id, dir], before);
    expect(JSON.parse(before.outLines.join("\n")).escalated).toBe(true);

    const s = sink();
    const code = cmdTaskUnblock([task.id, dir], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/restarted/);

    const after = sink();
    cmdTaskShow(["--json", task.id, dir], after);
    const data = JSON.parse(after.outLines.join("\n"));
    expect(data.escalated).toBe(false);
    expect(data.attempts).toBe(1);

    // And it can actually be claimed again.
    const claimed = claimTask(room, worker.id, task.id);
    expect(claimed.state).toBe("claimed");
  });

  it("refuses to restart a task that was never escalated", () => {
    const { dir, room } = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "draft" });

    const s = sink();
    const code = runCli(["task", "unblock", task.id, dir], s);

    expect(code).not.toBe(0);
    expect(s.errLines.join("\n")).toMatch(/not escalated/);
  });
});

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------

describe("roster", () => {
  it("shows each member's role, active status, tags, and manifest", () => {
    const { dir, room } = tempRoom();
    room.join({
      name: "scout",
      role: "worker",
      manifest: "Finds sources and summarizes them.",
      tags: ["research", "web"],
    });

    const s = sink();
    const code = cmdRoster([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("scout");
    expect(text).toContain("worker");
    expect(text).toContain("active");
    expect(text).toContain("research, web");
    expect(text).toContain("Finds sources and summarizes them.");
  });

  it("shows a member who has left as left, rather than hiding or dropping them", () => {
    const { dir, room } = tempRoom();
    const { member } = room.join({ name: "scout", role: "worker" });
    room.leave(member.id);

    const s = sink();
    const code = cmdRoster([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("scout");
    expect(text).toMatch(/— left/);
  });

  it("--active filters out members who have left", () => {
    const { dir, room } = tempRoom();
    const { member } = room.join({ name: "gone", role: "worker" });
    room.leave(member.id);
    room.join({ name: "still-here", role: "worker" });

    const s = sink();
    const code = cmdRoster(["--active", dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("still-here");
    expect(text).not.toContain("gone");
  });

  it("does not produce ugly output for a member with no manifest or tags", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "quiet", role: "worker" });

    const s = sink();
    const code = cmdRoster([dir], s);
    const text = s.outLines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("quiet");
    expect(text).toMatch(/no manifest given/);
    expect(text).toMatch(/\(none\)/);
    expect(text).not.toMatch(/undefined/);
  });

  it("--json produces parseable JSON matching Room.roster()'s shape", () => {
    const { dir, room } = tempRoom();
    room.join({ name: "scout", role: "worker", manifest: "does things", tags: ["a"] });

    const s = sink();
    const code = cmdRoster(["--json", dir], s);
    const data = JSON.parse(s.outLines.join("\n"));

    expect(code).toBe(0);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("scout");
    expect(data[0].manifest).toBe("does things");
    expect(data[0].tags).toEqual(["a"]);
    expect(data[0].active).toBe(true);
  });

  it("says plainly when nobody has joined yet", () => {
    const { dir } = tempRoom();
    const s = sink();
    const code = cmdRoster([dir], s);
    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Nobody has joined/);
  });
});

describe("run", () => {
  it("shows the worker environment contract in help", async () => {
    const s = sink();
    const code = await cmdRun(["--help"], s);

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toContain("ATRIUM_TASK_ID");
    expect(s.outLines.join("\n")).toContain("--dry-run");
  });

  it("prints a bounded assignment plan without launching workers", async () => {
    const { dir, room } = tempRoom();
    const owner = room.join({ name: "owner", role: "human" }).member;
    const task = createTask(room, owner.id, { title: "Build the adapter" });
    const s = sink();

    const code = await cmdRun(
      [dir, "--worker", "codex=node worker.mjs", "--dry-run"],
      s,
    );

    expect(code).toBe(0);
    expect(s.outLines.join("\n")).toContain("codex");
    expect(s.outLines.join("\n")).toContain(task.id);
    expect(s.outLines.join("\n")).toContain("Build the adapter");
    expect(s.outLines.join("\n")).toMatch(/no workers were launched/i);
  });
});
