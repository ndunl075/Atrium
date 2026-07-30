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
import { resolveArtifact, toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";
import type { AnyEvent, EventType, MemberId, TaskId } from "./types.js";
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
  /**
   * The event type this line was folded from. `describeHistory` exists to
   * turn the log into prose, but a reader that already has the prose (the
   * watch UI's live stream, see watch.ts) still needs to know what *kind* of
   * thing happened, to decide whether a folded view like the board needs
   * re-drawing. Carrying it here means that decision does not require a
   * second read of the log to recover a field this one already had.
   */
  type: EventType;
}

/**
 * `describeHistory`'s filters. `from`, `to`, `types`, and `limit` are exactly
 * `ReadOptions` (see log.ts) — the sequence range and type filter are applied
 * in SQL before anything is rendered, and an unknown type is refused there
 * with the list of valid ones rather than quietly matching nothing.
 *
 * `actor` and `contains` exist only here, not in `ReadOptions`, because both
 * need something the raw log does not have: `actor` needs the roster (to let
 * a person say "scout" instead of a member id), and `contains` needs the
 * rendered sentence, which does not exist until `describeEvent` has run.
 * Both filters, and `limit`, are therefore applied after the SQL read rather
 * than passed into it — `limit` still means "at most this many, taken from
 * the start of the *filtered* result," which only changes anything when it
 * is combined with `actor` or `contains`.
 */
export interface HistoryOptions {
  /** First sequence to include. Defaults to the beginning. */
  from?: number;
  /** Last sequence to include, inclusive. Defaults to the end. */
  to?: number;
  /** Only these kinds of event. An unknown type is refused, not ignored. */
  types?: EventType[];
  /**
   * Only events caused by this actor. Matched exactly against either the raw
   * actor recorded in the log (a member id, or the literal "system") or the
   * name that member joined under — whichever a caller is more likely to
   * have on hand. Case-sensitive and exact, not a substring: these are
   * identifiers, and ARCHITECTURE.md §3.2 puts no uniqueness rule on member
   * names, so a loose match on "scout" could quietly blend two different
   * members who happened to pick the same name.
   */
  actor?: string;
  /**
   * Only lines whose rendered sentence contains this text — the same text
   * "atrium log" prints and the same text the MCP `read_log` tool returns,
   * not the raw JSON underneath it. That is the text a person or agent
   * catching up is actually reading, and it is where names and task titles
   * already live in prose form. Matched case-insensitively, because a
   * rendered sentence capitalizes the start of every line and a caller
   * searching for a word in the middle of one has no reason to also get the
   * casing right. Always a plain substring search, never a regular
   * expression: a malformed pattern typed at a command line or handed over
   * by an agent should never be able to throw partway through printing a
   * room's history — a substring match that always works beats a regex that
   * sometimes doesn't.
   */
  contains?: string;
  /** At most this many lines, taken from the start of the filtered result. */
  limit?: number;
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
    const overBy = prospective - ceiling;
    const alreadyPinned = listPinned(room);
    // The whole point of rejecting instead of evicting or summarizing (see the
    // doc comment above) is that a person decides what happens next. That only
    // works if the message actually hands them a decision: what this pin would
    // have cost, what the ceiling is, and — concretely, by name — what could be
    // unpinned to make room, rather than a generic "unpin something."
    const options =
      alreadyPinned.length > 0
        ? `Currently pinned: ${alreadyPinned.join(", ")}. Unpin one of those ` +
          `("atrium context --unpin <path>", or the unpin_artifact MCP tool) to make room, ` +
          `or raise contextTokenCeiling in .atrium/room.json if the ceiling itself is too low.`
        : `Nothing else is pinned, so there is nothing to unpin: raise ` +
          `contextTokenCeiling in .atrium/room.json, or pin something smaller.`;
    throw new InvalidError(
      `Pinning ${relPath} would bring the room context to ~${prospective} tokens, ` +
        `${overBy} over the ceiling of ${ceiling}. The brief and current pins are already ` +
        `~${current} tokens; ${relPath} alone is ~${fileTokens}. ${options}`,
      {
        path: relPath,
        currentTokens: current,
        ceilingTokens: ceiling,
        fileTokens,
        overBy,
        pinned: alreadyPinned,
      },
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
 *
 * See `HistoryOptions` for what each filter matches and why; they intersect
 * rather than widen the result, the same as every other multi-filter listing
 * in this codebase (`atrium config`'s settings, `list_tasks`'s state and
 * claimable) — passing more than one narrows further, it never means "or."
 */
export function describeHistory(
  room: Room,
  options: HistoryOptions = {},
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

  const { actor, contains, limit, ...rangeOptions } = options;

  // Sequence range and event type narrow the SQL read itself, exactly like
  // every other caller of EventLog.read — cheapest to apply first, and it's
  // where an unknown --type gets refused (see log.ts). actor and contains
  // cannot: actor needs the roster this function already built above, and
  // contains needs the rendered sentence, which does not exist until
  // describeEvent runs below, so both are applied as a second pass after.
  let events = room.log.read(rangeOptions);
  if (actor !== undefined) {
    events = events.filter((event) => event.actor === actor || actorName(event.actor) === actor);
  }

  let lines = events.map((event) => ({
    seq: event.seq,
    ts: event.ts,
    actor: event.actor,
    line: describeEvent(event, actorName, taskLabel),
    type: event.type,
  }));

  if (contains !== undefined) {
    const needle = contains.toLowerCase();
    lines = lines.filter((line) => line.line.toLowerCase().includes(needle));
  }

  // Applied last, and against the filtered result, not the raw read: "at
  // most N" should mean N after actor/contains have already narrowed things
  // down, not N events that then get filtered down further to fewer than N.
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new InvalidError("limit must be a whole number, zero or more.");
    }
    lines = lines.slice(0, limit);
  }

  return lines;
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

    case "task.claim_renewed":
      return `${actorName(event.data.memberId)} renewed the claim on ${taskLabel(event.data.taskId)}.`;

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

    case "task.unescalated":
      return `${taskLabel(event.data.taskId)} was restarted by a human and can be claimed again.`;

    case "artifact.written":
      return `${actorName(event.data.memberId)} wrote ${event.data.path} (${event.data.bytes} bytes).`;

    case "artifact.deleted":
      return `${actorName(event.data.memberId)} deleted ${event.data.path}.`;

    case "artifact.pruned":
      return `Dropped the content of ${event.data.seqs.length} old version${event.data.seqs.length === 1 ? "" : "s"} of ${event.data.path}, keeping the most recent ${event.data.retained} (${event.data.bytesReclaimed} bytes reclaimed).`;

    case "lease.acquired":
      return `${actorName(event.data.memberId)} acquired a lease on ${event.data.path}.`;

    case "lease.renewed":
      return `${actorName(event.data.memberId)} renewed the lease on ${event.data.path}.`;

    case "lease.released": {
      const holder = actorName(event.data.memberId);
      // "forced" is the one case where the actor and the holder differ — a
      // human took somebody else's lease away — and that is exactly the fact
      // "atrium log" exists to make visible, so it gets its own sentence
      // rather than being squeezed into the same template as the other two.
      if (event.data.reason === "forced") {
        return `${actorName(event.actor)} force-released ${holder}'s lease on ${event.data.path}.`;
      }
      return `${holder} released the lease on ${event.data.path} (${event.data.reason}).`;
    }

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

    case "room.forked": {
      // Everything above this line in the log happened in another room. Saying
      // so is the point: a reader who does not know that would take the copied
      // history for this room's own, which is true of its content and false
      // about where it came from.
      const missing = event.data.unrecoverablePaths;
      return (
        `Forked from "${event.data.fromName}" at event ${event.data.atSeq}. ` +
        `Everything above this line happened there.` +
        (missing.length > 0
          ? ` Content for ${missing.length} path(s) had been pruned and could not come across: ${missing.join(", ")}.`
          : "")
      );
    }

    case "cost.reported":
      return `${actorName(event.data.memberId)} reported $${event.data.amountUsd.toFixed(2)}${
        event.data.model ? ` (${event.data.model})` : ""
      }.`;

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
