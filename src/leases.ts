/**
 * Leases: the answer to two agents editing the same artifact at once.
 *
 * Writing a path requires holding a lease on it. A lease is granted for
 * `room.config.leaseSeconds` and is renewable, so a live worker can keep
 * holding a path indefinitely by renewing before it runs out. Nothing sweeps
 * lapsed leases in the background — the fold below simply stops counting them
 * as held, and the next `acquireLease` call is what actually notices and
 * records the handoff. That is deliberate: a crashed agent must not deadlock
 * the room, and no daemon has to be running for that to be true.
 *
 * As with the task board, folding is kept separate from the mutating calls so
 * that "what is the state of this path" can never disagree between the two.
 */

import { resolveArtifact, toArtifactPath } from "./paths.js";
import { Room } from "./room.js";
import { ConflictError, LeaseError } from "./errors.js";
import type { AnyEvent, EventType, Lease, MemberId } from "./types.js";
import { addSeconds, hasPassed, now } from "./util.js";

const LEASE_EVENT_TYPES: EventType[] = [
  "lease.acquired",
  "lease.renewed",
  "lease.released",
];

/**
 * Replays lease history into the current holder of each path.
 *
 * Leases whose `expiresAt` has already passed are left out of the result:
 * that is the whole point of a lease being time-limited rather than a lock,
 * and it means callers never have to remember to check the clock themselves.
 */
export function foldLeases(
  events: AnyEvent[],
  at: string = now(),
): Map<string, Lease> {
  const leases = rawFoldLeases(events);
  for (const [path, lease] of leases) {
    if (hasPassed(lease.expiresAt, at)) leases.delete(path);
  }
  return leases;
}

/** Same as {@link foldLeases}, but keeps lapsed leases so callers here can
 * tell "nobody has ever leased this" apart from "somebody's lease ran out". */
function rawFoldLeases(events: AnyEvent[]): Map<string, Lease> {
  const leases = new Map<string, Lease>();

  for (const event of events) {
    switch (event.type) {
      case "lease.acquired": {
        leases.set(event.data.path, {
          path: event.data.path,
          holder: event.data.memberId,
          acquiredAt: event.ts,
          expiresAt: event.data.expiresAt,
          seq: event.seq,
        });
        break;
      }

      case "lease.renewed": {
        const lease = leases.get(event.data.path);
        if (!lease) break;
        leases.set(event.data.path, {
          ...lease,
          holder: event.data.memberId,
          expiresAt: event.data.expiresAt,
          seq: event.seq,
        });
        break;
      }

      case "lease.released": {
        leases.delete(event.data.path);
        break;
      }

      default:
        break;
    }
  }

  return leases;
}

function readLeaseEvents(room: Room): AnyEvent[] {
  return room.log.read({ types: LEASE_EVENT_TYPES });
}

function normalize(room: Room, path: string): string {
  return toArtifactPath(room.dir, resolveArtifact(room.dir, path));
}

/** The live lease on a path, if anybody currently holds one. */
export function currentLease(
  room: Room,
  path: string,
  at?: string,
): Lease | undefined {
  return foldLeases(readLeaseEvents(room), at).get(normalize(room, path));
}

/** Every path with a live lease right now. */
export function listLeases(room: Room): Lease[] {
  return [...foldLeases(readLeaseEvents(room)).values()];
}

/**
 * Takes a lease on `path` for `actorId`.
 *
 * Fails with `ConflictError` if somebody else holds a live lease on the path.
 * If that lease has lapsed, the acquisition succeeds anyway and a
 * `lease.released` event with reason `"expired"` is recorded for the old
 * holder in the same transaction, so the log explains the handoff rather than
 * just showing a new holder appear out of nowhere. Re-acquiring a lease you
 * already hold succeeds and simply extends it, the same as a renewal.
 */
export function acquireLease(room: Room, actorId: MemberId, path: string): Lease {
  room.assertUsable();
  room.member(actorId);
  const relPath = normalize(room, path);

  return room.log.transaction(() => {
    const at = now();
    const existing = rawFoldLeases(readLeaseEvents(room)).get(relPath);
    const lapsed = existing !== undefined && hasPassed(existing.expiresAt, at);

    if (existing && existing.holder !== actorId && !lapsed) {
      throw new ConflictError(
        `${relPath} is leased by ${existing.holder} until ${existing.expiresAt}. ` +
          "Wait for it to lapse or ask the holder to release it.",
        { path: relPath, holder: existing.holder, expiresAt: existing.expiresAt },
      );
    }

    if (existing && existing.holder !== actorId && lapsed) {
      room.log.append("system", "lease.released", {
        path: relPath,
        memberId: existing.holder,
        reason: "expired",
      });
    }

    const expiresAt = addSeconds(at, room.config.leaseSeconds);
    const event = room.log.append(actorId, "lease.acquired", {
      path: relPath,
      memberId: actorId,
      expiresAt,
    });

    return {
      path: relPath,
      holder: actorId,
      acquiredAt: event.ts,
      expiresAt,
      seq: event.seq,
    };
  });
}

/** Extends a lease `actorId` already holds. Anybody else gets `LeaseError`. */
export function renewLease(room: Room, actorId: MemberId, path: string): Lease {
  room.assertUsable();
  room.member(actorId);
  const relPath = normalize(room, path);

  return room.log.transaction(() => {
    const at = now();
    const existing = foldLeases(readLeaseEvents(room), at).get(relPath);

    if (!existing) {
      throw new LeaseError(
        `There is no live lease on ${relPath} to renew. Acquire one first.`,
        { path: relPath },
      );
    }
    if (existing.holder !== actorId) {
      throw new LeaseError(
        `${relPath} is leased by ${existing.holder}, not you. Only the holder can renew it.`,
        { path: relPath, holder: existing.holder },
      );
    }

    const expiresAt = addSeconds(at, room.config.leaseSeconds);
    const event = room.log.append(actorId, "lease.renewed", {
      path: relPath,
      memberId: actorId,
      expiresAt,
    });

    return { ...existing, expiresAt, seq: event.seq };
  });
}

/**
 * Gives up a lease early. The holder can always do this. A `human` member can
 * also release somebody else's lease, since humans administer the room and
 * are the escape hatch when a worker is stuck holding a path it should not be.
 */
export function releaseLease(
  room: Room,
  actorId: MemberId,
  path: string,
  reason: "voluntary" | "expired" = "voluntary",
): void {
  room.assertUsable();
  const actor = room.member(actorId);
  const relPath = normalize(room, path);

  room.log.transaction(() => {
    const existing = foldLeases(readLeaseEvents(room)).get(relPath);

    if (!existing) {
      throw new LeaseError(`There is no live lease on ${relPath} to release.`, {
        path: relPath,
      });
    }
    if (existing.holder !== actorId && actor.role !== "human") {
      throw new LeaseError(
        `${relPath} is leased by ${existing.holder}, not you. Only the holder or a human can release it.`,
        { path: relPath, holder: existing.holder },
      );
    }

    room.log.append(actorId, "lease.released", {
      path: relPath,
      memberId: existing.holder,
      reason,
    });
  });
}
