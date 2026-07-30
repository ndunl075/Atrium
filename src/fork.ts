/**
 * Forking a room from a point in its log.
 *
 * ARCHITECTURE.md §3.5 has claimed since the first draft that replayability
 * is the actual product feature. `atrium replay 12` collects half of that: it
 * shows how the board looked at event 12. Nothing could *continue* from event
 * 12, which is the half people actually want. When a run goes wrong at step
 * 40 because of a decision at step 12, the choices were re-run the whole job
 * and hope, or hand-patch the end state.
 *
 * A fork is a new room that is the old one as it stood at a chosen event, and
 * is then free to go differently. §13.1 records where the idea came from —
 * LangGraph's time travel — and why Atrium can do it better than the thing it
 * was borrowed from: LangGraph branches from a checkpoint, which is whatever
 * state the framework thought to persist, while this has every event and,
 * since v0.2, every artifact version's bytes. The reconstruction is exact
 * rather than approximate.
 *
 * ## What a fork is honest about, and what it cannot be
 *
 * **It reproduces the room, not the world.** The log records that a command
 * acceptance ran and passed. It does not record that the command sent an
 * email, and forking cannot unsend one. A fork rewinds a room's own state and
 * nothing it touched, so a room whose commands reach outside itself is a room
 * whose forks are only partly true. The CLI says so out loud rather than
 * leaving somebody to work it out after trusting one.
 *
 * **The brief comes back too, now.** This originally could not rewind
 * `CONTEXT.md`, because editing the brief was a plain file write that nothing
 * recorded — a genuine hole in the §3.5 claim that forking was simply the
 * first feature to trip over. `context.written` closed it, so a fork gets the
 * brief the parent had at the fork point: the instruction every decision in
 * the copied history was made against. Two cases still fall back to the
 * parent's current brief and say so — a room whose brief predates that event
 * existing, and one whose recorded bytes a retention sweep has taken.
 *
 * **A pruned version cannot come back.** If a retention sweep dropped the
 * bytes of a version the fork needs, the fork has no way to recreate them.
 * Those paths are named in the result and in the `room.forked` event, so the
 * new room's own history says what is missing rather than presenting a file
 * that was never there as absent.
 *
 * ## Provenance
 *
 * The fork's log is the parent's events 1..N, byte for byte, followed by one
 * `room.forked` event. Everything at or below N replays identically in both
 * rooms; the divergence has a sequence number. Provenance lives in the log
 * rather than only in `room.json` because a room that could not say what it
 * was forked from would be telling the truth about everything except its own
 * first cause.
 *
 * Tokens are deliberately not copied. A session token is a credential, and
 * copying credentials into a new location as a side effect of a debugging
 * command is not a thing this should do quietly. Members exist in the fork —
 * they are in the copied history — but nobody can authenticate as one until
 * somebody runs `atrium invite` against the fork.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { listArtifacts, listDeletedArtifacts } from "./artifacts.js";
import { briefAt } from "./context.js";
import { InvalidError } from "./errors.js";
import { EventLog } from "./log.js";
import { roomPaths } from "./paths.js";
import { Room } from "./room.js";
import { contentStateAt, listVersions, loadBlob, storeBlob } from "./snapshots.js";
import { foldTasks } from "./tasks.js";
import type { AnyEvent, RoomConfig } from "./types.js";
import { newId, now } from "./util.js";

/** A path the fork will hold, and how big it will be. */
export interface ForkFile {
  path: string;
  bytes: number;
}

/** A path the parent knew about at the fork point but can no longer produce. */
export interface ForkGap {
  path: string;
  hash: string;
  bytes: number;
}

export interface ForkPlan {
  /** The parent sequence number being forked from. */
  atSeq: number;
  /** The parent's head, so a caller can see how much is being left behind. */
  parentHead: number;
  /** Events that will be copied. */
  events: number;
  members: number;
  tasks: number;
  /** Files the fork will start with. */
  files: ForkFile[];
  /** Paths whose bytes were pruned out of the parent, so the fork has none. */
  gaps: ForkGap[];
  /** True when the parent had stopped at or before the fork point. */
  inheritsHalt: boolean;
}

export interface ForkResult extends ForkPlan {
  /** Where the new room was written. */
  dir: string;
  name: string;
  roomId: string;
  /** What happened to the brief, and whether it could be rewound. */
  context: ContextOutcome;
}

/**
 * Works out what forking at `atSeq` would produce, without writing anything.
 *
 * Separate from `forkRoom` so `--dry-run` shows exactly what the real thing
 * would do, rather than an approximation of it: `forkRoom` calls this and
 * then acts on the result.
 */
export function planFork(source: Room, atSeq: number): ForkPlan {
  const parentHead = source.log.head();

  if (!Number.isInteger(atSeq) || atSeq < 1) {
    throw new InvalidError(
      `A fork point must be a whole event number, 1 or greater (got ${JSON.stringify(atSeq)}).`,
    );
  }
  if (atSeq > parentHead) {
    throw new InvalidError(
      `This room's log ends at ${parentHead}, so there is no event ${atSeq} to fork from.`,
    );
  }

  const events = source.log.read({ to: atSeq });

  const members = new Set<string>();
  for (const event of events) {
    if (event.type === "member.joined") members.add(event.data.memberId);
    if (event.type === "member.left") members.delete(event.data.memberId);
  }

  const tasks = foldTasks(
    events.filter((event) => event.type.startsWith("task.")),
    { maxAttempts: source.config.maxAttempts },
  );

  const files: ForkFile[] = [];
  const gaps: ForkGap[] = [];
  for (const path of everyPathEverWritten(source)) {
    const content = contentStateAt(source, path, atSeq);
    if (content.state === "present") files.push({ path, bytes: content.bytes.length });
    else if (content.state === "pruned") {
      gaps.push({ path, hash: content.hash, bytes: content.bytes });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  gaps.sort((a, b) => a.path.localeCompare(b.path));

  return {
    atSeq,
    parentHead,
    events: events.length,
    members: members.size,
    tasks: tasks.size,
    files,
    gaps,
    inheritsHalt: events.some((event) => event.type === "room.halted"),
  };
}

export interface ForkOptions {
  /** Defaults to the parent's head — a fork of the room as it stands. */
  at?: number;
  /** Defaults to the target directory's name. */
  name?: string;
}

/**
 * Writes a new room that is `source` as it stood at `options.at`.
 *
 * The order here matters. History is imported before anything else exists,
 * because `importHistory` refuses a log that already holds events, and that
 * refusal is what guarantees the fork's sequence numbers line up with the
 * parent's. Every `basedOnSeq`, every artifact version, and every prune
 * record in the copied events refers to those numbers.
 */
export function forkRoom(source: Room, targetDir: string, options: ForkOptions = {}): ForkResult {
  const atSeq = options.at ?? source.log.head();
  const plan = planFork(source, atSeq);

  const paths = roomPaths(targetDir);
  // Checked before "already a room", which would otherwise be the message a
  // self-fork produced — true, but unhelpful about what went wrong.
  if (paths.root === source.dir) {
    throw new InvalidError("A room cannot be forked over itself. Give the fork its own directory.");
  }
  if (existsSync(paths.config)) {
    throw new InvalidError(`${paths.root} is already a room.`);
  }

  const name = options.name?.trim() || basenameOf(paths.root);
  const config: RoomConfig = {
    // Everything the parent was configured with — lease lengths, caps,
    // budgets — carries over. A fork that quietly reset those would not be
    // the same room re-run, which is the only thing a fork is for.
    ...source.config,
    id: newId("room"),
    name,
    createdAt: now(),
  };

  mkdirSync(paths.atrium, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(config, null, 2) + "\n", "utf8");
  // Deliberately empty: see the note on tokens in this module's doc comment.
  writeFileSync(paths.tokens, "{}\n", { encoding: "utf8", mode: 0o600 });

  const log = EventLog.open(paths.db);
  try {
    log.importHistory(source.log.read({ to: atSeq }) as AnyEvent[]);
    log.append("system", "room.forked", {
      fromRoomId: source.config.id,
      fromName: source.config.name,
      atSeq,
      unrecoverablePaths: plan.gaps.map((gap) => gap.path),
    });
  } finally {
    log.close();
  }

  const fork = Room.open(paths.root);
  try {
    copyBlobs(source, fork, atSeq);
    materialize(source, fork, atSeq, plan);
    const context = copyContext(source, fork, atSeq);

    return { ...plan, dir: fork.dir, name, roomId: config.id, context };
  } finally {
    fork.close();
  }
}

// ---------------------------------------------------------------------------
// the pieces
// ---------------------------------------------------------------------------

/**
 * Every path the room has ever written, including ones later deleted.
 *
 * The deleted ones matter: a path that existed at the fork point and was
 * removed at event 30 has to come back in a fork taken at event 20, and it
 * does not appear in `listArtifacts` because it does not exist now.
 */
function everyPathEverWritten(room: Room): string[] {
  const paths = new Set<string>();
  for (const artifact of listArtifacts(room)) paths.add(artifact.path);
  for (const deleted of listDeletedArtifacts(room)) paths.add(deleted.path);
  return [...paths];
}

/**
 * Copies the bytes of every version at or below the fork point, not only the
 * ones the fork starts with on disk.
 *
 * Copying just the current content would give a fork that works and has no
 * past: `atrium history` would list versions whose content could not be read,
 * and `atrium diff` would refuse. The whole argument for forking is that the
 * history comes too.
 */
function copyBlobs(source: Room, fork: Room, atSeq: number): void {
  const copied = new Set<string>();

  for (const path of everyPathEverWritten(source)) {
    for (const version of listVersions(source, path)) {
      if (version.seq > atSeq || version.kind !== "written" || !version.hash) continue;
      if (copied.has(version.hash)) continue;
      copied.add(version.hash);

      // A pruned version has no bytes to copy. That is recorded in the plan's
      // gaps rather than treated as an error: the parent's own log already
      // says the content was dropped, and the fork inherits that history
      // truthfully by also not having it.
      const bytes = loadBlob(source, version.hash);
      if (bytes !== undefined) storeBlob(fork, version.hash, bytes);
    }
  }
}

function materialize(source: Room, fork: Room, atSeq: number, plan: ForkPlan): void {
  for (const file of plan.files) {
    const content = contentStateAt(source, file.path, atSeq);
    if (content.state !== "present") continue;

    const target = join(fork.dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.bytes);
  }
}

/**
 * Writes the fork's brief: the one the parent had at the fork point.
 *
 * This used to copy the current `CONTEXT.md` regardless, because nothing
 * recorded what the brief said at any earlier point. `context.written` fixed
 * that, so a fork now rewinds the brief along with everything else — which
 * matters more here than almost anywhere, since the brief is the instruction
 * every decision in the copied history was made against.
 *
 * Two cases still fall back to the parent's current brief, and both say so:
 * a room whose brief was never recorded (written before this existed), and a
 * recorded version whose bytes a retention sweep has taken.
 */
function copyContext(source: Room, fork: Room, atSeq: number): ContextOutcome {
  const recorded = briefAt(source, atSeq);

  if (recorded.state === "present") {
    writeFileSync(fork.paths.context, recorded.text, "utf8");
    return { copied: true, rewound: true };
  }

  if (!existsSync(source.paths.context)) {
    return { copied: false, rewound: false };
  }
  writeFileSync(fork.paths.context, readFileSync(source.paths.context));
  return {
    copied: true,
    rewound: false,
    reason: recorded.state === "pruned" ? "pruned" : "never-recorded",
  };
}

export interface ContextOutcome {
  copied: boolean;
  /** True when the fork got the brief as of the fork point, not the current one. */
  rewound: boolean;
  /** Why it could not be rewound, when it could not. */
  reason?: "pruned" | "never-recorded";
}

function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "fork";
}
