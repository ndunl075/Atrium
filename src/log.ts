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
  /** At most this many, taken from the start of the range. */
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

  /** Everything that happened, oldest first. */
  read(options: ReadOptions = {}): AnyEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (options.from !== undefined) {
      where.push("seq >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("seq <= ?");
      params.push(options.to);
    }
    if (options.types && options.types.length > 0) {
      where.push(`type IN (${options.types.map(() => "?").join(", ")})`);
      params.push(...options.types);
    }

    let sql = "SELECT seq, ts, actor, type, data FROM events";
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY seq ASC";
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
