import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { RoomServer, serveStdio } from "./mcp.js";
import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { deleteArtifact } from "./artifacts.js";
import { pruneVersions } from "./snapshots.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-mcp-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
}

afterEach(() => {
  vi.useRealTimers();
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

/** The JSON a tool call returns, already parsed back out of its text block. */
async function call(
  server: RoomServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: any; isError: boolean }> {
  const res = await server.callTool(name, args);
  return {
    data: JSON.parse(res.content[0]!.text),
    isError: res.isError === true,
  };
}

describe("the protocol handshake", () => {
  it("agrees on a version the client asked for", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    const result = res?.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("atrium");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("reports the package's real version, not a second copy of it", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    // This was a string literal for a while and had already drifted a release
    // behind what package.json said. Asserting against the file is what stops
    // it drifting again — a version a client is told is not somewhere to keep
    // a second copy of a fact.
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version: string };

    expect((res?.result as any).serverInfo.version).toBe(pkg.version);
  });

  it("falls back to its own newest version for one it does not know", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });

    expect((res?.result as any).protocolVersion).toBe("2025-06-18");
  });

  it("stays quiet about notifications, which have no id", async () => {
    const server = new RoomServer(tempRoom());
    expect(
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
  });

  it("answers ping", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("reports an unknown method rather than going quiet", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
    });
    expect(res?.error?.code).toBe(-32601);
  });

  it("rejects something that is not a JSON-RPC request", async () => {
    const server = new RoomServer(tempRoom());
    expect((await server.handleMessage({ hello: "there" }))?.error?.code).toBe(-32600);
  });
});

describe("tools/list", () => {
  it("offers every tool the architecture document lists", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res?.result as any).tools.map((t: any) => t.name);

    for (const expected of [
      "join",
      "get_context",
      "search_artifacts",
      "list_tasks",
      "claim_task",
      "read_artifact",
      "write_artifact",
      "submit_task",
      "review_task",
      "post_note",
      "read_log",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("describes every tool with a schema a client can validate against", async () => {
    const server = new RoomServer(tempRoom());
    for (const tool of server.listTools()) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

describe("joining", () => {
  it("hands back a token and the brief in one go", async () => {
    const server = new RoomServer(tempRoom());
    const { data } = await call(server, "join", { name: "scout", role: "worker" });

    expect(data.member.name).toBe("scout");
    expect(typeof data.token).toBe("string");
    expect(data.context).toBeDefined();
    expect(server.currentMember?.id).toBe(data.member.id);
  });

  it("refuses work from a connection that has not joined", async () => {
    const server = new RoomServer(tempRoom());
    await expect(server.callTool("claim_task", { task_id: "task_x" })).rejects.toThrow(
      /have not joined/,
    );
  });

  it("picks up as an existing member when given that member's token", async () => {
    const room = tempRoom();
    const { member, token } = room.join({ name: "scout", role: "worker" });

    expect(new RoomServer(room, { token }).currentMember?.id).toBe(member.id);
  });
});

describe("a refusal comes back as a readable result, not a protocol error", () => {
  it("explains a task that somebody else already claimed", async () => {
    const room = tempRoom();
    const alice = new RoomServer(room);
    const bob = new RoomServer(room);
    await call(alice, "join", { name: "alice", role: "worker" });
    await call(bob, "join", { name: "bob", role: "worker" });

    const { data: task } = await call(alice, "create_task", { title: "draft" });
    await call(alice, "claim_task", { task_id: task.id });

    const { data, isError } = await call(bob, "claim_task", { task_id: task.id });

    expect(isError).toBe(true);
    expect(data.error).toBe("conflict");
    expect(data.message).toMatch(/claimed/);
  });
});

describe("the rule that nobody signs off their own work, through the tools", () => {
  it("refuses a worker accepting what it just submitted", async () => {
    const room = tempRoom();
    const worker = new RoomServer(room);
    await call(worker, "join", { name: "scout", role: "worker" });

    const { data: task } = await call(worker, "create_task", { title: "draft" });
    await call(worker, "claim_task", { task_id: task.id });
    await call(worker, "submit_task", { task_id: task.id, summary: "done" });

    const { data, isError } = await call(worker, "review_task", {
      task_id: task.id,
      accept: true,
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("permission");
    expect(data.message).toMatch(/somebody else/);
  });

  it("lets a different reviewer accept it", async () => {
    const room = tempRoom();
    const worker = new RoomServer(room);
    const reviewer = new RoomServer(room);
    await call(worker, "join", { name: "scout", role: "worker" });
    await call(reviewer, "join", { name: "editor", role: "reviewer" });

    const { data: task } = await call(worker, "create_task", { title: "draft" });
    await call(worker, "claim_task", { task_id: task.id });
    await call(worker, "submit_task", { task_id: task.id, summary: "done" });

    const { data, isError } = await call(reviewer, "review_task", {
      task_id: task.id,
      accept: true,
    });

    expect(isError).toBe(false);
    expect(data.state).toBe("accepted");
  });
});

describe("pin_artifact / unpin_artifact", () => {
  it("offers unpin_artifact with the same shape as pin_artifact", async () => {
    const server = new RoomServer(tempRoom());
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res?.result as any).tools as Array<{
      name: string;
      description: string;
      inputSchema: any;
    }>;

    const pin = tools.find((t) => t.name === "pin_artifact");
    const unpin = tools.find((t) => t.name === "unpin_artifact");
    expect(pin).toBeDefined();
    expect(unpin).toBeDefined();
    expect(unpin!.inputSchema).toEqual(pin!.inputSchema);
    expect(unpin!.description.length).toBeGreaterThan(20);
  });

  it("round-trips a pin through the shared brief and back out", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "write_artifact", { path: "notes.md", content: "worth knowing" });

    const pinned = await call(server, "pin_artifact", { path: "notes.md" });
    expect(pinned.isError).toBe(false);
    expect(pinned.data.changed).toBe(true);
    expect(pinned.data.context.pinned).toEqual([{ path: "notes.md", content: "worth knowing" }]);

    const unpinned = await call(server, "unpin_artifact", { path: "notes.md" });
    expect(unpinned.isError).toBe(false);
    expect(unpinned.data.changed).toBe(true);
    expect(unpinned.data.context.pinned).toEqual([]);
  });

  it("reports changed:false rather than silently re-pinning something already pinned", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "write_artifact", { path: "notes.md", content: "worth knowing" });

    await call(server, "pin_artifact", { path: "notes.md" });
    const again = await call(server, "pin_artifact", { path: "notes.md" });

    expect(again.isError).toBe(false);
    expect(again.data.changed).toBe(false);
  });

  it("reports changed:false rather than erroring when unpinning something never pinned", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const res = await call(server, "unpin_artifact", { path: "never-pinned.md" });

    expect(res.isError).toBe(false);
    expect(res.data.unpinned).toBe("never-pinned.md");
    expect(res.data.changed).toBe(false);
  });

  it("refuses a pin over the ceiling with a message naming the ceiling, the cost, and what's pinned", async () => {
    const room = tempRoom({ config: { contextTokenCeiling: 30 } });
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "write_artifact", { path: "small.md", content: "keep me" });
    await call(server, "pin_artifact", { path: "small.md" });
    await call(server, "write_artifact", { path: "big.md", content: "x".repeat(400) });

    const { data, isError } = await call(server, "pin_artifact", { path: "big.md" });

    expect(isError).toBe(true);
    expect(data.error).toBe("invalid");
    expect(data.message).toContain("30");
    expect(data.message).toContain("small.md");
    expect(data.message).toMatch(/raise contextTokenCeiling/);
    expect(data.pinned).toEqual(["small.md"]);
  });
});

describe("writing files", () => {
  it("takes the lease for you, so the agent does not have to know about leases", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { isError } = await call(server, "write_artifact", {
      path: "notes/draft.md",
      content: "# Draft\n",
    });
    expect(isError).toBe(false);

    const { data } = await call(server, "read_artifact", { path: "notes/draft.md" });
    expect(data.content).toBe("# Draft\n");
    expect(data.exists).toBe(true);
  });

  it("reads a past version by seq, even after the path has moved on", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const first = await call(server, "write_artifact", {
      path: "notes/draft.md",
      content: "# Draft v1\n",
    });
    await call(server, "write_artifact", {
      path: "notes/draft.md",
      content: "# Draft v2\n",
    });

    const { data } = await call(server, "read_artifact", {
      path: "notes/draft.md",
      seq: first.data.seq,
    });
    expect(data.exists).toBe(true);
    expect(data.content).toBe("# Draft v1\n");

    const current = await call(server, "read_artifact", { path: "notes/draft.md" });
    expect(current.data.content).toBe("# Draft v2\n");
  });

  it("tells an agent a pruned version existed rather than reporting it as missing", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const first = await call(server, "write_artifact", {
      path: "notes/draft.md",
      content: "# Draft v1\n",
    });
    await call(server, "write_artifact", {
      path: "notes/draft.md",
      content: "# Draft v2\n",
    });
    pruneVersions(room, { retain: 1 });

    const { data } = await call(server, "read_artifact", {
      path: "notes/draft.md",
      seq: first.data.seq,
    });

    // exists: false would tell the agent this write never happened, and an
    // agent told that has no reason to look at the history or ask again.
    expect(data.exists).toBe(true);
    expect(data.pruned).toBe(true);
    expect(data.content).toBeUndefined();
    expect(data.note).toMatch(/no longer retained/);
  });

  it("refuses a path another member is holding, and says who", async () => {
    const room = tempRoom();
    const alice = new RoomServer(room);
    const bob = new RoomServer(room);
    const a = await call(alice, "join", { name: "alice", role: "worker" });
    await call(bob, "join", { name: "bob", role: "worker" });

    await call(alice, "write_artifact", { path: "shared.md", content: "mine" });
    const { data, isError } = await call(bob, "write_artifact", {
      path: "shared.md",
      content: "no, mine",
    });

    expect(isError).toBe(true);
    expect(data.holder).toBe(a.data.member.id);
  });

  it("catches a write based on a version that has moved on", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    await call(server, "write_artifact", { path: "draft.md", content: "one" });
    await call(server, "write_artifact", { path: "draft.md", content: "two" });

    const { data, isError } = await call(server, "write_artifact", {
      path: "draft.md",
      content: "three",
      based_on_seq: 1,
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("stale");
  });

  it("will not let a path escape the room", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { isError } = await call(server, "write_artifact", {
      path: "../escape.md",
      content: "nope",
    });
    expect(isError).toBe(true);
  });
});

describe("list_leases", () => {
  it("finds out a path is held before write_artifact would refuse it", async () => {
    const room = tempRoom();
    const alice = new RoomServer(room);
    const bob = new RoomServer(room);
    const a = await call(alice, "join", { name: "alice", role: "worker" });
    await call(bob, "join", { name: "bob", role: "worker" });

    await call(alice, "write_artifact", { path: "shared.md", content: "mine" });

    const { data, isError } = await call(bob, "list_leases", { path: "shared.md" });
    expect(isError).toBe(false);
    expect(data.leases).toHaveLength(1);
    expect(data.leases[0].path).toBe("shared.md");
    expect(data.leases[0].holder).toBe(a.data.member.id);
  });

  it("lists every leased path when no path is given", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    await call(server, "write_artifact", { path: "draft.md", content: "one" });
    await call(server, "write_artifact", { path: "notes.md", content: "two" });

    const { data } = await call(server, "list_leases");
    expect(data.leases.map((l: any) => l.path).sort()).toEqual(["draft.md", "notes.md"]);
  });

  it("says nothing is leased rather than a stale or wrong answer", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { data } = await call(server, "list_leases");
    expect(data.leases).toEqual([]);
  });

  it("does not report a lapsed lease as held", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const room = tempRoom({ config: { leaseSeconds: 60 } });
    const server = new RoomServer(room);
    const joined = await call(server, "join", { name: "scout", role: "worker" });
    acquireLease(room, joined.data.member.id, "draft.md");

    // The lease.acquired event is still in the log; only its expiry has
    // passed, which is exactly the distinction currentLease/foldLeases exist
    // to make and this tool must not collapse.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

    const { data } = await call(server, "list_leases");
    expect(data.leases).toEqual([]);

    const { data: single } = await call(server, "list_leases", { path: "draft.md" });
    expect(single.leases).toEqual([]);
  });
});

describe("list_artifacts", () => {
  it("lists several artifacts with their sizes and who last wrote them", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const wrote = await call(server, "write_artifact", { path: "draft.md", content: "hello" });
    await call(server, "write_artifact", { path: "notes/plan.md", content: "hi there" });

    const { data, isError } = await call(server, "list_artifacts");
    expect(isError).toBe(false);
    expect(data.artifacts).toHaveLength(2);
    const draft = data.artifacts.find((a: any) => a.path === "draft.md");
    expect(draft.bytes).toBe(5);
    expect(draft.lastWrittenBy).toBe(wrote.data.lastWrittenBy);
    // Not asked for, so the deleted list is left out entirely rather than
    // coming back as an empty array a caller has to notice is meaningless.
    expect(data.deleted).toBeUndefined();
  });

  it("leaves a deleted path out of the live list, and only surfaces it as its own separate list when asked", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    const joined = await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "write_artifact", { path: "gone.md", content: "bye" });
    deleteArtifact(room, joined.data.member.id, "gone.md");

    const { data } = await call(server, "list_artifacts");
    expect(data.artifacts).toEqual([]);
    expect(data.deleted).toBeUndefined();

    const { data: withDeleted } = await call(server, "list_artifacts", { include_deleted: true });
    expect(withDeleted.artifacts).toEqual([]);
    expect(withDeleted.deleted).toHaveLength(1);
    expect(withDeleted.deleted[0].path).toBe("gone.md");
    expect(withDeleted.deleted[0].deletedBy).toBe(joined.data.member.id);
  });

  it("reports an empty room plainly rather than an empty table standing in for an error", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { data } = await call(server, "list_artifacts");
    expect(data.artifacts).toEqual([]);
  });

  it("does not surface a file dropped into the room's working directory by hand", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    // Never went through write_artifact, so the room never recorded it.
    writeFileSync(join(room.dir, "untracked.md"), "surprise");

    const { data } = await call(server, "list_artifacts");
    expect(data.artifacts).toEqual([]);
  });
});

describe("over stdio", () => {
  it("answers a real conversation, one JSON object per line", async () => {
    const room = tempRoom();
    const input = new PassThrough();
    const output = new PassThrough();

    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = serveStdio(room, { input, output });

    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    );
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "join", arguments: { name: "scout", role: "worker" } },
      }) + "\n",
    );
    input.end();
    await done;

    const replies = chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));

    // Three requests, one notification: the notification gets no reply.
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[1].result.tools.length).toBeGreaterThan(10);
    expect(JSON.parse(replies[2].result.content[0].text).member.name).toBe("scout");
  });

  it("reports a line that is not JSON without falling over", async () => {
    const room = tempRoom();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = serveStdio(room, { input, output });
    input.write("this is not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n");
    input.end();
    await done;

    const replies = chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));

    expect(replies[0].error.code).toBe(-32700);
    // The bad line must not stop what comes after it.
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });

  it("keeps replies in the order the requests arrived", async () => {
    const room = tempRoom();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = serveStdio(room, { input, output });
    for (let id = 1; id <= 10; id++) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");
    }
    input.end();
    await done;

    const ids = chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l).id);

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("list_members", () => {
  it("lists a member with the manifest and tags it self-reported on join", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", {
      name: "scout",
      role: "worker",
      manifest: "finds sources",
      tags: ["research"],
    });

    const { data, isError } = await call(server, "list_members");

    expect(isError).toBe(false);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("scout");
    expect(data[0].manifest).toBe("finds sources");
    expect(data[0].tags).toEqual(["research"]);
    expect(data[0].active).toBe(true);
  });

  it("keeps a member who has left on the list, marked inactive rather than dropped", async () => {
    const room = tempRoom();
    const { member } = room.join({ name: "scout", role: "worker" });
    room.leave(member.id);

    const server = new RoomServer(room);
    const { data } = await call(server, "list_members");

    expect(data).toHaveLength(1);
    expect(data[0].active).toBe(false);
  });

  it("shows every member in the room, not just the caller", async () => {
    const room = tempRoom();
    const alice = new RoomServer(room);
    const bob = new RoomServer(room);
    await call(alice, "join", { name: "alice", role: "worker" });
    await call(bob, "join", { name: "bob", role: "reviewer" });

    const { data } = await call(alice, "list_members");

    expect(data.map((m: any) => m.name).sort()).toEqual(["alice", "bob"]);
  });

  it("does not require joining first, same as get_context", async () => {
    const room = tempRoom();
    room.join({ name: "scout", role: "worker" });
    const server = new RoomServer(room);

    const { isError } = await call(server, "list_members");
    expect(isError).toBe(false);
  });
});

describe("read_log filtering", () => {
  it("filters by types, refusing an unknown one and naming the valid ones", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { data, isError } = await call(server, "read_log", { types: ["member.joined"] });
    expect(isError).toBe(false);
    expect(data).toHaveLength(1);
    expect(data[0].line).toMatch(/scout joined/);

    const bad = await call(server, "read_log", { types: ["memeber.joined"] });
    expect(bad.isError).toBe(true);
    expect(bad.data.message).toMatch(/Unknown event type/);
    expect(bad.data.message).toContain("member.joined");
  });

  it("filters by actor, matching the name a member joined under", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "post_note", { text: "note from scout" });

    const other = new RoomServer(room);
    await call(other, "join", { name: "editor", role: "reviewer" });
    await call(other, "post_note", { text: "note from editor" });

    const { data } = await call(server, "read_log", { actor: "scout" });
    expect(data.every((l: any) => l.line.includes("scout"))).toBe(true);
    expect(data.some((l: any) => l.line.includes("note from scout"))).toBe(true);
    expect(data.some((l: any) => l.line.includes("note from editor"))).toBe(false);
  });

  it("filters by a case-insensitive substring of the rendered line", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "post_note", { text: "check the DRAFT before shipping" });
    await call(server, "post_note", { text: "unrelated" });

    const { data } = await call(server, "read_log", { contains: "draft" });
    expect(data).toHaveLength(1);
    expect(data[0].line).toContain("DRAFT");
  });

  it("intersects filters rather than widening the result", async () => {
    const room = tempRoom();
    const scout = new RoomServer(room);
    const editor = new RoomServer(room);
    await call(scout, "join", { name: "scout", role: "worker" });
    await call(editor, "join", { name: "editor", role: "reviewer" });
    await call(scout, "post_note", { text: "draft ready" });
    await call(editor, "post_note", { text: "draft ready" });

    const { data } = await call(scout, "read_log", { actor: "scout", contains: "draft" });
    expect(data).toHaveLength(1);
    expect(data[0].line).toMatch(/^scout/);
  });

  it("takes an inclusive from/to sequence range", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "post_note", { text: "a" });
    await call(server, "post_note", { text: "b" });
    const head = room.log.head();

    const { data } = await call(server, "read_log", {
      from: head - 1,
      to: head,
      types: ["note.posted"],
    });
    expect(data.map((l: any) => l.seq)).toEqual([head - 1, head]);
  });

  it("returns an empty array, not an error, when nothing matches", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const { data, isError } = await call(server, "read_log", {
      contains: "something that never happened",
    });
    expect(isError).toBe(false);
    expect(data).toEqual([]);
  });
});

describe("list_versions", () => {
  it("lists every write for a path, oldest first, with seq/author/size", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    const joined = await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "one" });
    const v2 = await call(server, "write_artifact", { path: "draft.md", content: "two" });

    const { data, isError } = await call(server, "list_versions", { path: "draft.md" });

    expect(isError).toBe(false);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      seq: v1.data.seq,
      author: joined.data.member.id,
      kind: "written",
      bytes: 3,
    });
    expect(data[1]).toMatchObject({ seq: v2.data.seq, kind: "written", bytes: 3 });
    // Oldest first, so a reviewer scanning top to bottom reads the same order
    // the work actually happened in.
    expect(data[0].seq).toBeLessThan(data[1].seq);
  });

  it("still lists every version before a delete, not just what currently exists", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    const joined = await call(server, "join", { name: "scout", role: "worker" });

    const written = await call(server, "write_artifact", { path: "draft.md", content: "one" });
    deleteArtifact(room, joined.data.member.id, "draft.md");

    const { data } = await call(server, "list_versions", { path: "draft.md" });

    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ seq: written.data.seq, kind: "written" });
    expect(data[1]).toMatchObject({ kind: "deleted" });
    expect(data[1].bytes).toBeUndefined();
  });

  it("answers with an empty list for a path never written, rather than an error", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const { data, isError } = await call(server, "list_versions", { path: "never.md" });

    expect(isError).toBe(false);
    expect(data).toEqual([]);
  });
});

describe("diff_artifact", () => {
  it("returns a real unified patch between two explicit versions", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "line1\n" });
    const v2 = await call(server, "write_artifact", {
      path: "draft.md",
      content: "line1\nline2\n",
    });

    const { data, isError } = await call(server, "diff_artifact", {
      path: "draft.md",
      from_seq: v1.data.seq,
      to_seq: v2.data.seq,
    });

    expect(isError).toBe(false);
    expect(data.identical).toBe(false);
    expect(data.binary).toBe(false);
    expect(data.pruned).toBe(false);
    expect(data.patch).toContain("+line2");
  });

  it("reports identical:true with an empty patch rather than a no-op diff", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "same\n" });
    const v2 = await call(server, "write_artifact", { path: "draft.md", content: "same\n" });

    const { data } = await call(server, "diff_artifact", {
      path: "draft.md",
      from_seq: v1.data.seq,
      to_seq: v2.data.seq,
    });

    expect(data.identical).toBe(true);
    expect(data.binary).toBe(false);
    expect(data.pruned).toBe(false);
    expect(data.patch).toBe("");
  });

  it("reports binary:true instead of attempting a line diff", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "blob.bin", content: "text\n" });
    const v2 = await call(server, "write_artifact", {
      path: "blob.bin",
      content: "abc\u0000def",
    });

    const { data } = await call(server, "diff_artifact", {
      path: "blob.bin",
      from_seq: v1.data.seq,
      to_seq: v2.data.seq,
    });

    expect(data.identical).toBe(false);
    expect(data.binary).toBe(true);
    expect(data.pruned).toBe(false);
    expect(data.patch).toMatch(/Binary files/);
  });

  it("reports pruned:true and refuses to guess, rather than showing an empty patch", async () => {
    const room = tempRoom();
    const server = new RoomServer(room);
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "one" });
    const v2 = await call(server, "write_artifact", { path: "draft.md", content: "two" });
    pruneVersions(room, { retain: 1 });

    const { data, isError } = await call(server, "diff_artifact", {
      path: "draft.md",
      from_seq: v1.data.seq,
      to_seq: v2.data.seq,
    });

    // Not an error result: the tool answered, and the answer is honestly
    // "cannot compare" rather than a fabricated identical or empty diff.
    expect(isError).toBe(false);
    expect(data.identical).toBe(false);
    expect(data.binary).toBe(false);
    expect(data.pruned).toBe(true);
    expect(data.patch).toMatch(/no longer retained/);
  });

  it("defaults to the last two recorded versions, same as atrium diff for a human", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    await call(server, "write_artifact", { path: "draft.md", content: "one" });
    const v2 = await call(server, "write_artifact", { path: "draft.md", content: "two" });
    const v3 = await call(server, "write_artifact", { path: "draft.md", content: "three" });

    const { data } = await call(server, "diff_artifact", { path: "draft.md" });

    expect(data.fromSeq).toBe(v2.data.seq);
    expect(data.toSeq).toBe(v3.data.seq);
  });

  it("diffs from_seq up to the current version when to_seq is left out, for a reviewer's submittedAtSeq", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "one" });
    await call(server, "write_artifact", { path: "draft.md", content: "two" });
    const v3 = await call(server, "write_artifact", { path: "draft.md", content: "three" });

    const { data, isError } = await call(server, "diff_artifact", {
      path: "draft.md",
      from_seq: v1.data.seq,
    });

    expect(isError).toBe(false);
    expect(data.fromSeq).toBe(v1.data.seq);
    // Up through the current version, not just the last write — the whole
    // scope of the work since v1, which is the point of this default.
    expect(data.toSeq).toBe(v3.data.seq);
  });

  it("refuses to_seq without from_seq rather than guessing a starting point", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    const v1 = await call(server, "write_artifact", { path: "draft.md", content: "one" });

    const { data, isError } = await call(server, "diff_artifact", {
      path: "draft.md",
      to_seq: v1.data.seq,
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("invalid");
    expect(data.message).toMatch(/from_seq/);
  });

  it("refuses a path with fewer than two versions and no explicit seqs, plainly rather than opaquely", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });
    await call(server, "write_artifact", { path: "draft.md", content: "only one" });

    const { data, isError } = await call(server, "diff_artifact", { path: "draft.md" });

    expect(isError).toBe(true);
    expect(data.error).toBe("invalid");
    expect(data.message).toMatch(/only one recorded version/);
  });

  it("answers sensibly for a path never written, rather than throwing something opaque", async () => {
    const server = new RoomServer(tempRoom());
    await call(server, "join", { name: "scout", role: "worker" });

    // No explicit seqs: nothing to compare, and the tool says so plainly.
    const noSeqs = await call(server, "diff_artifact", { path: "never.md" });
    expect(noSeqs.isError).toBe(true);
    expect(noSeqs.data.error).toBe("invalid");
    expect(noSeqs.data.message).toMatch(/no recorded version/);

    // Explicit seqs on a path that never existed at either: both sides read
    // as absent, and absent-vs-absent is a real, honest identical:true.
    const explicit = await call(server, "diff_artifact", {
      path: "never.md",
      from_seq: 0,
      to_seq: 0,
    });
    expect(explicit.isError).toBe(false);
    expect(explicit.data.identical).toBe(true);
  });
});
