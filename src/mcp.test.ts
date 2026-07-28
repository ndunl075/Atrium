import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { RoomServer, serveStdio } from "./mcp.js";
import { Room } from "./room.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-mcp-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
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
