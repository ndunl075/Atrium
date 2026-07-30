import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  briefAt,
  briefDrift,
  briefHistory,
  describeHistory,
  getContext,
  listPinned,
  pinArtifact,
  recordBrief,
  unpinArtifact,
} from "./context.js";
import { cmdContext, type Sink } from "./cli.js";
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

  it("names what is already pinned as something to unpin, when a pin is refused", () => {
    const room = tempRoom({ config: { contextTokenCeiling: 30 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "small.md", "keep me"); // well under a ceiling of 30
    pinArtifact(room, worker.id, "small.md");

    write(room, "big.md", "x".repeat(400));
    let thrown: unknown;
    try {
      pinArtifact(room, worker.id, "big.md");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidError);
    const err = thrown as InstanceType<typeof InvalidError>;
    // The point of rejecting instead of evicting is that the human gets to
    // choose what to drop, which only works if the message names a candidate.
    expect(err.message).toContain("small.md");
    expect(err.message).toMatch(/Unpin one of those/);
    expect(err.message).toMatch(/raise contextTokenCeiling/);
    expect(err.details.pinned).toEqual(["small.md"]);
    expect(err.details.overBy).toBeGreaterThan(0);
  });

  it("says plainly there is nothing to unpin when a refused pin is the first one", () => {
    const room = tempRoom({ config: { contextTokenCeiling: 5 } });
    const worker = room.join({ name: "scout", role: "worker" }).member;
    write(room, "big.md", "x".repeat(400));

    expect(() => pinArtifact(room, worker.id, "big.md")).toThrow(/Nothing else is pinned/);
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

/**
 * The brief is the one input every agent reads, and until `context.written`
 * existed it was the one thing the log did not record — see ARCHITECTURE.md
 * §3.5. These cover the awkward part of the fix: the brief has to stay a
 * plain file anybody can edit without going through Atrium, so recording it
 * is a capture rather than a write path.
 */
describe("recording the brief", () => {
  function setBrief(room: Room, text: string): void {
    writeFileSync(room.paths.context, text, "utf8");
  }

  it("records what the brief says and reads it back", () => {
    const room = tempRoom();
    setBrief(room, "# The job\n");

    const recorded = recordBrief(room, "system");

    expect(recorded.recorded).toBe(true);
    expect(recorded.bytes).toBe(Buffer.byteLength("# The job\n"));
    expect(briefAt(room, room.log.head())).toMatchObject({
      state: "present",
      text: "# The job\n",
    });
  });

  it("appends nothing when the brief has not changed", () => {
    const room = tempRoom();
    setBrief(room, "# The job\n");
    recordBrief(room, "system");
    const after = room.log.head();

    const again = recordBrief(room, "system");

    expect(again.recorded).toBe(false);
    // Every event costs budget, so a room whose brief never changes must not
    // grow one per join.
    expect(room.log.head()).toBe(after);
  });

  it("does not record an empty brief that was never recorded before", () => {
    const room = tempRoom();
    setBrief(room, "");

    expect(recordBrief(room, "system").recorded).toBe(false);
    expect(briefHistory(room)).toEqual([]);
  });

  it("records a brief that was emptied after having content", () => {
    const room = tempRoom();
    setBrief(room, "# Something\n");
    recordBrief(room, "system");

    setBrief(room, "");

    // Emptying the brief is a real change, unlike a room that never had one.
    expect(recordBrief(room, "system").recorded).toBe(true);
    expect(briefAt(room, room.log.head())).toMatchObject({ state: "present", text: "" });
  });

  it("tells an authored write apart from one it merely noticed", () => {
    const room = tempRoom();
    setBrief(room, "# Written through atrium\n");
    recordBrief(room, "system", "atrium");

    setBrief(room, "# Edited in an editor\n");
    recordBrief(room, "system", "observed");

    expect(briefHistory(room).map((version) => version.source)).toEqual([
      "atrium",
      "observed",
    ]);
  });

  it("captures an out-of-band edit when somebody joins", () => {
    const room = tempRoom();
    setBrief(room, "# Edited in an editor, with atrium none the wiser\n");

    room.join({ name: "scout", role: "worker" });

    expect(briefAt(room, room.log.head())).toMatchObject({
      state: "present",
      text: "# Edited in an editor, with atrium none the wiser\n",
    });
    expect(briefHistory(room)[0]!.source).toBe("observed");
  });

  it("captures the brief before the member who will read it has joined", () => {
    const room = tempRoom();
    setBrief(room, "# The brief\n");

    room.join({ name: "scout", role: "worker" });

    const versions = briefHistory(room);
    const joins = room.log.read({ types: ["member.joined"] });
    // Recorded first, so the log reads as "this is what was on the wall" then
    // "and then somebody walked in and read it".
    expect(versions[0]!.seq).toBeLessThan(joins[0]!.seq);
  });

  it("does not grow the log on later joins when nothing changed", () => {
    const room = tempRoom();
    setBrief(room, "# Stable\n");
    room.join({ name: "a", role: "worker" });
    const after = room.log.head();

    room.join({ name: "b", role: "worker" });

    expect(room.log.head()).toBe(after + 1); // just the join
    expect(briefHistory(room)).toHaveLength(1);
  });

  describe("briefAt", () => {
    it("reads the version in force at that point, not the newest", () => {
      const room = tempRoom();
      setBrief(room, "# First\n");
      recordBrief(room, "system");
      const early = room.log.head();

      setBrief(room, "# Second\n");
      recordBrief(room, "system");

      expect(briefAt(room, early)).toMatchObject({ text: "# First\n" });
      expect(briefAt(room, room.log.head())).toMatchObject({ text: "# Second\n" });
    });

    it("reports nothing recorded by that point as absent", () => {
      const room = tempRoom();
      const before = room.log.head();
      setBrief(room, "# Later\n");
      recordBrief(room, "system");

      expect(briefAt(room, before)).toEqual({ state: "absent" });
    });
  });

  describe("briefDrift", () => {
    it("sees no drift right after recording", () => {
      const room = tempRoom();
      setBrief(room, "# Recorded\n");
      recordBrief(room, "system");

      expect(briefDrift(room).drifted).toBe(false);
    });

    it("sees drift once the file is edited and nobody has joined since", () => {
      const room = tempRoom();
      setBrief(room, "# Recorded\n");
      recordBrief(room, "system");

      setBrief(room, "# Edited since\n");

      const drift = briefDrift(room);
      expect(drift.drifted).toBe(true);
      expect(drift.diskHash).not.toBe(drift.recordedHash);
    });

    it("does not call an empty, never-recorded brief drifted", () => {
      const room = tempRoom();
      writeFileSync(room.paths.context, "", "utf8");

      expect(briefDrift(room).drifted).toBe(false);
    });
  });
});

describe("atrium context, recording flags", () => {
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

  it("--record captures the brief without waiting for somebody to join", () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, "# Edited by hand\n", "utf8");
    const s = sink();

    expect(cmdContext(["--record", room.dir], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/Recorded the brief/);
    expect(briefAt(room, room.log.head())).toMatchObject({ text: "# Edited by hand\n" });
  });

  it("--record says so and changes nothing when already recorded", () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, "# Already there\n", "utf8");
    cmdContext(["--record", room.dir], sink());
    const after = room.log.head();

    const s = sink();
    expect(cmdContext(["--record", room.dir], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/already matches/);
    expect(room.log.head()).toBe(after);
  });

  it("--history lists every recorded version and flags drift", () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, "# One\n", "utf8");
    cmdContext(["--record", room.dir], sink());
    writeFileSync(room.paths.context, "# Two, unrecorded\n", "utf8");

    const s = sink();
    expect(cmdContext(["--history", room.dir], s)).toBe(0);
    const out = s.outLines.join("\n");
    // Recorded via --record, which reads the file rather than authoring it.
    expect(out).toMatch(/changed on disk/);
    expect(out).toMatch(/does not match the last recorded version/);
  });

  it("--at prints the brief as it stood then, not as it stands now", () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, "# The original\n", "utf8");
    cmdContext(["--record", room.dir], sink());
    const early = room.log.head();
    writeFileSync(room.paths.context, "# Replaced\n", "utf8");
    cmdContext(["--record", room.dir], sink());

    const s = sink();
    expect(cmdContext(["--at", String(early), room.dir], s)).toBe(0);
    expect(s.outLines.join("\n")).toContain("# The original");
    expect(s.outLines.join("\n")).not.toContain("# Replaced");
  });

  it("--at says plainly when nothing had been recorded by then", () => {
    const room = tempRoom();
    const before = room.log.head();
    writeFileSync(room.paths.context, "# Later\n", "utf8");
    cmdContext(["--record", room.dir], sink());

    const s = sink();
    expect(cmdContext(["--at", String(before), room.dir], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/No brief had been recorded by event/);
  });

  it("refuses an --at that is not an event number", () => {
    const room = tempRoom();
    const s = sink();
    expect(cmdContext(["--at", "recently", room.dir], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/--at must be a whole event number/);
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

  it("refuses an unknown --type filter, naming the valid ones", () => {
    const room = tempRoom();
    room.join({ name: "scout", role: "worker" });

    expect(() => describeHistory(room, { types: ["task.acepted" as never] })).toThrow(
      /Unknown event type/,
    );
    expect(() => describeHistory(room, { types: ["task.acepted" as never] })).toThrow(
      /task\.accepted/,
    );
  });

  it("filters by actor, matching either the member id or the name it joined under", () => {
    const room = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;
    room.log.append(scout.id, "note.posted", { memberId: scout.id, text: "from scout" });
    room.log.append(editor.id, "note.posted", { memberId: editor.id, text: "from editor" });

    const byName = describeHistory(room, { actor: "scout" });
    expect(byName.every((l) => l.actor === scout.id)).toBe(true);
    expect(byName.some((l) => l.line.includes("from scout"))).toBe(true);

    const byId = describeHistory(room, { actor: editor.id });
    expect(byId.every((l) => l.actor === editor.id)).toBe(true);
  });

  it("filters by actor 'system' for events no member caused", () => {
    const room = tempRoom();
    const lines = describeHistory(room, { actor: "system" });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.actor === "system")).toBe(true);
  });

  it("filters by a case-insensitive substring of the rendered line, not the raw data", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "check the DRAFT" });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "unrelated" });

    const hits = describeHistory(room, { contains: "draft" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toContain("DRAFT");
  });

  it("intersects filters rather than widening the result", () => {
    const room = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    const editor = room.join({ name: "editor", role: "reviewer" }).member;
    room.log.append(scout.id, "note.posted", { memberId: scout.id, text: "draft ready" });
    room.log.append(editor.id, "note.posted", { memberId: editor.id, text: "draft ready" });
    room.log.append(scout.id, "note.posted", { memberId: scout.id, text: "unrelated" });

    // Both events mention "draft ready", and both actors post a note, but
    // only one event is both scout's AND mentions "draft" — the filters must
    // narrow together, not each independently widen the result.
    const both = describeHistory(room, { actor: "scout", contains: "draft" });
    expect(both).toHaveLength(1);
    expect(both[0]?.line).toContain("draft ready");
  });

  it("reports a real empty result — filters that match nothing return an empty array, not an error", () => {
    const room = tempRoom();
    room.join({ name: "scout", role: "worker" });

    const lines = describeHistory(room, { contains: "something that never happened" });
    expect(lines).toEqual([]);
  });

  it("treats the sequence range as inclusive at both ends", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const a = room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "a" });
    const b = room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "b" });
    const c = room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "c" });

    const middle = describeHistory(room, { from: b.seq, to: b.seq });
    expect(middle.map((l) => l.seq)).toEqual([b.seq]);

    const span = describeHistory(room, { from: a.seq, to: c.seq, types: ["note.posted"] });
    expect(span.map((l) => l.seq)).toEqual([a.seq, b.seq, c.seq]);
  });

  it("applies limit after actor/contains filtering, not before", () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "no match" });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "match one" });
    room.log.append(worker.id, "note.posted", { memberId: worker.id, text: "match two" });

    // If limit were applied before the contains filter, capping at 2 from the
    // start of the raw log could cut out both matches. Applied after, it
    // takes the first 2 of the *filtered* result instead.
    const limited = describeHistory(room, { contains: "match", limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.every((l) => l.line.includes("match"))).toBe(true);
  });
});
