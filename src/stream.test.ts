/**
 * The log as a consumable stream (ARCHITECTURE.md §12.4).
 *
 * The case that motivated carrying the payload is the last block here: a
 * `command` acceptance is recorded against the member that submitted the
 * work, so auditing "did anybody approve their own work" by actor alone gets
 * a false positive, and before this the only alternative was parsing English.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { submitTask, reviewTask } from "./acceptance.js";
import { claimTask, createTask } from "./board.js";
import { cmdTail, type Sink } from "./cli.js";
import { serveHttp, type HttpServerHandle } from "./http.js";
import { Room } from "./room.js";
import { followEvents, readStream } from "./stream.js";
import type { MemberId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];
const servers: HttpServerHandle[] = [];

function tempRoom(): { room: Room; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "atrium-stream-"));
  dirs.push(base);
  const dir = join(base, "room");
  const room = Room.create(dir);
  rooms.push(room);
  return { room, dir };
}

function member(room: Room, name: string, role: "worker" | "reviewer" | "human"): MemberId {
  return room.join({ name, role }).member.id;
}

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

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (rooms.length) {
    try {
      rooms.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readStream", () => {
  it("carries the payload and the rendered sentence together", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    createTask(room, editor, { title: "Write the piece" });

    const created = readStream(room, { types: ["task.created"] })[0]!;

    // What a tool branches on...
    expect(created.data).toMatchObject({ title: "Write the piece" });
    // ...and what a person reads, from the same object.
    expect(created.line).toContain("Write the piece");
    expect(created.type).toBe("task.created");
    expect(created.actorName).toBe("editor");
  });

  it("resolves the actor's name without losing the raw id", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");

    const joined = readStream(room, { types: ["member.joined"] })[0]!;

    expect(joined.actor).toBe(editor);
    expect(joined.actorName).toBe("editor");
  });

  it("leaves actorName off for events the room itself recorded", () => {
    const { room } = tempRoom();
    member(room, "scout", "worker");

    const created = readStream(room, { types: ["room.created"] })[0]!;

    expect(created.actor).toBe("system");
    expect(created.actorName).toBeUndefined();
  });

  it("filters by type and by sequence", () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    createTask(room, editor, { title: "One" });
    const mid = room.log.head();
    createTask(room, editor, { title: "Two" });

    expect(readStream(room, { types: ["task.created"] })).toHaveLength(2);
    expect(readStream(room, { types: ["task.created"], from: mid + 1 })).toHaveLength(1);
  });

  it("refuses an event type that does not exist rather than matching nothing", () => {
    const { room } = tempRoom();
    expect(() => readStream(room, { types: ["task.invented" as never] })).toThrow(
      /Unknown event type/,
    );
  });

  it("is empty for a room with nothing after the given point", () => {
    const { room } = tempRoom();
    expect(readStream(room, { from: room.log.head() + 1 })).toEqual([]);
  });
});

describe("followEvents", () => {
  it("delivers what is already there, then what arrives", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const seen: string[] = [];

    const handle = followEvents(room, {
      from: room.log.head(),
      pollMs: 10,
      onEvents: (events) => seen.push(...events.map((e) => e.type)),
    });

    expect(seen).toEqual([]); // nothing after the head yet

    createTask(room, editor, { title: "Written after the follow started" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    handle.stop();

    expect(seen).toContain("task.created");
  });

  it("does not deliver the same event twice", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const seen: number[] = [];

    const handle = followEvents(room, {
      from: 0,
      pollMs: 10,
      onEvents: (events) => seen.push(...events.map((e) => e.seq)),
    });
    createTask(room, editor, { title: "Once" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.stop();

    expect(new Set(seen).size).toBe(seen.length);
  });

  it("stops delivering once stopped", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const seen: number[] = [];

    const handle = followEvents(room, {
      from: room.log.head(),
      pollMs: 10,
      onEvents: (events) => seen.push(...events.map((e) => e.seq)),
    });
    handle.stop();

    createTask(room, editor, { title: "After the stop" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(seen).toEqual([]);
  });
});

describe("atrium tail", () => {
  it("prints matching events as JSON and exits with --once", async () => {
    const { room, dir } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    createTask(room, editor, { title: "Write the piece" });

    const s = sink();
    expect(await cmdTail([dir, "--json", "--all", "--once", "--type", "task.created"], s)).toBe(0);

    const events = s.outLines.map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].data.title).toBe("Write the piece");
  });

  it("prints readable lines when not asked for JSON", async () => {
    const { room, dir } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    createTask(room, editor, { title: "Write the piece" });

    const s = sink();
    await cmdTail([dir, "--all", "--once", "--type", "task.created"], s);

    expect(s.outLines[0]).toMatch(/^#\d+ {2}.*Write the piece/);
  });

  it("starts from the end of the log by default, not the beginning", async () => {
    const { room, dir } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    createTask(room, editor, { title: "Already happened" });

    const s = sink();
    await cmdTail([dir, "--once"], s);

    // A tail that replayed the whole log would bury what the reader started
    // it to watch.
    expect(s.outLines).toEqual([]);
  });

  it("refuses a --from that is not an event number", async () => {
    const { dir } = tempRoom();
    const s = sink();

    expect(await cmdTail([dir, "--from", "recently"], s)).toBe(2);
    expect(s.errLines.join("\n")).toMatch(/--from must be a whole event number/);
  });
});

describe("the SSE endpoint", () => {
  async function serve(room: Room): Promise<HttpServerHandle> {
    const handle = await serveHttp(room, { pollMs: 10 });
    servers.push(handle);
    return handle;
  }

  it("refuses without a token, the same as the MCP route", async () => {
    const { room } = tempRoom();
    const handle = await serve(room);

    const res = await fetch(handle.eventsUrl!);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("refuses a token that is not a member's", async () => {
    const { room } = tempRoom();
    const handle = await serve(room);

    const res = await fetch(handle.eventsUrl!, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("streams events to an authenticated reader", async () => {
    const { room } = tempRoom();
    const joined = room.join({ name: "watcher", role: "human" });
    const handle = await serve(room);

    const res = await fetch(`${handle.eventsUrl!}?from=0`, {
      headers: { authorization: `Bearer ${joined.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Enough chunks to get past the opening comment and the backlog.
    for (let i = 0; i < 3 && !text.includes("member.joined"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(text).toContain("event: member.joined");
    // The sequence number is the SSE id, which is what makes Last-Event-ID
    // resume exactly rather than approximately.
    expect(text).toMatch(/id: \d+/);
  });

  it("does not answer a POST", async () => {
    const { room } = tempRoom();
    const handle = await serve(room);

    const res = await fetch(handle.eventsUrl!, { method: "POST" });
    expect(res.status).toBe(405);
    await res.body?.cancel();
  });

  it("can be turned off", async () => {
    const { room } = tempRoom();
    const handle = await serveHttp(room, { eventsPath: false });
    servers.push(handle);

    expect(handle.eventsUrl).toBeUndefined();
    const res = await fetch(`http://${handle.host}:${handle.port}/events`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("refuses to serve the stream on the same path as MCP", () => {
    const { room } = tempRoom();
    // Thrown synchronously, before any socket is opened, the same way the
    // health path collision has always been reported.
    expect(() => serveHttp(room, { eventsPath: "/mcp" })).toThrow(/must be different/);
    expect(() => serveHttp(room, { eventsPath: "/health" })).toThrow(/must be different/);
  });
});

/**
 * The finding that made the payload non-optional, kept as a test so it stays
 * true rather than staying written down.
 */
describe("auditing self-approval", () => {
  it("can tell a command verdict from a member's judgement without parsing prose", async () => {
    const { room } = tempRoom();
    const editor = member(room, "editor", "reviewer");
    const scout = member(room, "scout", "worker");

    const byCommand = createTask(room, editor, {
      title: "Automated",
      acceptance: { kind: "command", command: "node -e \"process.exit(0)\"" },
    });
    claimTask(room, scout, byCommand.id);
    await submitTask(room, scout, byCommand.id, { summary: "done" });

    const byReviewer = createTask(room, editor, { title: "Judged" });
    claimTask(room, scout, byReviewer.id);
    await submitTask(room, scout, byReviewer.id, { summary: "done" });
    reviewTask(room, editor, byReviewer.id, { accept: true });

    const accepted = readStream(room, { types: ["task.accepted"] });
    expect(accepted).toHaveLength(2);

    const command = accepted.find((e) => e.data.via === "command")!;
    const reviewer = accepted.find((e) => e.data.via === "reviewer")!;

    // The command verdict is recorded against the submitter, which looks like
    // self-approval by actor alone. `via` is the field that says otherwise —
    // and before the stream carried payloads, the only way to know was the
    // phrase "via command" inside the sentence.
    expect(command.actor).toBe(scout);
    expect(command.data.by).toBe(scout);
    expect(reviewer.actor).toBe(editor);
    expect(reviewer.data.by).toBe(editor);

    const selfApproved = accepted.filter(
      (event) => event.data.via !== "command" && event.data.by === scout,
    );
    expect(selfApproved).toEqual([]);
  });
});
