/**
 * Getting context, tiers 1 and 3 (see ARCHITECTURE.md §4).
 *
 * Tier 1 is the shared brief: `CONTEXT.md` at the room root plus whatever
 * artifacts have been pinned alongside it. Tier 3 is the log, turned into
 * sentences a joining agent can read instead of asking somebody to catch it up.
 *
 * Tier 2 (search) lives in search.ts.
 */

import { existsSync, readFileSync } from "node:fs";

import { InvalidError, NotFoundError } from "./errors.js";
import type { ReadOptions } from "./log.js";
import { resolveArtifact, toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";
import type { AnyEvent, MemberId, TaskId } from "./types.js";
import { estimateTokens } from "./util.js";

export interface PinnedArtifact {
  path: string;
  content: string;
}

export interface RoomContext {
  /** The room's CONTEXT.md, verbatim. Empty string if the file is missing. */
  brief: string;
  pinned: PinnedArtifact[];
  /** estimateTokens(brief) plus every pinned file, whether or not it fits. */
  tokens: number;
  ceiling: number;
}

export interface HistoryLine {
  seq: number;
  ts: string;
  actor: MemberId | "system";
  line: string;
}

/**
 * The brief plus everything pinned, and the real token total for it.
 *
 * The total is reported even when it is over the ceiling: `CONTEXT.md` is a
 * plain file an editor can hand-edit past the limit, and hiding that by
 * truncating the number would just move the surprise to somewhere harder to
 * debug. Refusing new pins (see `pinArtifact`) is where the ceiling is
 * actually enforced.
 */
export function getContext(room: Room): RoomContext {
  const brief = existsSync(room.paths.context)
    ? readFileSync(room.paths.context, "utf8")
    : "";

  const pinned: PinnedArtifact[] = [];
  for (const path of listPinned(room)) {
    const abs = resolveArtifact(room.dir, path);
    // A pinned file can be deleted from disk without going through
    // unpinArtifact. Rather than throw on every read afterwards, it just drops
    // out of the brief until somebody either restores it or unpins it.
    if (!existsSync(abs)) continue;
    pinned.push({ path, content: readFileSync(abs, "utf8") });
  }

  const tokens =
    estimateTokens(brief) +
    pinned.reduce((sum, p) => sum + estimateTokens(p.content), 0);

  return { brief, pinned, tokens, ceiling: room.config.contextTokenCeiling };
}

/**
 * Adds a file to the shared brief.
 *
 * ARCHITECTURE.md §6 leaves context overflow as an open question: reject the
 * pin, evict the oldest one, or summarize. This implementation rejects. The
 * whole point of Tier 1 is that it is curated by hand and not lossy, and
 * summarizing to make room reintroduces exactly the lossiness the project
 * exists to avoid. Evicting silently would just move the surprise to whoever
 * next reads the brief and finds something missing. Refusing the pin keeps
 * the decision with a human, who can see the numbers and decide what to drop.
 */
export function pinArtifact(room: Room, actorId: MemberId, path: string): void {
  room.assertUsable();
  room.member(actorId); // throws NotFoundError for a bogus actor

  const abs = resolveArtifact(room.dir, path);
  const relPath = toArtifactPath(room.dir, abs);

  if (listPinned(room).includes(relPath)) return; // already pinned, nothing to do

  if (!existsSync(abs)) {
    throw new NotFoundError(
      `No artifact at ${relPath}. Write it first, then pin it.`,
      { path: relPath },
    );
  }

  const content = readFileSync(abs, "utf8");
  const fileTokens = estimateTokens(content);
  const current = getContext(room).tokens;
  const ceiling = room.config.contextTokenCeiling;
  const prospective = current + fileTokens;

  if (prospective > ceiling) {
    throw new InvalidError(
      `Pinning ${relPath} would bring the room context to ~${prospective} tokens, ` +
        `over the ceiling of ${ceiling}. The brief and current pins are already ` +
        `~${current} tokens; ${relPath} alone is ~${fileTokens}. Unpin something ` +
        `first, or raise contextTokenCeiling if the ceiling is what's wrong.`,
      { path: relPath, currentTokens: current, ceilingTokens: ceiling, fileTokens },
    );
  }

  room.log.append(actorId, "context.pinned", { path: relPath, memberId: actorId });
}

/** Removes a file from the shared brief. A no-op if it was not pinned. */
export function unpinArtifact(room: Room, actorId: MemberId, path: string): void {
  room.assertUsable();
  room.member(actorId);

  const relPath = toArtifactPath(room.dir, resolveArtifact(room.dir, path));
  if (!listPinned(room).includes(relPath)) return;

  room.log.append(actorId, "context.unpinned", { path: relPath, memberId: actorId });
}

/** Currently pinned paths, oldest pin first. */
export function listPinned(room: Room): string[] {
  const pinned = new Map<string, true>();
  for (const event of room.log.read({
    types: ["context.pinned", "context.unpinned"],
  })) {
    if (event.type === "context.pinned") pinned.set(event.data.path, true);
    else if (event.type === "context.unpinned") pinned.delete(event.data.path);
  }
  return [...pinned.keys()];
}

/**
 * Tier 3: the log rendered as sentences, so an agent joining mid-run can read
 * what happened instead of needing somebody to summarize it for them.
 */
export function describeHistory(
  room: Room,
  options: ReadOptions = {},
): HistoryLine[] {
  const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
  const actorName = (id: MemberId | "system"): string =>
    id === "system" ? "system" : names.get(id) ?? id;

  const titles = new Map<TaskId, string>();
  for (const event of room.log.read({ types: ["task.created"] })) {
    if (event.type === "task.created") titles.set(event.data.taskId, event.data.title);
  }
  const taskLabel = (taskId: TaskId): string => {
    const title = titles.get(taskId);
    return title ? `${taskId} (${title})` : taskId;
  };

  return room.log.read(options).map((event) => ({
    seq: event.seq,
    ts: event.ts,
    actor: event.actor,
    line: describeEvent(event, actorName, taskLabel),
  }));
}

function describeEvent(
  event: AnyEvent,
  actorName: (id: MemberId | "system") => string,
  taskLabel: (id: TaskId) => string,
): string {
  switch (event.type) {
    case "room.created":
      return `Room "${event.data.name}" was created.`;

    case "member.joined":
      return `${event.data.name} joined as ${event.data.role}.`;

    case "member.left":
      return `${actorName(event.data.memberId)} left the room.`;

    case "task.created":
      return `${actorName(event.actor)} created ${taskLabel(event.data.taskId)}.`;

    case "task.claimed":
      return `${actorName(event.data.memberId)} claimed ${taskLabel(event.data.taskId)}.`;

    case "task.released":
      return `${actorName(event.data.memberId)} released ${taskLabel(event.data.taskId)} (${
        event.data.reason === "lease-expired" ? "claim expired" : "voluntarily"
      }).`;

    case "task.blocked":
      return `${taskLabel(event.data.taskId)} is blocked, waiting on ${event.data.waitingOn
        .map(taskLabel)
        .join(", ")}.`;

    case "task.unblocked":
      return `${taskLabel(event.data.taskId)} is unblocked.`;

    case "task.submitted":
      return `${actorName(event.data.memberId)} submitted ${taskLabel(event.data.taskId)}: ${event.data.summary}`;

    case "task.accepted":
      return `${actorName(event.data.by)} accepted ${taskLabel(event.data.taskId)} via ${event.data.via}${
        event.data.detail ? `: ${event.data.detail}` : ""
      }.`;

    case "task.rejected":
      return `${actorName(event.data.by)} rejected ${taskLabel(event.data.taskId)}: ${event.data.reason}`;

    case "task.escalated":
      return `${taskLabel(event.data.taskId)} was escalated after ${event.data.attempts} rejections; it needs a human.`;

    case "artifact.written":
      return `${actorName(event.data.memberId)} wrote ${event.data.path} (${event.data.bytes} bytes).`;

    case "artifact.deleted":
      return `${actorName(event.data.memberId)} deleted ${event.data.path}.`;

    case "lease.acquired":
      return `${actorName(event.data.memberId)} acquired a lease on ${event.data.path}.`;

    case "lease.renewed":
      return `${actorName(event.data.memberId)} renewed the lease on ${event.data.path}.`;

    case "lease.released":
      return `${actorName(event.data.memberId)} released the lease on ${event.data.path} (${event.data.reason}).`;

    case "context.pinned":
      return `${actorName(event.data.memberId)} pinned ${event.data.path} to the room context.`;

    case "context.unpinned":
      return `${actorName(event.data.memberId)} unpinned ${event.data.path} from the room context.`;

    case "note.posted":
      return event.data.taskId
        ? `${actorName(event.data.memberId)} noted on task ${taskLabel(event.data.taskId)}: ${event.data.text}`
        : `${actorName(event.data.memberId)} noted: ${event.data.text}`;

    case "room.halted":
      return `Room halted: ${event.data.reason}`;

    default: {
      // Logs outlast the code that reads them. A type this build does not know
      // about (a future event, or a log written by a different version of
      // Atrium) should still render as something a human or agent can read,
      // rather than take the whole catch-up down with it. The switch above is
      // exhaustive over today's EventMap, which is exactly why this branch
      // needs a cast: it only exists for events the type system doesn't
      // believe can happen.
      const unknown = event as AnyEvent;
      return `${actorName(unknown.actor)} recorded an event this reader does not know how to describe: "${unknown.type}".`;
    }
  }
}
