/**
 * The event log: append-only, totally ordered, and the only place state
 * actually lives.
 *
 * The task board and the roster are folded out of this log rather than stored
 * next to it. That costs a little speed on every read and buys the thing that
 * makes a multi-agent system debuggable at all: any run can be replayed to any
 * point, and there is no second copy of the truth to drift out of step.
 */

import { openDb, type Db } from "./db.js";
import { InvalidError } from "./errors.js";
import { eventTypes, isEventType } from "./types.js";
import type { AnyEvent, Event, EventMap, EventType, MemberId } from "./types.js";
import { now } from "./util.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    TEXT    NOT NULL,
  actor TEXT    NOT NULL,
  type  TEXT    NOT NULL,
  data  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_type ON events(type, seq);

-- The append-only rule is worth enforcing where it cannot be argued with.
CREATE TRIGGER IF NOT EXISTS events_are_immutable_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'the event log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_are_immutable_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'the event log is append-only');
END;
`;

export interface ReadOptions {
  /** First sequence to include. Defaults to the beginning. */
  from?: number;
  /** Last sequence to include, inclusive. Defaults to the end. */
  to?: number;
  /** Only these kinds of event. */
  types?: EventType[];
  /** Sequence order. Defaults to oldest first. */
  order?: "asc" | "desc";
  /** At most this many, taken after sorting in the requested order. */
  limit?: number;
}

export interface PendingEvent<T extends EventType = EventType> {
  actor: MemberId | "system";
  type: T;
  data: EventMap[T];
}

export class EventLog {
  private constructor(private readonly db: Db) {}

  static open(dbPath: string): EventLog {
    const db = openDb(dbPath);
    db.exec(SCHEMA);
    return new EventLog(db);
  }

  /** Records one thing that happened and returns it with its sequence number. */
  append<T extends EventType>(
    actor: MemberId | "system",
    type: T,
    data: EventMap[T],
  ): Event<T> {
    return this.appendMany([{ actor, type, data }])[0] as Event<T>;
  }

  /**
   * Records several things as one unit. Either the whole batch lands or none of
   * it does, which is how a single decision that produces two events (accepting
   * a task and unblocking what it was holding up, say) stays atomic.
   */
  appendMany(entries: PendingEvent[]): AnyEvent[] {
    if (entries.length === 0) return [];

    return this.db.transaction(() => {
      const insert = this.db.prepare(
        "INSERT INTO events (ts, actor, type, data) VALUES (?, ?, ?, ?)",
      );
      const written: AnyEvent[] = [];

      for (const entry of entries) {
        const ts = now();
        const json = JSON.stringify(entry.data ?? {});
        const { lastInsertRowid } = insert.run(ts, entry.actor, entry.type, json);
        written.push({
          seq: lastInsertRowid,
          ts,
          actor: entry.actor,
          type: entry.type,
          data: entry.data,
        } as AnyEvent);
      }

      return written;
    });
  }

  /**
   * Copies history into a log that has none, keeping each event's original
   * sequence number, timestamp and actor.
   *
   * This exists for one caller — `forkRoom` — and is deliberately awkward to
   * use for anything else. `append` stamps `now()` on everything it writes,
   * which is right for something happening and wrong for something being
   * copied: a fork whose events all claim to have happened at the moment of
   * forking would be a room that lies about its own history, and the history
   * is the entire reason to fork.
   *
   * Refuses a log that already holds anything. Interleaving copied history
   * with events of its own would produce a log whose sequence numbers no
   * longer line up with the room it came from, and every artifact version,
   * `basedOnSeq`, and prune record in the copied events refers to those
   * numbers.
   */
  importHistory(events: AnyEvent[]): void {
    if (events.length === 0) return;

    this.db.transaction(() => {
      if (this.head() !== 0) {
        throw new InvalidError(
          "History can only be imported into an empty log. This one already has " +
            `${this.count()} event(s).`,
        );
      }

      const insert = this.db.prepare(
        "INSERT INTO events (seq, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)",
      );
      let previous = 0;
      for (const event of events) {
        if (event.seq <= previous) {
          throw new InvalidError(
            `Imported history must be in ascending sequence order (${event.seq} came after ${previous}).`,
          );
        }
        previous = event.seq;
        insert.run(event.seq, event.ts, event.actor, event.type, JSON.stringify(event.data ?? {}));
      }
    });
  }

  /** Everything that happened, oldest first. */
  read(options: ReadOptions = {}): AnyEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const order = options.order ?? "asc";
    if (order !== "asc" && order !== "desc") {
      throw new InvalidError('order must be either "asc" or "desc".');
    }

    if (options.from !== undefined) {
      where.push("seq >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("seq <= ?");
      params.push(options.to);
    }
    if (options.types && options.types.length > 0) {
      // A misspelled or made-up type would otherwise just match nothing,
      // which looks identical to a correct filter over a quiet stretch of
      // the log — only one of those is the caller's fault, and only this
      // check can tell them apart. eventTypes() is generated from the same
      // registry `isEventType` checks against (see types.ts), so a type this
      // build does not know about is refused rather than silently ignored.
      const unknown = options.types.filter((t) => !isEventType(t));
      if (unknown.length > 0) {
        throw new InvalidError(
          `Unknown event type${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
            `Valid types: ${eventTypes().join(", ")}.`,
        );
      }
      where.push(`type IN (${options.types.map(() => "?").join(", ")})`);
      params.push(...options.types);
    }

    let sql = "SELECT seq, ts, actor, type, data FROM events";
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    // `order` is validated against two literals above rather than passed as a
    // parameter because SQL parameters cannot stand in for keywords.
    sql += ` ORDER BY seq ${order === "asc" ? "ASC" : "DESC"}`;
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 0) {
        throw new InvalidError("limit must be a whole number, zero or more.");
      }
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    return this.db
      .prepare(sql)
      .all<{ seq: number; ts: string; actor: string; type: string; data: string }>(
        ...params,
      )
      .map(rowToEvent);
  }

  /** One event by position, or undefined if the log is not that long. */
  at(seq: number): AnyEvent | undefined {
    const row = this.db
      .prepare("SELECT seq, ts, actor, type, data FROM events WHERE seq = ?")
      .get<{ seq: number; ts: string; actor: string; type: string; data: string }>(
        seq,
      );
    return row ? rowToEvent(row) : undefined;
  }

  /** The most recent sequence number, or 0 when nothing has happened yet. */
  head(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events")
      .get<{ head: number }>();
    return row?.head ?? 0;
  }

  /** How many events the room has recorded, which is also what it has spent. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Runs `fn` with the write lock held, so a read followed by an append cannot
   * be interleaved with another process doing the same thing. This is what task
   * claiming is built on.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(row: {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  data: string;
}): AnyEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    type: row.type as EventType,
    data: JSON.parse(row.data),
  } as AnyEvent;
}
