/**
 * A room, exposed as an MCP server over HTTP.
 *
 * stdio (`serveStdio` in `src/mcp.ts`) is enough for a client that can spawn a
 * child process, which covers most local MCP clients. Some cannot: a browser
 * extension, a client running on the far side of a container boundary, or
 * anything that only speaks HTTP. This is the Streamable HTTP shape MCP
 * defines for that case — one endpoint, `POST` a JSON-RPC message, get a
 * JSON-RPC response back — built on nothing but `node:http`, for the same
 * reason `mcp.ts` avoids the official SDK: the dependency list is something
 * this project's audience reads before the README.
 *
 * stdio's trust model is the process itself: whatever can start the child
 * process can call `join` and act as any member it likes, because nothing
 * else shares that pipe. HTTP has no equivalent boundary — anything on the
 * machine that can reach the port can send a request — so it cannot inherit
 * that model. Every request here must carry a session token, obtained ahead
 * of time from `atrium invite` (or from an earlier `join` over stdio). There
 * is deliberately no anonymous path to `join` over HTTP: that would be an
 * unauthenticated way to create a member and start writing to the room, and
 * the whole point of a session token is that creating one is the privileged
 * step. An operator who wants to hand a fresh agent access runs `atrium
 * invite` and gives it that token, the same way they would hand out a stdio
 * config entry.
 *
 * Binds to 127.0.0.1 by default. This is local-first software; nothing here
 * should be reachable from another machine unless a human deliberately opts
 * in by passing a different host.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { RoomServer } from "./mcp.js";
import type { Room } from "./room.js";

export interface ServeHttpOptions {
  /** Defaults to 127.0.0.1. Only change this deliberately. */
  host?: string;
  /** Defaults to 0, which asks the OS for any free port. */
  port?: number;
  /** The one route this server answers on. Defaults to "/mcp". */
  path?: string;
  /**
   * Unauthenticated liveness route for local supervisors and container
   * health checks. Defaults to "/health"; pass false to disable it.
   */
  healthPath?: string | false;
}

export interface HttpServerHandle {
  readonly host: string;
  readonly port: number;
  /** Convenience for logging and for tests: `http://host:port/path`. */
  readonly url: string;
  /** The configured liveness URL, or undefined when health checks are disabled. */
  readonly healthUrl: string | undefined;
  /** Stops accepting connections and waits for in-flight requests to finish. */
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024; // A room message is small; this is generous, not a real ceiling.

/**
 * Starts listening and resolves once the server is up. The returned handle's
 * `close` is how a caller shuts it down again; nothing here exits on its own.
 */
export function serveHttp(
  room: Room,
  options: ServeHttpOptions = {},
): Promise<HttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const mcpPath = options.path ?? "/mcp";
  const healthPath = options.healthPath === false ? undefined : options.healthPath ?? "/health";
  if (healthPath === mcpPath) {
    throw new Error("The MCP path and health path must be different.");
  }

  const server = createServer((req, res) => {
    handleRequest(room, mcpPath, healthPath, req, res).catch(() => {
      // Only reached if something below throws outside its own try/catch —
      // a bug in this file, not a request the caller sent badly. Those are
      // already turned into a JSON-RPC or HTTP error response of their own.
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal", message: "Unexpected server error." });
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        host,
        port: address.port,
        url: `http://${host}:${address.port}${mcpPath}`,
        healthUrl: healthPath
          ? `http://${host}:${address.port}${healthPath}`
          : undefined,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handleRequest(
  room: Room,
  mcpPath: string,
  healthPath: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (healthPath && url.pathname === healthPath) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      sendJson(res, 405, { error: "invalid", message: `Method ${req.method} is not allowed.` });
      return;
    }

    const health = {
      status: room.isHalted() ? "halted" : "ok",
      head: room.log.head(),
    };
    res.setHeader("cache-control", "no-store");
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end();
    } else {
      sendJson(res, 200, health);
    }
    return;
  }

  if (url.pathname !== mcpPath) {
    sendJson(res, 404, { error: "not_found", message: `No route for ${url.pathname}.` });
    return;
  }

  if (req.method === "GET") {
    // A real streaming transport would upgrade this to an SSE stream of
    // server-initiated notifications. This server has none to push — every
    // reply here is a direct response to a request — so a plain 405 is the
    // honest answer rather than an SSE endpoint that would never send
    // anything down it.
    sendJson(res, 405, {
      error: "invalid",
      message: "GET is not supported here. POST a JSON-RPC message instead.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "invalid", message: `Method ${req.method} is not allowed.` });
    return;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    sendJson(res, 401, {
      error: "permission",
      message:
        'This endpoint needs a session token. Send "Authorization: Bearer <token>" using a ' +
        'token from "atrium invite" or an earlier "join" call.',
    });
    return;
  }

  let server: RoomServer;
  try {
    server = new RoomServer(room, { token });
  } catch (err) {
    sendJson(res, 401, {
      error: "permission",
      message: err instanceof Error ? err.message : "That session token is not valid.",
    });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, {
      error: "invalid",
      message: err instanceof Error ? err.message : "Could not read the request body.",
    });
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    // Mirrors the parse-error response serveStdio sends for an unparseable
    // line: a JSON-RPC error object with no id, since there was no request to
    // attach one to.
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "The request body was not valid JSON." },
    });
    return;
  }

  const response = await server.handleMessage(message);
  if (response === null) {
    // A notification: the protocol says to stay quiet, which over HTTP means
    // an empty, successful response rather than no response at all.
    res.writeHead(202).end();
    return;
  }

  sendJson(res, 200, response);
}

/** Reads the body up to a size cap, rejecting instead of buffering forever. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body over ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}
