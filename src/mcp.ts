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
  listLeases,
  releaseLease,
} from "./leases.js";
import { claimTask, createTask, getTask, listTasks, renewClaim } from "./board.js";
import { describeHistory, getContext, listPinned, pinArtifact, unpinArtifact } from "./context.js";
import { costSummary, reportCost } from "./cost.js";
import { InvalidError, isAtriumError } from "./errors.js";
import { listArtifacts, listDeletedArtifacts, readArtifact, writeArtifact } from "./artifacts.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import { reviewTask, submitTask } from "./acceptance.js";
import { Room } from "./room.js";
import { searchArtifacts } from "./search.js";
import { contentStateAt, diffArtifact, listVersions } from "./snapshots.js";
import { PACKAGE_VERSION } from "./util.js";
import type {
  Acceptance,
  EventType,
  ExpectedOutput,
  Member,
  MemberRole,
  TaskId,
} from "./types.js";

/** Newest first. An older client gets its own version echoed back. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const SERVER_INFO = { name: "atrium", version: PACKAGE_VERSION } as const;

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
          // Only worth showing when a cap is actually set — a room that never
          // configured one should look exactly like it did before this existed.
          ...(this.room.config.roomSpendCapUsd > 0 ||
          this.room.config.memberSpendCapUsd > 0
            ? { spend: costSummary(this.room) }
            : {}),
        };
      }

      case "get_context":
        return getContext(this.room);

      case "search_artifacts":
        return searchArtifacts(this.room, str(args, "query"), {
          limit: num(args, "limit", 20),
        });

      case "list_artifacts": {
        // A separate `deleted` list, present only when asked for, rather than
        // a flag on each entry: that way a caller can never mix up a live
        // artifact with a tombstone by missing a field, only by reading the
        // wrong array.
        const artifacts = listArtifacts(this.room);
        return Boolean(args["include_deleted"])
          ? { artifacts, deleted: listDeletedArtifacts(this.room) }
          : { artifacts };
      }

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
          ...(args["expected_output"] !== undefined
            ? { expectedOutput: args["expected_output"] as ExpectedOutput }
            : {}),
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

      case "renew_claim":
        return renewClaim(
          this.room,
          this.requireMember().id,
          str(args, "task_id") as TaskId,
        );

      case "read_artifact": {
        const path = str(args, "path");
        // A past seq reads history rather than the current file: the content
        // the path held right after that log position, which still works
        // for a path that has since been deleted.
        if (args["seq"] === undefined) return readArtifact(this.room, path);
        const seq = num(args, "seq", 0);
        const found = contentStateAt(this.room, path, seq);
        // `exists` answers "was there a file here then", which a pruned
        // version answers yes to. Reporting it as false because the bytes are
        // gone would tell the agent the write never happened, and an agent
        // told that has no reason to ask again or to look at the history.
        return {
          path,
          seq,
          exists: found.state !== "absent",
          pruned: found.state === "pruned",
          content: found.state === "present" ? found.bytes.toString("utf8") : undefined,
          ...(found.state === "pruned"
            ? {
                note: `This version was written (${found.bytes} bytes) but its content is no longer retained, so it cannot be read back. Later versions of this path may still be readable.`,
              }
            : {}),
        };
      }

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

      case "list_leases": {
        // Checking one path here is the whole point: a worker about to call
        // write_artifact can find out first whether it will be refused,
        // instead of finding out by eating the LeaseError. currentLease
        // already applies the same expiry rule as listLeases, so a lapsed
        // lease reads as free here too, not as still held.
        const path = args["path"];
        const leases =
          typeof path === "string" && path.trim() !== ""
            ? [currentLease(this.room, path)].filter((l): l is NonNullable<typeof l> => l !== undefined)
            : listLeases(this.room);
        return { leases };
      }

      case "pin_artifact": {
        const path = str(args, "path");
        // Pinning twice is a no-op in context.ts, and silently reporting
        // success either way would hide that from an agent that assumed its
        // call was the reason the file showed up in the brief. `changed`
        // says plainly whether this call did anything.
        const before = listPinned(this.room);
        pinArtifact(this.room, this.requireMember().id, path);
        const relPath = toArtifactPath(this.room.dir, resolveArtifact(this.room.dir, path));
        return { pinned: path, changed: !before.includes(relPath), context: getContext(this.room) };
      }

      case "unpin_artifact": {
        const path = str(args, "path");
        const before = listPinned(this.room);
        unpinArtifact(this.room, this.requireMember().id, path);
        const relPath = toArtifactPath(this.room.dir, resolveArtifact(this.room.dir, path));
        return { unpinned: path, changed: before.includes(relPath), context: getContext(this.room) };
      }

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

      case "read_log": {
        // Filters intersect rather than widen — type, actor, contains, and
        // the from/to range all narrow the same result together, the same
        // rule "atrium log --help" documents for the CLI equivalent of this
        // tool. An unknown type in `types` is refused by describeHistory
        // itself, which names the valid ones rather than quietly returning
        // nothing; a filter combination that matches nothing is a normal,
        // non-error result and just comes back as an empty array.
        const types = strArray(args, "types");
        return describeHistory(this.room, {
          limit: num(args, "limit", 100),
          ...(args["from"] !== undefined ? { from: num(args, "from", 1) } : {}),
          ...(args["to"] !== undefined ? { to: num(args, "to", 0) } : {}),
          ...(types.length > 0 ? { types: types as EventType[] } : {}),
          ...(typeof args["actor"] === "string" ? { actor: args["actor"] } : {}),
          ...(typeof args["contains"] === "string" ? { contains: args["contains"] } : {}),
        });
      }

      case "get_task":
        return getTask(this.room, str(args, "task_id") as TaskId);

      case "report_cost": {
        const memberId = this.requireMember().id;
        return reportCost(this.room, memberId, {
          amountUsd: reqNum(args, "amount_usd"),
          ...(typeof args["model"] === "string" ? { model: args["model"] } : {}),
          ...(args["input_tokens"] !== undefined
            ? { inputTokens: num(args, "input_tokens", 0) }
            : {}),
          ...(args["output_tokens"] !== undefined
            ? { outputTokens: num(args, "output_tokens", 0) }
            : {}),
          ...(typeof args["note"] === "string" ? { note: args["note"] } : {}),
        });
      }

      // Who else is in the room, per ARCHITECTURE.md §3.2 and §2: a member's
      // manifest is how it self-describes on join, and specialists in a
      // blackboard model are meant to observe each other rather than be told
      // about each other by an orchestrator that does not exist here. This is
      // the read half of that — the write half is already `join` itself.
      case "list_members":
        return this.room.roster();

      // Everything below is what lets an agent see what changed rather than
      // just what a path says now — the tool-layer half of ARCHITECTURE.md
      // §3.3's history story, and specifically what a `reviewer` needs that
      // read_artifact alone does not give it (§5): read_artifact can return
      // content at a seq if the caller already knows which seq to ask for,
      // but nothing before this told an agent which seqs exist or what
      // differs between two of them.
      case "list_versions":
        return listVersions(this.room, str(args, "path"));

      case "diff_artifact": {
        const path = str(args, "path");
        const hasFrom = args["from_seq"] !== undefined;
        const hasTo = args["to_seq"] !== undefined;

        let fromSeq: number;
        let toSeq: number;

        if (hasFrom && hasTo) {
          fromSeq = reqNum(args, "from_seq");
          toSeq = reqNum(args, "to_seq");
        } else if (hasFrom && !hasTo) {
          // The shape a reviewer actually wants: a known starting point (its
          // task's submittedAtSeq) diffed up through whatever the path holds
          // right now, without having to first look up the latest seq itself.
          fromSeq = reqNum(args, "from_seq");
          const versions = listVersions(this.room, path);
          const latest = versions[versions.length - 1];
          if (!latest) {
            throw new InvalidError(
              `${path} has no recorded versions, so there is nothing to diff up to.`,
              { path },
            );
          }
          toSeq = latest.seq;
        } else if (!hasFrom && hasTo) {
          // No sensible default exists for "diff from what" — guessing one
          // would be exactly the kind of plausible-but-false answer this
          // tool exists to avoid, so this asks for the missing half instead.
          throw new InvalidError(
            "to_seq needs from_seq alongside it. Pass both explicitly, or neither to diff the last two recorded versions.",
            { path },
          );
        } else {
          // Named nothing: mirror what a human gets from `atrium diff` with
          // no --from/--to, the last two recorded versions. That is the
          // right default for "what did I just change", which is the human
          // case cmdDiff was built for — but it is usually the wrong default
          // for reviewing a task's submission, which may have gone through
          // several writes before being handed in. A reviewer should pass
          // submittedAtSeq (see get_task) as from_seq rather than lean on
          // this default; the description says so.
          const versions = listVersions(this.room, path);
          if (versions.length < 2) {
            throw new InvalidError(
              `${path} has ${versions.length === 0 ? "no" : "only one"} recorded version; there is nothing to diff. Pass from_seq and to_seq explicitly if you mean something else.`,
              { path, versions: versions.length },
            );
          }
          fromSeq = versions[versions.length - 2]!.seq;
          toSeq = versions[versions.length - 1]!.seq;
        }

        return diffArtifact(this.room, path, fromSeq, toSeq);
      }

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

/** Like `str`, but for a required number: raw and unvalidated otherwise, so a
 * caller like `reportCost` still gets to give its own message for a bad value
 * rather than this silently falling back to something plausible-looking. */
function reqNum(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === "number") return value;
  throw Object.assign(new Error(`"${key}" is required and must be a number.`), {
    code: "invalid",
  });
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
      "Join this room and get a session token. Call this first. Returns the room's shared brief, so this is also how you find out what the job is. If the room has a spend cap configured, also returns current totals against it.",
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
    name: "list_artifacts",
    description:
      "Every path this room currently has: size, the log position it was last written at, and who wrote it. This is how a joining agent finds out what work already exists without already knowing a word to search for — search_artifacts only finds a file if you can guess something inside it, this just lists what is here, so call it before search_artifacts, not instead of it. Folded from the log, not read off disk: it describes what the room knows it produced, so a file dropped into the working directory by hand, without going through write_artifact, will never show up here. Pass include_deleted to also get paths that were written and later deleted, as a separate `deleted` list — a tombstone still has real history (read_artifact's seq argument can still read it, and atrium history/atrium diff still show it) but it is never mixed into the live list above.",
    inputSchema: {
      type: "object",
      properties: {
        include_deleted: {
          type: "boolean",
          description:
            "Also return paths that were written and then deleted, as a separate `deleted` array. Default false.",
        },
      },
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
        expected_output: {
          type: "object",
          description:
            "The completion contract shown to workers and reviewers. It guides acceptance but never accepts work itself.",
          properties: {
            description: {
              type: "string",
              description: "Plain-language description of what finished work looks like.",
            },
            schema: {
              description: "Optional JSON Schema object or boolean for structured output.",
            },
          },
          required: ["description"],
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must be accepted before this can start.",
        },
        acceptance: {
          type: "object",
          description:
            'One of {"kind":"command","command":"npm test"}, {"kind":"reviewer"}, {"kind":"human"}. Defaults to reviewer. ' +
            'A command acceptance may add "timeoutSeconds" (a finite number greater than 0) to override the ' +
            "room's commandTimeoutSeconds for just this task — e.g. a longer limit for a full integration suite " +
            "than for a lint check in the same room. Omit it to use the room's setting.",
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
    name: "renew_claim",
    description:
      "Extend your claim on a task before it lapses. Claims expire after a fixed number of seconds so a crashed worker cannot wedge a task forever — call get_task and check claimExpiresAt to find out how much time you actually have left, and call this well before that if the work is going to take longer, which most real work does. Refuses if you never held this claim, if somebody else holds it now, or — the case to watch for — if yours already lapsed: once that happens the task is back on the board and somebody else may have claimed it, so this will not resurrect the old claim. Call claim_task again instead; it will succeed if the task is still open.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "read_artifact",
    description:
      "Read a file in the room. The seq it returns is the version you read; pass it back as based_on_seq when you write, so you find out if somebody changed it underneath you. Pass seq to read what the file held right after that log position instead of its current contents — this works even for a path that has since been deleted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        seq: { type: "number", description: "Read history: the content as of this log position, instead of now." },
      },
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
    name: "list_leases",
    description:
      "Check who holds a lease before you call write_artifact, instead of finding out by getting refused. Pass path to check just that one path, or omit it to see every path currently leased in the room. A lease whose time has passed is left out — it no longer blocks a write, even though the log still shows it was once acquired.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Check only this path. Omit to list every currently-leased path.",
        },
      },
    },
  },
  {
    name: "pin_artifact",
    description:
      "Add a file to the room's shared brief, so every member sees it. Refused if it would push the brief over its token ceiling — the error names the ceiling, what this file would have cost, and what is already pinned, so you can decide what to unpin instead of guessing. Pinning something already pinned succeeds with changed:false rather than erroring.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "unpin_artifact",
    description:
      "Remove a file from the room's shared brief. This is the only way to make room under the ceiling short of raising it, since Tier 1 overflow is rejected rather than evicted automatically (ARCHITECTURE.md §6). Unpinning something that was never pinned succeeds with changed:false rather than erroring.",
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
      "What has happened in this room, as readable lines. This is how you catch up on a job already in progress without anybody summarising it for you. A room can hold a thousand events against a budget of a thousand actions, so reach for the filters below instead of reading everything and searching client-side: they combine (passing more than one narrows the result, it never widens it), and matching nothing is a normal answer that comes back as an empty array rather than an error.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "At most this many lines of the filtered result. Default 100." },
        from: { type: "number", description: "First sequence number to include." },
        to: { type: "number", description: "Last sequence number to include (inclusive)." },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Only these event types, e.g. [\"task.accepted\", \"task.rejected\"]. An unknown type is refused with the full list of valid ones in the error, rather than silently matching nothing.",
        },
        actor: {
          type: "string",
          description:
            "Only events caused by this actor — a member's name as it appears in the log, their member id, or \"system\". Exact match, not a substring.",
        },
        contains: {
          type: "string",
          description:
            "Only lines whose rendered text contains this, case-insensitively. A plain substring match, not a regular expression.",
        },
      },
    },
  },
  {
    name: "report_cost",
    description:
      "Tell the room what a model call cost, in USD. Atrium cannot see this on its own — it only knows what gets reported here. If this report crosses the room's or your own spend cap, it still lands (the money is already spent), but the room halts and refuses further actions from anyone until a human raises the cap or starts a new room.",
    inputSchema: {
      type: "object",
      properties: {
        amount_usd: { type: "number", description: "Cost of the call, in USD. Must be zero or more." },
        model: { type: "string" },
        input_tokens: { type: "number" },
        output_tokens: { type: "number" },
        note: { type: "string" },
      },
      required: ["amount_usd"],
    },
  },
  {
    name: "list_members",
    description:
      "Everyone who has ever joined this room, including members who have since left (marked inactive rather than removed). For each one: role, tags, and the manifest it gave on join describing what it's good for. This is entirely self-reported — ARCHITECTURE.md §3.2 deliberately has no capability schema behind it, so nothing here is verified. Treat it as a lead on who to ask or hand work to, not a guarantee of what anyone can actually do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_versions",
    description:
      "Every version a path has ever had, oldest first: log position (seq), when, who wrote or deleted it, and its size. This is what makes read_artifact's seq argument and diff_artifact's from_seq/to_seq usable at all — without calling this first, an agent asking for a specific seq is guessing. A path that was later deleted still lists every version it had before the delete; a path that has never been written comes back as an empty list rather than an error. Reach for this before accepting a reviewer task: it is how you find out whether current content is the whole story or just the last of several revisions.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "diff_artifact",
    description:
      "A unified diff between two versions of a path — for seeing what a piece of work actually changed instead of judging it from its end state alone, which is the gap ARCHITECTURE.md §5 leaves a `reviewer` in otherwise. Reports one of four outcomes, kept distinct rather than flattened into 'here is a patch': identical:true (both sides are the same bytes, patch is empty because there is nothing to show); binary:true (not text, so patch is a one-line note instead of an attempted line diff); pruned:true (one side's content has been discarded by retention and the comparison genuinely cannot be made — patch explains which side; do not read this as 'no changes', it means 'no answer'); or a real unified patch. Called with neither from_seq nor to_seq, this compares the last two recorded versions of the path, the same default a human gets from `atrium diff` — but a reviewer is usually better served diffing a whole submission, not just its last save: pass from_seq as the task's submittedAtSeq (see get_task or the task.submitted event, which is exactly the log position the work was based on) and leave to_seq out, and this diffs from that starting point up through the path's current version. Call list_versions first if you are not sure which seqs exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        from_seq: {
          type: "number",
          description:
            "Earlier log position. Omit along with to_seq to diff the last two recorded versions. Give this alone (e.g. a task's submittedAtSeq) to diff from here up to the path's current version.",
        },
        to_seq: {
          type: "number",
          description: "Later log position. If given explicitly, from_seq must be given too.",
        },
      },
      required: ["path"],
    },
  },
];
