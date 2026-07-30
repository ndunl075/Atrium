import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { submitTask, reviewTask } from "./acceptance.js";
import { claimTask, createTask, listTasks } from "./board.js";
import { cmdFork, type Sink } from "./cli.js";
import { deleteArtifact, writeArtifact } from "./artifacts.js";
import { forkRoom, planFork } from "./fork.js";
import { acquireLease } from "./leases.js";
import { Room } from "./room.js";
import { listVersions, pruneVersions } from "./snapshots.js";
import type { MemberId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atrium-fork-"));
  dirs.push(dir);
  return dir;
}

function track(room: Room): Room {
  rooms.push(room);
  return room;
}

function member(room: Room, name: string, role: "worker" | "reviewer" | "human"): MemberId {
  return room.join({ name, role }).member.id;
}

/** Writes a path, taking the lease it needs first. */
function write(room: Room, actor: MemberId, path: string, content: string): void {
  acquireLease(room, actor, path);
  writeArtifact(room, actor, path, content);
}

afterEach(() => {
  while (rooms.length) {
    try {
      rooms.pop()!.close();
    } catch {
      // Already closed by the code under test.
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A room with a story in it: sources written and accepted, then a draft
 * handed in and turned down, then a second draft accepted. The interesting
 * fork points are on either side of that rejection.
 */
function storyRoom(): {
  room: Room;
  base: string;
  scout: MemberId;
  editor: MemberId;
  draftTask: string;
  rejectedAt: number;
} {
  const base = workspace();
  const room = track(Room.create(join(base, "parent")));

  const scout = member(room, "scout", "worker");
  const editor = member(room, "editor", "reviewer");

  const sources = createTask(room, editor, { title: "Gather sources" });
  claimTask(room, scout, sources.id);
  write(room, scout, "sources.md", "one\ntwo\n");
  submitTask(room, scout, sources.id, { summary: "done" });
  reviewTask(room, editor, sources.id, { accept: true });

  const draft = createTask(room, editor, { title: "Write the piece" });
  claimTask(room, scout, draft.id);
  write(room, scout, "draft.md", "first draft, with a claim nothing supports\n");
  submitTask(room, scout, draft.id, { summary: "first" });
  const rejected = reviewTask(room, editor, draft.id, {
    accept: false,
    reason: "nothing supports that",
  });

  claimTask(room, scout, draft.id);
  write(room, scout, "draft.md", "second draft, corrected\n");
  submitTask(room, scout, draft.id, { summary: "second" });
  reviewTask(room, editor, draft.id, { accept: true });

  const rejectedAt = room.log.read({ types: ["task.rejected"] })[0]!.seq;
  void rejected;

  return { room, base, scout, editor, draftTask: draft.id, rejectedAt };
}

describe("planFork", () => {
  it("refuses a fork point past the end of the log", () => {
    const { room } = storyRoom();
    const head = room.log.head();
    expect(() => planFork(room, head + 1)).toThrow(
      new RegExp(`log ends at ${head}, so there is no event ${head + 1}`),
    );
  });

  it("refuses a fork point that is not a whole event number", () => {
    const { room } = storyRoom();
    for (const bad of [0, -1, 1.5]) {
      expect(() => planFork(room, bad)).toThrow(/whole event number, 1 or greater/);
    }
  });

  it("counts what would come across without writing anything", () => {
    const { room, rejectedAt } = storyRoom();
    const plan = planFork(room, rejectedAt);

    expect(plan.atSeq).toBe(rejectedAt);
    expect(plan.parentHead).toBe(room.log.head());
    expect(plan.events).toBe(rejectedAt);
    expect(plan.members).toBe(2);
    expect(plan.tasks).toBe(2);
    expect(plan.files.map((f) => f.path).sort()).toEqual(["draft.md", "sources.md"]);
    expect(plan.gaps).toEqual([]);
    expect(plan.inheritsHalt).toBe(false);
  });
});

describe("forkRoom", () => {
  it("copies history with the parent's sequence numbers and timestamps intact", () => {
    const { room, base, rejectedAt } = storyRoom();
    const fork = track(Room.open(forkRoom(room, join(base, "variant"), { at: rejectedAt }).dir));

    const parentEvents = room.log.read({ to: rejectedAt });
    const forkEvents = fork.log.read({ to: rejectedAt });

    // Not "equivalent" — identical. Every basedOnSeq and artifact version in
    // the copied events refers to these numbers.
    expect(forkEvents).toEqual(parentEvents);
  });

  it("records where it came from, after the copied history", () => {
    const { room, base, rejectedAt } = storyRoom();
    const result = forkRoom(room, join(base, "variant"), { at: rejectedAt });
    const fork = track(Room.open(result.dir));

    const marker = fork.log.at(rejectedAt + 1);
    expect(marker?.type).toBe("room.forked");
    expect(marker?.data).toMatchObject({
      fromRoomId: room.config.id,
      fromName: room.config.name,
      atSeq: rejectedAt,
      unrecoverablePaths: [],
    });
    expect(fork.log.head()).toBe(rejectedAt + 1);
  });

  it("gives the fork a board matching the parent's at that point, not now", () => {
    const { room, base, draftTask, rejectedAt } = storyRoom();
    const fork = track(Room.open(forkRoom(room, join(base, "variant"), { at: rejectedAt }).dir));

    const parentNow = listTasks(room).find((task) => task.id === draftTask);
    const inFork = listTasks(fork).find((task) => task.id === draftTask);

    expect(parentNow?.state).toBe("accepted");
    // As of the rejection, the draft was back on the board with a reason.
    expect(inFork?.state).toBe("rejected");
    expect(inFork?.lastRejection?.reason).toBe("nothing supports that");
  });

  it("materializes artifacts as they stood at the fork point", () => {
    const { room, base, rejectedAt } = storyRoom();
    const result = forkRoom(room, join(base, "variant"), { at: rejectedAt });

    expect(readFileSync(join(result.dir, "draft.md"), "utf8")).toMatch(/first draft/);
    expect(readFileSync(join(room.dir, "draft.md"), "utf8")).toMatch(/second draft/);
  });

  it("brings the inherited history with it, so the fork can diff its own past", () => {
    const { room, base } = storyRoom();
    const head = room.log.head();
    const fork = track(Room.open(forkRoom(room, join(base, "variant"), { at: head }).dir));

    // Both versions of draft.md are readable in the fork, which is the whole
    // argument for copying blobs rather than only the current bytes.
    const versions = listVersions(fork, "draft.md");
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.hash)).toEqual(
      listVersions(room, "draft.md").map((v) => v.hash),
    );
  });

  it("restores a file that existed at the fork point and was deleted later", () => {
    const { room, base, scout } = storyRoom();
    const beforeDelete = room.log.head();

    acquireLease(room, scout, "sources.md");
    deleteArtifact(room, scout, "sources.md");
    expect(existsSync(join(room.dir, "sources.md"))).toBe(false);

    const result = forkRoom(room, join(base, "variant"), { at: beforeDelete });
    expect(readFileSync(join(result.dir, "sources.md"), "utf8")).toBe("one\ntwo\n");
  });

  it("leaves out a file that had not been written yet at the fork point", () => {
    const { room, base } = storyRoom();
    const beforeDraft = room.log
      .read({ types: ["artifact.written"] })
      .find((event) => (event.data as { path: string }).path === "draft.md")!.seq;

    const result = forkRoom(room, join(base, "variant"), { at: beforeDraft - 1 });
    expect(existsSync(join(result.dir, "draft.md"))).toBe(false);
    expect(existsSync(join(result.dir, "sources.md"))).toBe(true);
  });

  it("names pruned content it cannot bring across, rather than dropping it silently", () => {
    const { room, base } = storyRoom();
    pruneVersions(room, { retain: 1 });

    const head = room.log.head();
    const result = forkRoom(room, join(base, "variant"), { at: head });

    // The first draft's bytes are gone from the parent, so the fork cannot
    // have them either — but it says so, in the result and in its own log.
    expect(result.gaps).toEqual([]);
    const fork = track(Room.open(result.dir));
    const marker = fork.log.read({ types: ["room.forked"] })[0]!;
    expect(marker.data).toMatchObject({ unrecoverablePaths: [] });

    // The surviving version still reads; the pruned one still refuses.
    const versions = listVersions(fork, "draft.md");
    expect(versions).toHaveLength(2);
  });

  it("reports a path whose current content was pruned as an unrecoverable gap", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    const scout = member(room, "scout", "worker");

    write(room, scout, "notes.md", "one\n");
    write(room, scout, "notes.md", "two\n");
    const atFirst = listVersions(room, "notes.md")[0]!.seq;

    pruneVersions(room, { retain: 1 });

    // Forking at the first version needs bytes the sweep dropped.
    const result = forkRoom(room, join(base, "variant"), { at: atFirst });
    expect(result.gaps.map((gap) => gap.path)).toEqual(["notes.md"]);
    expect(existsSync(join(result.dir, "notes.md"))).toBe(false);

    const fork = track(Room.open(result.dir));
    expect(fork.log.read({ types: ["room.forked"] })[0]!.data).toMatchObject({
      unrecoverablePaths: ["notes.md"],
    });
  });

  it("carries the parent's settings over but takes a new id and name", () => {
    const base = workspace();
    const room = track(
      Room.create(join(base, "parent"), { config: { leaseSeconds: 999, maxAttempts: 7 } }),
    );
    member(room, "scout", "worker");

    const result = forkRoom(room, join(base, "variant"));
    const fork = track(Room.open(result.dir));

    expect(fork.config.leaseSeconds).toBe(999);
    expect(fork.config.maxAttempts).toBe(7);
    expect(fork.config.id).not.toBe(room.config.id);
    expect(fork.config.name).toBe("variant");
  });

  it("takes a name when given one", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    member(room, "scout", "worker");

    const result = forkRoom(room, join(base, "variant"), { name: "what if" });
    expect(track(Room.open(result.dir)).config.name).toBe("what if");
  });

  it("does not copy session tokens, so nobody can authenticate into the fork yet", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    const joined = room.join({ name: "scout", role: "worker" });

    // The token works in the parent.
    expect(room.authenticate(joined.token).id).toBe(joined.member.id);

    const result = forkRoom(room, join(base, "variant"));
    const fork = track(Room.open(result.dir));

    expect(JSON.parse(readFileSync(join(result.dir, ".atrium", "tokens.json"), "utf8"))).toEqual({});
    // The member is in the fork's history; the credential is not.
    expect(fork.roster().map((m) => m.name)).toContain("scout");
    expect(() => fork.authenticate(joined.token)).toThrow();
  });

  it("copies the brief as it is now, and says that is what it did", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    member(room, "scout", "worker");
    const early = room.log.head();

    // Editing CONTEXT.md records nothing, which is the point of the warning.
    writeFileSync(room.paths.context, "# Rewritten later\n", "utf8");

    const result = forkRoom(room, join(base, "variant"), { at: early });
    expect(result.contextCopied).toBe(true);
    expect(readFileSync(join(result.dir, "CONTEXT.md"), "utf8")).toBe("# Rewritten later\n");
  });

  it("starts halted when the parent had already halted by that point", () => {
    const base = workspace();
    // room.created is event 1, so the second join is the one that runs the
    // budget out: assertUsable refuses once the log is already this long.
    const room = track(Room.create(join(base, "parent"), { config: { actionBudget: 2 } }));
    member(room, "scout", "worker");
    expect(() => member(room, "second", "worker")).toThrow(/stopped/);

    const result = forkRoom(room, join(base, "variant"));
    expect(result.inheritsHalt).toBe(true);
    expect(track(Room.open(result.dir)).isHalted()).toBe(true);
  });

  it("refuses to fork on top of an existing room", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    member(room, "scout", "worker");
    track(Room.create(join(base, "variant")));

    expect(() => forkRoom(room, join(base, "variant"))).toThrow(/already a room/);
  });

  it("refuses to fork a room over itself", () => {
    const base = workspace();
    const room = track(Room.create(join(base, "parent")));
    member(room, "scout", "worker");

    expect(() => forkRoom(room, room.dir)).toThrow(/cannot be forked over itself/);
  });

  it("lets the fork carry on differently from the parent", () => {
    const { room, base, draftTask, rejectedAt } = storyRoom();
    const fork = track(Room.open(forkRoom(room, join(base, "variant"), { at: rejectedAt }).dir));

    // Where the parent's editor rejected and the work was redone, this room's
    // takes the draft as it is. Same task id, same history up to 17, different
    // outcome after it.
    const other = member(fork, "stand-in", "human");
    claimTask(fork, other, draftTask);
    submitTask(fork, other, draftTask, { summary: "shipping the first draft" });

    const finalCall = member(fork, "chief", "human");
    reviewTask(fork, finalCall, draftTask, { accept: true });

    expect(listTasks(fork).find((task) => task.id === draftTask)?.state).toBe("accepted");
    // The parent is untouched by any of it.
    expect(room.log.head()).toBeGreaterThan(rejectedAt);
    expect(listTasks(room).find((task) => task.id === draftTask)?.attempts).toBe(1);
  });
});

/**
 * These live here rather than in cli.test.ts so the command and the module it
 * drives stay in one file. Nothing else in the CLI suite needs a room with a
 * rejection in it.
 */
describe("atrium fork", () => {
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

  it("writes nothing on --dry-run and says so", () => {
    const { room, base, rejectedAt } = storyRoom();
    const target = join(base, "variant");
    const s = sink();

    const code = cmdFork([target, room.dir, "--at", String(rejectedAt), "--dry-run"], s);

    expect(code).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(s.outLines.join("\n")).toMatch(/Nothing was written/);
  });

  it("creates the fork and points out what cannot come with it", () => {
    const { room, base, rejectedAt } = storyRoom();
    const s = sink();

    const code = cmdFork([join(base, "variant"), room.dir, "--at", String(rejectedAt)], s);

    expect(code).toBe(0);
    const out = s.outLines.join("\n");
    expect(out).toMatch(/Forked "parent" at event/);
    // The two things a reader has to know before trusting a fork.
    expect(out).toMatch(/the log does not record what it said at that point/);
    expect(out).toMatch(/session tokens are not copied/);
  });

  it("refuses a fork point that is not a number, before opening anything", () => {
    const { room, base } = storyRoom();
    const s = sink();

    expect(cmdFork([join(base, "variant"), room.dir, "--at", "halfway"], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/--at must be a whole event number/);
    expect(existsSync(join(base, "variant"))).toBe(false);
  });

  it("needs somewhere to put the new room", () => {
    const s = sink();
    expect(cmdFork([], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/needs somewhere to put the new room/);
  });

  it("describes the trade-offs in its help rather than burying them", () => {
    const s = sink();
    expect(cmdFork(["--help"], s)).toBe(0);
    const help = s.outLines.join("\n");
    expect(help).toMatch(/reproduces the room, not the world/);
    expect(help).toMatch(/cannot rewind the brief/);
    expect(help).toMatch(/cannot bring back pruned content/);
  });

  it("hands back the plan as JSON when asked", () => {
    const { room, base, rejectedAt } = storyRoom();
    const s = sink();

    cmdFork([join(base, "variant"), room.dir, "--at", String(rejectedAt), "--json"], s);
    const result = JSON.parse(s.outLines.join("\n"));

    expect(result.atSeq).toBe(rejectedAt);
    expect(result.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "draft.md",
      "sources.md",
    ]);
  });
});

describe("EventLog.importHistory", () => {
  it("refuses a log that already holds events", () => {
    const base = workspace();
    const source = track(Room.create(join(base, "parent")));
    member(source, "scout", "worker");

    const target = track(Room.create(join(base, "other")));
    expect(() => target.log.importHistory(source.log.read())).toThrow(
      /can only be imported into an empty log/,
    );
  });
});
