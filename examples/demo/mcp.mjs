/**
 * A minimal MCP client, so the demo workers talk to a room the same way any
 * other MCP client would.
 *
 * This exists to keep the demo honest. ARCHITECTURE.md section 12.1a is
 * explicit that a reference worker is a demonstration of the MCP interface
 * and gets no privileged access — nothing in src/ imports anything here, and
 * nothing here imports anything from src/. If a worker needs something this
 * interface does not expose, that is a finding about the interface rather
 * than a reason to reach past it.
 *
 * The transport is line-delimited JSON-RPC over the child process's stdio,
 * which is what `atrium serve` speaks. There is no SDK involved and none is
 * needed; this whole file is about a hundred lines because that is genuinely
 * all it takes.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

/**
 * Where a demo member keeps the token that makes it the same person across
 * process launches. Outside `.atrium/` on purpose: that directory belongs to
 * the room, and an example has no business writing into it.
 */
export function tokenPathFor(roomDir, memberName) {
  return join(roomDir, ".demo", `${memberName}.token`);
}

export function readToken(path) {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeToken(path, token) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, "utf8");
}

/**
 * Open a room as a member that persists across launches.
 *
 * Both demo processes are launched repeatedly — the worker once per task by
 * the runner, the reviewer once per round by the driver — so both need this.
 * Without it the roster grows one member per launch, and worse, every one of
 * those members is a stranger to the others: a reviewer that joined fresh
 * would have no way to show it was the same editor that saw the last draft.
 */
export async function openRoomAs(options) {
  const path = tokenPathFor(options.roomDir, options.name);
  const session = await openRoom({ ...options, token: readToken(path) });
  if (session.token) writeToken(path, session.token);
  return session;
}

/**
 * Opens a room as one member, joining fresh or rejoining with a saved token.
 *
 * One process is one member: `atrium serve` remembers who is on this
 * connection, so every later call is attributed to them without passing an
 * identity around. That is also why the token matters here. The runner
 * launches a worker process per task, so a worker that called `join` every
 * time would leave the roster one member longer after every task it did, and
 * none of those members would be able to see that the others had been it.
 * Saving the token from the first join and passing it back on the next launch
 * is how one worker stays one person across restarts.
 */
export async function openRoom({ cliPath, roomDir, name, role, manifest, token }) {
  const child = spawn(
    process.execPath,
    // --token authenticates the connection before a single message is sent,
    // so a rejoining member must not also call the join tool: that would
    // create a second member rather than resuming the first.
    token === undefined
      ? [cliPath, "serve", roomDir]
      : [cliPath, "serve", roomDir, "--token", token],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );

  const pending = new Map();
  let nextId = 1;

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // Not ours to interpret; the server frames one message per line.
    }

    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);

    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
    else waiter.resolve(message.result);
  });

  const closed = new Promise((resolve) => child.once("close", resolve));
  child.once("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("The room server exited before answering."));
    }
    pending.clear();
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "atrium-demo-worker", version: "0" },
  });

  /**
   * Calls a tool and hands back the parsed result.
   *
   * A refused call comes back as a tool result with `isError`, not as a
   * protocol error — the room saying no is information a worker is expected
   * to handle (somebody else claimed it, the work is stale, you cannot accept
   * your own submission). It is returned rather than thrown so callers can
   * decide which refusals are normal.
   */
  const call = async (tool, args = {}) => {
    const result = await request("tools/call", { name: tool, arguments: args });
    const text = result?.content?.[0]?.text ?? "null";
    const value = JSON.parse(text);
    return result.isError === true
      ? { ok: false, error: value }
      : { ok: true, value };
  };

  /** The same, for calls where a refusal means the demo is broken. */
  const must = async (tool, args = {}) => {
    const outcome = await call(tool, args);
    if (!outcome.ok) {
      throw new Error(`${tool} was refused: ${outcome.error.message ?? JSON.stringify(outcome.error)}`);
    }
    return outcome.value;
  };

  // A rejoining connection is already authenticated by --token, so there is
  // nothing to join; ask for the brief directly instead.
  const joined =
    token === undefined
      ? await must("join", {
          name,
          role,
          ...(manifest !== undefined ? { manifest } : {}),
        })
      : { context: await must("get_context") };

  return {
    joined,
    /** Present only on a fresh join. Save it to come back as this member. */
    token: joined.token,
    call,
    must,
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}
