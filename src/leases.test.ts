import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import {
  acquireLease,
  currentLease,
  foldLeases,
  listLeases,
  releaseLease,
  renewLease,
} from "./leases.js";
import { ConflictError, InvalidError, LeaseError } from "./errors.js";
import type { AnyEvent, EventMap, EventType } from "./types.js";

const created: Array<{ rooms: Room[]; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-leases-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ rooms: [room], dir });
  return room;
}

/** Opens a second, independent connection onto a room already tracked for cleanup. */
function reopen(room: Room): Room {
  const entry = created.find((e) => e.rooms.includes(room));
  const again = Room.open(room.dir);
  entry?.rooms.push(again);
  return again;
}

afterEach(() => {
  while (created.length) {
    const entry = created.pop()!;
    for (const room of entry.rooms) {
      try {
        room.close();
      } catch {
        // already closed
      }
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

function worker(room: Room, name: string) {
  return room.join({ name, role: "worker" }).member;
}

describe("acquireLease / renewLease / releaseLease", () => {
  it("acquires, renews, and releases a lease", () => {
    const room = tempRoom({ config: { leaseSeconds: 300 } });
    const a = worker(room, "a");

    const lease = acquireLease(room, a.id, "draft.md");
    expect(lease.holder).toBe(a.id);
    expect(lease.path).toBe("draft.md");
    expect(currentLease(room, "draft.md")?.holder).toBe(a.id);

    const renewed = renewLease(room, a.id, "draft.md");
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(lease.expiresAt),
    );

    releaseLease(room, a.id, "draft.md");
    expect(currentLease(room, "draft.md")).toBeUndefined();

    const released = room.log.read({ types: ["lease.released"] });
    expect(released).toHaveLength(1);
    if (released[0]?.type === "lease.released") {
      expect(released[0].data.reason).toBe("voluntary");
    }
  });

  it("re-acquiring your own lease behaves like a renewal, not a failure", () => {
    const room = tempRoom();
    const a = worker(room, "a");

    acquireLease(room, a.id, "draft.md");
    const second = acquireLease(room, a.id, "draft.md");
    expect(second.holder).toBe(a.id);
    expect(currentLease(room, "draft.md")?.holder).toBe(a.id);
  });

  it("refuses a second member a lease that is still live, naming the holder", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");

    const lease = acquireLease(room, a.id, "draft.md");

    let error: unknown;
    try {
      acquireLease(room, b.id, "draft.md");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details.holder).toBe(a.id);
    expect((error as ConflictError).details.expiresAt).toBe(lease.expiresAt);
    expect((error as ConflictError).message).toContain(a.id);
  });

  it("lets a lapsed lease be taken over, and records why in the log", async () => {
    const room = tempRoom({ config: { leaseSeconds: 1 } });
    const a = worker(room, "a");
    const b = worker(room, "b");

    acquireLease(room, a.id, "draft.md");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const taken = acquireLease(room, b.id, "draft.md");
    expect(taken.holder).toBe(b.id);
    expect(currentLease(room, "draft.md")?.holder).toBe(b.id);

    const events = room.log.read({ types: ["lease.acquired", "lease.released"] });
    const expiry = events.find(
      (e) => e.type === "lease.released" && e.data.reason === "expired",
    );
    expect(expiry).toBeDefined();
    if (expiry?.type === "lease.released") {
      expect(expiry.data.memberId).toBe(a.id);
    }
    expect(expiry!.actor).toBe("system");
  });

  it("refuses to renew a lease you do not hold", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");

    acquireLease(room, a.id, "draft.md");
    expect(() => renewLease(room, b.id, "draft.md")).toThrow(LeaseError);
  });

  it("refuses to renew a lease that does not exist", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => renewLease(room, a.id, "draft.md")).toThrow(/no live lease/);
  });

  it("refuses to release somebody else's lease unless you are a human", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");
    const admin = room.join({ name: "nick", role: "human" }).member;

    acquireLease(room, a.id, "draft.md");

    expect(() => releaseLease(room, b.id, "draft.md")).toThrow(LeaseError);
    expect(currentLease(room, "draft.md")?.holder).toBe(a.id);

    releaseLease(room, admin.id, "draft.md");
    expect(currentLease(room, "draft.md")).toBeUndefined();
  });

  it("refuses to release a path that has no live lease", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => releaseLease(room, a.id, "draft.md")).toThrow(/no live lease/);
  });

  it("routes lease paths through resolveArtifact's protections", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => acquireLease(room, a.id, "../escape.txt")).toThrow(InvalidError);
    expect(() => acquireLease(room, a.id, ".atrium/log.db")).toThrow(InvalidError);
  });

  it("listLeases reports every path currently held", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "one.md");
    acquireLease(room, a.id, "two.md");
    releaseLease(room, a.id, "one.md");

    const paths = listLeases(room).map((l) => l.path);
    expect(paths).toEqual(["two.md"]);
  });
});

describe("foldLeases", () => {
  let seq = 0;
  function ev<T extends EventType>(
    type: T,
    data: EventMap[T],
    actor = "m1",
    ts = "2026-01-01T00:00:00.000Z",
  ): AnyEvent {
    return { seq: ++seq, ts, actor, type, data } as AnyEvent;
  }

  it("ignores a lease whose time has already passed", () => {
    const events = [
      ev("lease.acquired", {
        path: "draft.md",
        memberId: "m1",
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
    ];

    expect(
      foldLeases(events, "2026-01-01T00:01:00.000Z").get("draft.md")?.holder,
    ).toBe("m1");
    expect(foldLeases(events, "2026-01-01T09:00:00.000Z").get("draft.md")).toBeUndefined();
  });

  it("drops a path once it is released", () => {
    const events = [
      ev("lease.acquired", {
        path: "draft.md",
        memberId: "m1",
        expiresAt: "2026-01-01T01:00:00.000Z",
      }),
      ev("lease.released", { path: "draft.md", memberId: "m1", reason: "voluntary" }),
    ];
    expect(foldLeases(events, "2026-01-01T00:30:00.000Z").size).toBe(0);
  });
});

describe("contention across two connections", () => {
  it("lets exactly one of two independently-opened rooms win the lease", () => {
    const room1 = tempRoom({ config: { leaseSeconds: 300 } });
    const a = worker(room1, "a");
    const b = worker(room1, "b");

    // Two separate SQLite connections onto the same room directory, standing
    // in for two separate agent processes.
    const room2 = reopen(room1);

    const results = [
      run(() => acquireLease(room1, a.id, "draft.md")),
      run(() => acquireLease(room2, b.id, "draft.md")),
    ];

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.error).toBeInstanceOf(ConflictError);

    // Both connections agree on who won, because they read the same log.
    expect(currentLease(room1, "draft.md")?.holder).toBe(
      currentLease(room2, "draft.md")?.holder,
    );
  });
});

function run<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}
