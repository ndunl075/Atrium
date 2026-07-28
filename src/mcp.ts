/**
 * A room, exposed as an MCP server.
 *
 * This is the adoption path: an MCP-capable agent joins a room by adding a
 * config entry, with no Atrium-specific code in it at all.
 *
 * The protocol is implemented directly rather than through the official SDK.
 * That SDK brings ninety-odd packages, including two HTTP servers, for what
 * over stdio is JSON-RPC 2.0 with four methods. ARCHITECTURE.md is explicit
 * that the dependency list is something this project's audience will read
 * before the README, so stdio is served from nothing but Node. The tool layer
 * below is deliberately transport-agnostic — `listTools` and `callTool` know
 * nothing about stdio — so an HTTP transport can be added later, SDK or not,
 * without any of this being rewritten.
 *
 * One rule matters when changing this file: on stdio, stdout carries protocol
 * messages and nothing else. Anything printed for a human goes to stderr, or
 * it corrupts the stream.
 */

import { createInterface } from "node:readline";

import {
  acquireLease,
  currentLease,
  releaseLease,
} from "./leases.js";
import { claimTask, createTask, getTask, listTasks } from "./board.js";
import { describeHistory, getContext, pinArtifact } from "./context.js";
import { isAtriumError } from "./errors.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { reviewTask, submitTask } from "./acceptance.js";
import { Room } from "./room.js";
import { searchArtifacts } from "./search.js";
import type { Acceptance, Member, MemberRole, TaskId } from "./types.js";

/** Newest first. An older client gets its own version echoed back. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const SERVER_INFO = { name: "atrium", version: "0.1.0" } as const;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface RoomServerOptions {
  /**
   * A session token from an earlier join. Lets a restarted agent pick up as
   * the member it already was instead of joining the room twice.
   */
  token?: string;
}

/**
 * The tool layer. Holds which member this connection is acting as, because an
 * agent gets its own server process over stdio, so "who is calling" is a
 * property of the connection rather than something to repeat in every call.
 */
export class RoomServer {
  private readonly room: Room;
  private member?: Member;

  constructor(room: Room, options: RoomServerOptions = {}) {
    this.room = room;
    if (options.token) this.member = room.authenticate(options.token);
  }

  /** The member this connection is acting as, if it has joined. */
  get currentMember(): Member | undefined {
    return this.member;
  }

  listTools(): ToolDefinition[] {
    return TOOLS;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    try {
      return ok(await this.dispatchTool(name, args));
    } catch (err) {
      // A refusal is information the agent needs to act on — the wrong task
      // state, somebody else's lease, its own work coming back — so it is
      // returned as a failed tool result it can read, not a protocol error
      // that reads to the model as the server being broken.
      if (isAtriumError(err)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: err.code, message: err.message, ...err.details },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "join": {
        const result = this.room.join({
          name: str(args, "name"),
          role: (str(args, "role", "worker") as MemberRole),
          manifest: str(args, "manifest", ""),
          tags: strArray(args, "tags"),
        });
        this.member = result.member;
        return {
          member: result.member,
          token: result.token,
          note: "Save this token. It is not recoverable, and it lets you rejoin as this member.",
          context: getContext(this.room),
        };
      }

      case "get_context":
        return getContext(this.room);

      case "search_artifacts":
        return searchArtifacts(this.room, str(args, "query"), {
          limit: num(args, "limit", 20),
        });

      case "list_tasks":
        return listTasks(this.room, {
          ...(args["state"] ? { state: args["state"] as never } : {}),
          ...(args["claimable"] !== undefined
            ? { claimable: Boolean(args["claimable"]) }
            : {}),
        });

      case "create_task":
        return createTask(this.room, this.requireMember().id, {
          title: str(args, "title"),
          description: str(args, "description", ""),
          dependsOn: strArray(args, "depends_on"),
          ...(args["acceptance"]
            ? { acceptance: args["acceptance"] as Acceptance }
            : {}),
        });

      case "claim_task":
        return claimTask(
          this.room,
          this.requireMember().id,
          str(args, "task_id") as TaskId,
        );

      case "read_artifact":
        return readArtifact(this.room, str(args, "path"));

      case "write_artifact": {
        // Leases are taken here rather than being a separate tool the agent has
        // to remember. The documented tool list does not include one, and an
        // agent that forgets to lease would just get an error it cannot act on.
        // A path somebody else holds still refuses, naming the holder.
        const memberId = this.requireMember().id;
        const path = str(args, "path");
        const held = currentLease(this.room, path);
        if (!held || held.holder !== memberId) {
          acquireLease(this.room, memberId, path);
        }
        return writeArtifact(this.room, memberId, path, str(args, "content"), {
          ...(args["based_on_seq"] !== undefined
            ? { basedOnSeq: num(args, "based_on_seq", 0) }
            : {}),
        });
      }

      case "release_artifact":
        releaseLease(this.room, this.requireMember().id, str(args, "path"));
        return { released: str(args, "path") };

      case "pin_artifact":
        pinArtifact(this.room, this.requireMember().id, str(args, "path"));
        return { pinned: str(args, "path"), context: getContext(this.room) };

      case "submit_task":
        return await submitTask(
          this.room,
          this.requireMember().id,
          str(args, "task_id") as TaskId,
          {
            summary: str(args, "summary"),
            artifacts: strArray(args, "artifacts"),
            ...(args["based_on_seq"] !== undefined
              ? { basedOnSeq: num(args, "based_on_seq", 0) }
              : {}),
          },
        );

      case "review_task": {
        const accept = Boolean(args["accept"]);
        return reviewTask(
          this.room,
          this.requireMember().id,
          str(args, "task_id") as TaskId,
          accept
            ? { accept: true, note: str(args, "note", "") }
            : { accept: false, reason: str(args, "reason") },
        );
      }

      case "post_note": {
        const memberId = this.requireMember().id;
        const taskId = args["task_id"];
        this.room.assertUsable();
        const event = this.room.log.append(memberId, "note.posted", {
          memberId,
          text: str(args, "text"),
          ...(typeof taskId === "string" ? { taskId } : {}),
        });
        return { seq: event.seq };
      }

      case "read_log":
        return describeHistory(this.room, {
          limit: num(args, "limit", 100),
          ...(args["from"] !== undefined ? { from: num(args, "from", 1) } : {}),
        });

      case "get_task":
        return getTask(this.room, str(args, "task_id") as TaskId);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private requireMember(): Member {
    if (!this.member) {
      throw Object.assign(
        new Error(
          'You have not joined this room yet. Call "join" first, with a name and a role.',
        ),
        { code: "permission" },
      );
    }
    return this.member;
  }

  /**
   * Handles one JSON-RPC message. Returns the response to send, or null when
   * the message was a notification and the protocol says to stay quiet.
   */
  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRequest(message)) {
      return errorResponse(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
    }

    const { id, method, params = {} } = message;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          const asked = params["protocolVersion"];
          const version =
            typeof asked === "string" &&
            (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
              ? asked
              : SUPPORTED_PROTOCOL_VERSIONS[0];
          return result(id ?? null, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return result(id ?? null, {});

        case "tools/list":
          return result(id ?? null, { tools: this.listTools() });

        case "tools/call": {
          const name = params["name"];
          if (typeof name !== "string") {
            return errorResponse(id ?? null, INVALID_REQUEST, "tools/call needs a tool name.");
          }
          const args = (params["arguments"] ?? {}) as Record<string, unknown>;
          return result(id ?? null, await this.callTool(name, args));
        }

        default:
          if (isNotification) return null;
          return errorResponse(id ?? null, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return errorResponse(
        id ?? null,
        INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Serves a room over stdio until stdin closes.
 *
 * Messages are one JSON object per line, which is what MCP's stdio transport
 * specifies. Nothing but protocol messages may go to stdout.
 */
export function serveStdio(
  room: Room,
  options: RoomServerOptions & {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const server = new RoomServer(room, options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const lines = createInterface({ input, crlfDelay: Infinity });

  // Responses are queued behind one another so that a slow tool call cannot
  // let a later reply overtake an earlier one on the wire.
  let pending: Promise<void> = Promise.resolve();

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    pending = pending.then(async () => {
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        write(output, errorResponse(null, PARSE_ERROR, "Message was not valid JSON."));
        return;
      }

      const response = await server.handleMessage(message);
      if (response) write(output, response);
    });
  });

  return new Promise((resolve) => {
    lines.on("close", () => {
      void pending.then(resolve);
    });
  });
}

function write(output: NodeJS.WritableStream, response: JsonRpcResponse): void {
  output.write(JSON.stringify(response) + "\n");
}

// ---------------------------------------------------------------------------
// Small helpers for reading arguments that arrive as unknown

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw Object.assign(new Error(`"${key}" is required and must be a string.`), {
    code: "invalid",
  });
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
//
// Descriptions are written for the model that reads them, so they say when to
// reach for a tool and what it refuses, not just what it is called.

const TOOLS: ToolDefinition[] = [
  {
    name: "join",
    description:
      "Join this room and get a session token. Call this first. Returns the room's shared brief, so this is also how you find out what the job is.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What to call you in the log." },
        role: {
          type: "string",
          enum: ["worker", "reviewer", "human"],
          description:
            "worker claims tasks and produces work; reviewer accepts or rejects other members' work and cannot claim; human does both and administers the room.",
        },
        manifest: {
          type: "string",
          description: "What you are good for, in a sentence or two.",
        },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "role"],
    },
  },
  {
    name: "get_context",
    description:
      "The room's shared brief and pinned files, with its token total against the ceiling.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_artifacts",
    description:
      "Full-text search over the files in this room. Use it before writing anything, to find what is already there.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_tasks",
    description:
      "The task board. Pass claimable:true to see only what you could pick up right now — tasks that are blocked, claimed, or frozen are left out.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["open", "claimed", "submitted", "accepted", "rejected", "blocked"],
        },
        claimable: { type: "boolean" },
      },
    },
  },
  {
    name: "get_task",
    description: "One task in full, including why it was last rejected.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "create_task",
    description:
      "Put work on the board. Say how it is allowed to be called finished: a command that must exit 0 is worth far more than an opinion, so prefer it wherever the work admits one.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must be accepted before this can start.",
        },
        acceptance: {
          type: "object",
          description:
            'One of {"kind":"command","command":"npm test"}, {"kind":"reviewer"}, {"kind":"human"}. Defaults to reviewer.',
        },
      },
      required: ["title"],
    },
  },
  {
    name: "claim_task",
    description:
      "Take a task. Exactly one member can hold a claim, so this fails if somebody got there first — re-read the board and pick another. Claims lapse, so a crash does not wedge the task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "read_artifact",
    description:
      "Read a file in the room. The seq it returns is the version you read; pass it back as based_on_seq when you write, so you find out if somebody changed it underneath you.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_artifact",
    description:
      "Write a file in the room. Takes a lease on the path for you automatically, and refuses if another member already holds one. Pass based_on_seq from your last read to be told about a conflicting change instead of overwriting it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        based_on_seq: { type: "number" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "release_artifact",
    description:
      "Give up your lease on a path so somebody else can write it. Leases lapse on their own, so this is only for finishing early.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "pin_artifact",
    description:
      "Add a file to the room's shared brief, so every member sees it. Refused if it would push the brief over its token ceiling.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "submit_task",
    description:
      "Hand in the work on a task you claimed. What happens next is whatever the task's acceptance says: a command runs now and its exit code decides, otherwise it waits for somebody else. You cannot accept your own work.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string", description: "What you did, for the reviewer." },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "Paths you touched.",
        },
        based_on_seq: { type: "number" },
      },
      required: ["task_id", "summary"],
    },
  },
  {
    name: "review_task",
    description:
      "Accept or reject somebody else's submitted work. Never your own, whatever your role. A rejection needs a reason the worker can act on, and puts the task back on the board.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        accept: { type: "boolean" },
        reason: { type: "string", description: "Required when rejecting." },
        note: { type: "string", description: "Optional when accepting." },
      },
      required: ["task_id", "accept"],
    },
  },
  {
    name: "post_note",
    description:
      "Leave a note in the log for other members. For things worth recording that are not a task.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "read_log",
    description:
      "What has happened in this room, as readable lines. This is how you catch up on a job already in progress without anybody summarising it for you.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 100." },
        from: { type: "number", description: "Start from this sequence number." },
      },
    },
  },
];
