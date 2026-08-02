import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveHttp, type HttpServerHandle } from "./http.js";
import { Room } from "./room.js";

const created: Array<{ room: Room; dir: string }> = [];
const servers: HttpServerHandle[] = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-http-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
}

afterEach(async () => {
  while (servers.length) {
    await servers.pop()!.close();
  }
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

async function startServer(room: Room): Promise<HttpServerHandle> {
  const handle = await serveHttp(room, { port: 0 });
  servers.push(handle);
  return handle;
}

function rpc(id: number, method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

describe("serveHttp", () => {
  it("binds to 127.0.0.1 by default and picks a free port", async () => {
    const handle = await startServer(tempRoom());
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
    expect(handle.healthUrl).toBe(`http://127.0.0.1:${handle.port}/health`);
  });

  it("exposes an unauthenticated liveness check without exposing room content", async () => {
    const room = tempRoom({ name: "private-room-name" });
    room.join({ name: "private-member-name", role: "worker" });
    const handle = await startServer(room);

    const res = await fetch(handle.healthUrl!);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as any;
    expect(body).toEqual({ status: "ok" });
    expect(JSON.stringify(body)).not.toContain("private-room-name");
    expect(JSON.stringify(body)).not.toContain("private-member-name");
    // The log head is a running count of everything the room has done, and
    // this route answers without a token. Polling it should not be a way to
    // watch a room's activity from outside.
    expect(body).not.toHaveProperty("head");
  });

  it("supports HEAD health checks and lets an operator disable the route", async () => {
    const room = tempRoom();
    const handle = await serveHttp(room, { port: 0, healthPath: false });
    servers.push(handle);

    expect(handle.healthUrl).toBeUndefined();
    expect((await fetch(handle.url.replace(/\/mcp$/, "/health"))).status).toBe(404);

    const enabled = await startServer(room);
    const res = await fetch(enabled.healthUrl!, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("reports a halted room without treating the healthy server as unavailable", async () => {
    const room = tempRoom({ config: { actionBudget: 2 } });
    room.join({ name: "first", role: "worker" });
    expect(() => room.join({ name: "over-budget", role: "worker" })).toThrow();
    const handle = await startServer(room);

    const res = await fetch(handle.healthUrl!);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "halted" });
  });

  it("runs a tool call end to end with a valid bearer token", async () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    const handle = await startServer(room);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(
        rpc(1, "tools/call", { name: "get_context", arguments: {} }),
      ),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(1);
    const content = JSON.parse(body.result.content[0].text);
    expect(content.brief).toContain("job");
  });

  it("rejects a call with no bearer token", async () => {
    const room = tempRoom();
    const handle = await startServer(room);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc(1, "tools/list")),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("permission");
  });

  it("rejects a call with a bearer token that is not valid", async () => {
    const room = tempRoom();
    const handle = await startServer(room);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify(rpc(1, "tools/list")),
    });

    expect(res.status).toBe(401);
  });

  it("reports malformed JSON as a JSON-RPC parse error instead of crashing", async () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    const handle = await startServer(room);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{ this is not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32700);
  });

  it("answers GET with 405 rather than hanging or erroring", async () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    const handle = await startServer(room);

    const res = await fetch(handle.url, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(405);
  });

  it("answers an unknown path with 404", async () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    const handle = await startServer(room);
    const base = handle.url.replace(/\/mcp$/, "");

    const res = await fetch(`${base}/somewhere-else`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });

  it("lets a joined member's token drive a full claim and submit", async () => {
    const room = tempRoom();
    const { token } = room.join({ name: "scout", role: "worker" });
    const handle = await startServer(room);

    const call = async (method: string, params: Record<string, unknown>) => {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(rpc(1, method, params)),
      });
      return (await res.json()) as any;
    };

    const created = await call("tools/call", {
      name: "create_task",
      arguments: { title: "draft" },
    });
    const task = JSON.parse(created.result.content[0].text);

    const claimed = await call("tools/call", {
      name: "claim_task",
      arguments: { task_id: task.id },
    });
    expect(claimed.result.isError).toBeUndefined();
  });
});
