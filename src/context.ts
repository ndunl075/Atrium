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
import { loadBlob, storeBlob } from "./snapshots.js";
import type { AnyEvent, EventType, MemberId, TaskId } from "./types.js";
import { estimateTokens, sha256 } from "./util.js";

export interface PinnedArtifact {
  path: string;
  content: string;
}

export interface RoomContext {
  /** The room's CONTEXT.md, verbatim. Empty string if the file is missing. */
  brief: string;
  /**
   * The brief split into its `##` sections, largest first (§12.10). A brief
   * with no headings has one block; a missing brief has none.
   */
  blocks: ContextBlock[];
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

  const blocks = parseContextBlocks(brief).sort((a, b) => b.tokens - a.tokens);

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

  return { brief, blocks, pinned, tokens, ceiling: room.config.contextTokenCeiling };
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
        `~${current} tokens; ${relPath} alone is ~${fileTokens}.` +
        // Naming the biggest parts of the brief matters when the brief is
        // what is actually full: unpinning is no help then, and without this
        // the message would only ever offer the remedy that cannot work.
        `${describeLargestBlocks(room)} ${options}`,
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

// ---------------------------------------------------------------------------
// Named blocks
//
// ARCHITECTURE.md §12.10, from Letta's memory blocks (§13.3). Letta keeps
// labelled, individually editable blocks — persona, goals, constraints —
// always in context. The thing worth taking is not the storage model but the
// *addressability*: once the brief has named parts, "the brief is too long"
// becomes "the constraints block is 400 of your 500 tokens", which is a
// sentence somebody can act on.
//
// Blocks are `##` headings inside CONTEXT.md, not a new store. §4 is built on
// the brief being a plain file anybody can open in an editor, and that is
// worth more than tidy addressing — so this is a *reading* of the file that
// already exists, and a room whose brief has no headings simply has one
// unnamed block.
//
// What this deliberately does not do is change the overflow policy. §6 leans
// toward refusing a pin and making a person choose, and that is still what
// happens; blocks only make the refusal legible.
// ---------------------------------------------------------------------------

export interface ContextBlock {
  /** Slug from the heading: "House style" becomes "house-style". */
  name: string;
  /** The heading as written, or undefined for text above the first one. */
  heading?: string;
  /** The block's body, without its heading line. */
  text: string;
  tokens: number;
}

/** Text before any `##` heading, which is most rooms' whole brief. */
const PREAMBLE_BLOCK = "preamble";

/**
 * Splits a brief into its named blocks.
 *
 * Only `##` and deeper count as block boundaries. A single `#` is the
 * document title in every brief this project writes — `Room.create` and every
 * job file open with one — so treating it as a block would give every room a
 * single block called after itself, which names nothing.
 */
export function parseContextBlocks(brief: string): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  let current: { heading?: string; lines: string[] } = { lines: [] };

  const flush = (): void => {
    const text = current.lines.join("\n").trim();
    // A heading with nothing under it is still a block: it is a section
    // somebody made and has not filled in, and hiding it would make the
    // brief's own structure disagree with what this reports.
    if (text === "" && current.heading === undefined) return;
    blocks.push({
      name: current.heading === undefined ? PREAMBLE_BLOCK : slug(current.heading),
      ...(current.heading !== undefined ? { heading: current.heading } : {}),
      text,
      tokens: estimateTokens(text),
    });
  };

  for (const line of brief.split("\n")) {
    const heading = /^#{2,6}\s+(.*\S)\s*$/.exec(line);
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    flush();
    current = { heading: heading[1], lines: [] };
  }
  flush();

  return blocks;
}

function slug(heading: string): string {
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * The brief's blocks, largest first — the order somebody trimming it wants.
 *
 * Sorted rather than in document order because the only time anybody asks for
 * this is when the brief is too big, and then the question is always "what is
 * taking up the room".
 */
export function contextBlocks(room: Room): ContextBlock[] {
  const brief = existsSync(room.paths.context)
    ? readFileSync(room.paths.context, "utf8")
    : "";
  return parseContextBlocks(brief).sort((a, b) => b.tokens - a.tokens);
}

/** The biggest blocks, named and sized, for a message about being over budget. */
function describeLargestBlocks(room: Room, howMany = 3): string {
  const blocks = contextBlocks(room).filter((block) => block.tokens > 0);
  if (blocks.length === 0) return "";

  const named = blocks
    .slice(0, howMany)
    .map((block) => `${block.name} (~${block.tokens})`)
    .join(", ");
  return blocks.length === 1 && blocks[0]!.name === PREAMBLE_BLOCK
    ? ` The brief itself is ~${blocks[0]!.tokens} tokens and has no "## " headings, so there is no smaller part of it to point at.`
    : ` The largest parts of the brief are ${named}.`;
}

// ---------------------------------------------------------------------------
// Recording the brief
//
// ARCHITECTURE.md §3.5 claims the log is the single source of truth, and until
// `context.written` existed that was false in one place: pinning was an event,
// editing CONTEXT.md was not. The log held every consequence of the
// instruction and never the instruction itself.
//
// The awkward part is that the brief must stay a plain file somebody can edit
// in any editor — §4 is built on that, and the README tells people to do it.
// So this cannot be a write path the way artifacts are. It is a *capture*:
// hash what is on disk, compare it to the last hash recorded, and append an
// event only when they differ. Nothing is forced through Atrium, and nothing
// is lost either.
// ---------------------------------------------------------------------------

/** What the brief looked like at some point, or why it cannot be read back. */
export type BriefVersion =
  | { state: "present"; text: string; hash: string; seq: number }
  /** Nothing recorded at or before that point. */
  | { state: "absent" }
  /** Recorded, but its bytes are gone from the object store. */
  | { state: "pruned"; hash: string; bytes: number; seq: number };

export interface RecordBriefResult {
  /** False when the brief was already recorded at this exact content. */
  recorded: boolean;
  hash: string;
  bytes: number;
}

/** The brief as it is on disk right now, and its hash. Empty if there is none. */
function briefOnDisk(room: Room): { text: string; hash: string; bytes: number } {
  const text = existsSync(room.paths.context)
    ? readFileSync(room.paths.context, "utf8")
    : "";
  const bytes = Buffer.from(text, "utf8");
  return { text, hash: sha256(bytes), bytes: bytes.length };
}

/** The most recent `context.written` at or before `seq`, if there is one. */
function lastRecorded(
  room: Room,
  seq?: number,
): { hash: string; bytes: number; seq: number } | undefined {
  // The `types` filter runs in SQL, but the returned rows are still typed as
  // the whole event union — narrowing has to happen here for the payload to
  // be readable.
  const last = room.log
    .read({
      types: ["context.written"],
      ...(seq !== undefined ? { to: seq } : {}),
      order: "desc",
      limit: 1,
    })
    .find((event) => event.type === "context.written");

  return last === undefined
    ? undefined
    : { hash: last.data.hash, bytes: last.data.bytes, seq: last.seq };
}

/**
 * Records what the brief currently says, if that is not already recorded.
 *
 * Returns `recorded: false` when the content is unchanged, and appends
 * nothing — this is called on every join, and a room where the brief never
 * changes should not grow an event per member for it. Every event costs
 * budget (see `Room.assertUsable`), so "only when it actually changed" is a
 * correctness property here, not an optimisation.
 *
 * `source` is the honest half of this. `atrium` means the caller wrote the
 * brief through Atrium and the actor authored it; `observed` means the file
 * changed underneath and this is a room noticing, which is not the same claim
 * and must not be recorded as though it were.
 */
export function recordBrief(
  room: Room,
  actor: MemberId | "system",
  source: "atrium" | "observed" = "atrium",
): RecordBriefResult {
  const { text, hash, bytes } = briefOnDisk(room);
  const previous = lastRecorded(room);

  if (previous?.hash === hash) return { recorded: false, hash, bytes };

  // An empty brief that has never been recorded is not worth an event: a room
  // whose CONTEXT.md is missing or blank has nothing to say, and recording
  // that on every fresh room would put a meaningless version at the head of
  // every history.
  if (previous === undefined && bytes === 0) return { recorded: false, hash, bytes };

  storeBlob(room, hash, Buffer.from(text, "utf8"));
  room.log.append(actor, "context.written", { hash, bytes, source });
  return { recorded: true, hash, bytes };
}

/**
 * The brief as it stood right after log position `seq`.
 *
 * The same "as of this point in the log" model `atrium replay` uses, applied
 * to the one input that decides what every agent does.
 */
export function briefAt(room: Room, seq: number): BriefVersion {
  const recorded = lastRecorded(room, seq);
  if (recorded === undefined) return { state: "absent" };

  const bytes = loadBlob(room, recorded.hash);
  if (bytes === undefined) {
    return { state: "pruned", hash: recorded.hash, bytes: recorded.bytes, seq: recorded.seq };
  }
  return {
    state: "present",
    text: bytes.toString("utf8"),
    hash: recorded.hash,
    seq: recorded.seq,
  };
}

export interface BriefVersionInfo {
  seq: number;
  ts: string;
  actor: MemberId | "system";
  hash: string;
  bytes: number;
  source: "atrium" | "observed";
  /** False once a retention sweep has taken the content. */
  readable: boolean;
}

/** Every recorded version of the brief, oldest first. */
export function briefHistory(room: Room): BriefVersionInfo[] {
  return room.log
    .read({ types: ["context.written"] })
    .filter((event) => event.type === "context.written")
    .map((event) => ({
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      hash: event.data.hash,
      bytes: event.data.bytes,
      source: event.data.source,
      readable: loadBlob(room, event.data.hash) !== undefined,
    }));
}

export interface BriefDrift {
  /** True when what is on disk is not what the log last recorded. */
  drifted: boolean;
  diskHash: string;
  recordedHash?: string;
}

/**
 * Whether the brief on disk matches the last version recorded.
 *
 * Drift is normal and expected — somebody edited CONTEXT.md and nobody has
 * joined since — so this is not an error anywhere. It is what lets
 * `atrium verify` say so out loud instead of leaving a room quietly
 * disagreeing with its own log.
 */
export function briefDrift(room: Room): BriefDrift {
  const { hash, bytes } = briefOnDisk(room);
  const recorded = lastRecorded(room);

  // A room with no brief and nothing recorded has not drifted; it is empty.
  if (recorded === undefined) {
    return { drifted: bytes > 0, diskHash: hash };
  }
  return { drifted: recorded.hash !== hash, diskHash: hash, recordedHash: recorded.hash };
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

    case "context.written":
      // "changed" rather than "wrote" for an observed capture, because nobody
      // in the room did it — the file changed and the room noticed.
      return event.data.source === "observed"
        ? `The brief changed on disk (${event.data.bytes} bytes), recorded when it was next read.`
        : `${actorName(event.actor)} wrote the room's brief (${event.data.bytes} bytes).`;

    case "note.posted":
      return event.data.taskId
        ? `${actorName(event.data.memberId)} noted on task ${taskLabel(event.data.taskId)}: ${event.data.text}`
        : `${actorName(event.data.memberId)} noted: ${event.data.text}`;

    case "task.input_requested":
      return `${actorName(event.data.memberId)} is stuck on ${taskLabel(event.data.taskId)} and asked: ${event.data.question}`;

    case "task.input_supplied":
      return `${actorName(event.data.memberId)} answered on ${taskLabel(event.data.taskId)}: ${event.data.answer}`;

    case "task.input_withdrawn":
      return `${actorName(event.data.memberId)} withdrew its question on ${taskLabel(event.data.taskId)} and carried on.`;

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
