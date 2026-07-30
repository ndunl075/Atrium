/**
 * The log, as a stream something else can consume.
 *
 * ARCHITECTURE.md §12.4: the log has always *been* a typed event stream, and
 * there was no way for anything outside Atrium to subscribe to it. `atrium
 * log` renders it as prose for a person and stops. So a room could be perfectly
 * observable and still invisible to every tool a person already runs.
 *
 * §1 draws the boundary this file sits on: Atrium is **not an observability
 * product**. It emits the stream and charts nothing. Making the log consumable
 * by something that does chart is the opposite of building that thing.
 *
 * ## Why the payload matters more than the transport
 *
 * `atrium log --json` gives `{ seq, ts, actor, type, line }` — the rendered
 * sentence, not the data behind it. Building the demo turned up what that
 * costs: a `command` acceptance is recorded against the member that *submitted*
 * the work, since that is who triggered the run, and the only thing separating
 * it from a member's own judgement is the phrase "via command" inside the
 * prose. Anyone auditing "did somebody approve their own work" by actor alone
 * gets a false positive, and the only fix available to them was to parse
 * English.
 *
 * So a streamed event carries its `data` verbatim alongside the rendered line.
 * Consumers branch on fields; people read the sentence. Neither has to do the
 * other's job.
 *
 * ## Polling, on purpose
 *
 * The log is SQLite on disk and is appended to by other processes — a stdio
 * MCP server, the CLI, a worker. There is no in-process event to subscribe to,
 * so a poll is the honest mechanism rather than a lazy one. Each tick asks
 * only for entries after the last one seen, so a quiet room costs one indexed
 * query per interval and yields nothing.
 */

import { describeHistory } from "./context.js";
import type { Room } from "./room.js";
import type { AnyEvent, EventType, MemberId } from "./types.js";

/** How often to look for new events when nothing says otherwise. */
export const DEFAULT_POLL_MS = 1_000;

/**
 * One event, in the shape something outside Atrium would want it.
 *
 * Both halves are deliberate: `data` is what a tool branches on, `line` is
 * what a person reads. Dropping either one pushes somebody into parsing the
 * other.
 */
export interface StreamedEvent {
  seq: number;
  ts: string;
  /** The raw actor: a member id, or the literal "system". */
  actor: MemberId | "system";
  /** The member's name, when the actor is one and the roster knows it. */
  actorName?: string;
  type: EventType;
  /** The event's own payload, exactly as recorded. */
  data: Record<string, unknown>;
  /** The same sentence `atrium log` prints. */
  line: string;
}

export interface StreamOptions {
  /** Only events after this sequence. Defaults to the whole log. */
  from?: number;
  /** Only these kinds. An unknown type is refused, not silently unmatched. */
  types?: EventType[];
  /** At most this many, from the start of the filtered result. */
  limit?: number;
}

/**
 * Reads events as `StreamedEvent`s, once.
 *
 * `describeHistory` renders the sentence and applies the filters that need the
 * roster; this joins its output back to the raw payloads it dropped. Going
 * through it rather than re-rendering means the streamed sentence is the same
 * sentence `atrium log` prints, by construction rather than by agreement.
 */
export function readStream(room: Room, options: StreamOptions = {}): StreamedEvent[] {
  const lines = describeHistory(room, options);
  if (lines.length === 0) return [];

  const bySeq = new Map<number, AnyEvent>();
  for (const event of room.log.read({
    from: lines[0]!.seq,
    to: lines[lines.length - 1]!.seq,
  })) {
    bySeq.set(event.seq, event);
  }

  const names = new Map(room.roster().map((member) => [member.id, member.name] as const));

  return lines.map((line) => {
    const raw = bySeq.get(line.seq);
    const name = names.get(line.actor as MemberId);
    return {
      seq: line.seq,
      ts: line.ts,
      actor: line.actor,
      ...(name !== undefined ? { actorName: name } : {}),
      type: line.type,
      data: (raw?.data ?? {}) as Record<string, unknown>,
      line: line.line,
    };
  });
}

export interface FollowHandle {
  /** Stop polling. Safe to call more than once. */
  stop(): void;
  /** The highest sequence handed to the callback so far. */
  get position(): number;
}

export interface FollowOptions extends StreamOptions {
  pollMs?: number;
  /**
   * Called once per tick that found anything, with the new events in order.
   * A batch rather than one call per event, so a consumer can write them in
   * one go.
   */
  onEvents: (events: StreamedEvent[]) => void;
}

/**
 * Follows the log, calling back as new events land.
 *
 * Delivers everything matching `from` immediately, then polls. The timer is
 * unref'd: a stream should never be the reason a process refuses to exit.
 */
export function followEvents(room: Room, options: FollowOptions): FollowHandle {
  const { onEvents, pollMs = DEFAULT_POLL_MS, ...filters } = options;
  let last = filters.from ?? 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;

    // A room whose log has been read past its head yields nothing; asking
    // from `last + 1` every time is what keeps a quiet room cheap.
    const fresh = readStream(room, { ...filters, from: last + 1 });
    if (fresh.length === 0) return;

    last = fresh[fresh.length - 1]!.seq;
    onEvents(fresh);
  };

  tick();

  const timer = setInterval(tick, pollMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get position() {
      return last;
    },
  };
}
