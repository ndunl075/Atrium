/**
 * Spend accounting: self-reported, per-member and per-room, enforced at the
 * point a member acts.
 *
 * ARCHITECTURE.md §6 marks cost runaway `[OPEN]` and says the honest thing:
 * "Atrium does not make the model calls, so it can only observe cost that
 * adapters self-report. Enforcement is therefore advisory unless agents run
 * behind a proxy." This module does not pretend to solve that. A member that
 * never calls `reportCost` is never charged for anything — there is no way
 * for Atrium to notice a model call it was not told about, and nothing here
 * changes that.
 *
 * What this does buy: a member that reports its spend gets folded into a
 * running per-member and per-room total, exactly like the task board and
 * roster are folded from the log rather than stored beside it. If a report
 * crosses either cap, the room halts through the same mechanism
 * `Room.assertUsable` already uses for the action budget (see room.ts) — a
 * `room.halted` event is appended, and every subsequent call to
 * `assertUsable()` (which every mutating action already goes through) starts
 * throwing `HaltedError`. There is deliberately no second halt flag: the
 * report that crosses the cap still lands, because the money was already
 * spent and the log is not allowed to lie about that, but nothing after it
 * gets to spend more.
 */

import { InvalidError } from "./errors.js";
import { Room } from "./room.js";
import type { AnyEvent, Event, MemberId } from "./types.js";

export interface CostReportInput {
  amountUsd: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  note?: string;
}

export interface SpendTotals {
  /** Every cost.reported amount in the room, added up. */
  room: number;
  /** The same, broken out by who reported it. */
  perMember: Record<MemberId, number>;
}

export interface MemberSpend {
  memberId: MemberId;
  name: string;
  totalUsd: number;
  /** 0 means the room has no per-member cap. */
  capUsd: number;
}

export interface CostSummary {
  roomTotalUsd: number;
  /** 0 means the room has no room-wide cap. */
  roomCapUsd: number;
  /** Only members who have reported at least one cost, highest spend first. */
  members: MemberSpend[];
}

/**
 * Folds cost.reported events into running totals. Pure and replayable, like
 * `foldTasks` and `foldLeases`: the same events always fold to the same
 * totals, whether they are read live off the room or handed in from a saved
 * slice of the log.
 */
export function foldCosts(events: AnyEvent[]): SpendTotals {
  const totals: SpendTotals = { room: 0, perMember: {} };
  for (const event of events) {
    if (event.type !== "cost.reported") continue;
    totals.room += event.data.amountUsd;
    totals.perMember[event.data.memberId] =
      (totals.perMember[event.data.memberId] ?? 0) + event.data.amountUsd;
  }
  return totals;
}

/** Current spend totals for a room, folded fresh from its log. */
export function spendTotals(room: Room): SpendTotals {
  return foldCosts(room.log.read({ types: ["cost.reported"] }));
}

/** Per-member and room totals against the room's caps, for `atrium cost` and the like. */
export function costSummary(room: Room): CostSummary {
  const totals = spendTotals(room);
  const names = new Map(room.roster().map((m) => [m.id, m.name] as const));

  const members: MemberSpend[] = Object.entries(totals.perMember)
    .map(([memberId, totalUsd]) => ({
      memberId,
      name: names.get(memberId) ?? memberId,
      totalUsd,
      capUsd: room.config.memberSpendCapUsd,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    roomTotalUsd: totals.room,
    roomCapUsd: room.config.roomSpendCapUsd,
    members,
  };
}

/**
 * Appends what a member says a model call cost. Validates the amount, then
 * checks the new totals against the room's caps — 0 or absent means no cap,
 * the same convention every other `RoomConfig` field uses. If either cap is
 * now crossed, the room halts in the same transaction as the report that
 * crossed it, so the log shows exactly which report was the one that did it.
 *
 * Deliberately does not refuse the report itself for being over cap: by the
 * time an adapter calls this, the tokens have already been billed by
 * whoever actually ran the model. Refusing to log it would just make the
 * log wrong. What gets refused is every action after it, via the room's
 * existing halt mechanism (`Room.assertUsable`, `Room.isHalted`).
 */
export function reportCost(
  room: Room,
  actorId: MemberId,
  input: CostReportInput,
): Event<"cost.reported"> {
  room.assertUsable();
  room.member(actorId); // throws NotFoundError for a bogus actor

  const amount = input.amountUsd;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new InvalidError(
      `amountUsd must be a finite number, zero or more (got ${JSON.stringify(
        input.amountUsd,
      )}).`,
      { amountUsd: input.amountUsd },
    );
  }

  return room.log.transaction(() => {
    const event = room.log.append(actorId, "cost.reported", {
      memberId: actorId,
      amountUsd: amount,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.inputTokens !== undefined
        ? { inputTokens: input.inputTokens }
        : {}),
      ...(input.outputTokens !== undefined
        ? { outputTokens: input.outputTokens }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });

    const totals = spendTotals(room);
    const roomCap = room.config.roomSpendCapUsd;
    const memberCap = room.config.memberSpendCapUsd;
    const memberTotal = totals.perMember[actorId] ?? 0;

    if (roomCap > 0 && totals.room > roomCap) {
      room.log.append("system", "room.halted", {
        reason: `Reached the room spend cap of $${roomCap.toFixed(2)} (reported so far: $${totals.room.toFixed(2)}).`,
      });
    } else if (memberCap > 0 && memberTotal > memberCap) {
      room.log.append("system", "room.halted", {
        reason: `${actorId} reached the per-member spend cap of $${memberCap.toFixed(2)} (reported so far: $${memberTotal.toFixed(2)}).`,
      });
    }

    return event;
  });
}
