import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog } from "./log.js";

function tempLog(): { log: EventLog; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atrium-log-"));
  const log = EventLog.open(join(dir, "log.db"));
  return {
    log,
    cleanup: () => {
      log.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("EventLog", () => {
  it("numbers events from one, in order, with no gaps", () => {
    const { log, cleanup } = tempLog();
    try {
      const a = log.append("system", "room.created", { roomId: "r1", name: "x" });
      const b = log.append("m1", "note.posted", { memberId: "m1", text: "hi" });

      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(log.head()).toBe(2);
      expect(log.count()).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("gives back exactly what was put in", () => {
    const { log, cleanup } = tempLog();
    try {
      log.append("m1", "task.created", {
        taskId: "t1",
        title: "Write the draft",
        description: "800 words",
        dependsOn: ["t0"],
        acceptance: { kind: "reviewer" },
      });

      const [event] = log.read();
      expect(event?.type).toBe("task.created");
      expect(event?.actor).toBe("m1");
      if (event?.type === "task.created") {
        expect(event.data.title).toBe("Write the draft");
        expect(event.data.dependsOn).toEqual(["t0"]);
        expect(event.data.acceptance).toEqual({ kind: "reviewer" });
      }
    } finally {
      cleanup();
    }
  });

  it("filters by range and by type", () => {
    const { log, cleanup } = tempLog();
    try {
      log.append("m1", "note.posted", { memberId: "m1", text: "one" });
      log.append("m1", "task.created", {
        taskId: "t1",
        title: "t",
        description: "",
        dependsOn: [],
        acceptance: { kind: "none" },
      });
      log.append("m1", "note.posted", { memberId: "m1", text: "two" });

      expect(log.read({ types: ["note.posted"] })).toHaveLength(2);
      expect(log.read({ from: 2 })).toHaveLength(2);
      expect(log.read({ to: 1 })).toHaveLength(1);
      expect(log.read({ limit: 2 })).toHaveLength(2);
      expect(log.read({ from: 2, to: 2 })[0]?.type).toBe("task.created");
    } finally {
      cleanup();
    }
  });

  it("can read the newest events first without loading and reversing the whole log", () => {
    const { log, cleanup } = tempLog();
    try {
      for (const text of ["one", "two", "three", "four", "five"]) {
        log.append("m1", "note.posted", { memberId: "m1", text });
      }

      expect(log.read({ order: "desc", limit: 3 }).map((event) => event.seq)).toEqual([
        5, 4, 3,
      ]);
      // Existing callers keep their oldest-first behavior.
      expect(log.read({ limit: 3 }).map((event) => event.seq)).toEqual([1, 2, 3]);
    } finally {
      cleanup();
    }
  });

  it("applies range and type filters before taking newest-first results", () => {
    const { log, cleanup } = tempLog();
    try {
      log.append("m1", "note.posted", { memberId: "m1", text: "one" });
      log.append("m1", "task.created", {
        taskId: "t1",
        title: "task",
        description: "",
        dependsOn: [],
        acceptance: { kind: "none" },
      });
      log.append("m1", "note.posted", { memberId: "m1", text: "three" });
      log.append("m1", "note.posted", { memberId: "m1", text: "four" });

      const events = log.read({
        from: 2,
        to: 4,
        types: ["note.posted"],
        order: "desc",
        limit: 1,
      });

      expect(events.map((event) => event.seq)).toEqual([4]);
    } finally {
      cleanup();
    }
  });

  it("refuses an unknown order instead of silently choosing one", () => {
    const { log, cleanup } = tempLog();
    try {
      expect(() => log.read({ order: "sideways" as never })).toThrow(
        /either "asc" or "desc"/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses an unknown event type instead of quietly matching nothing", () => {
    const { log, cleanup } = tempLog();
    try {
      log.append("m1", "note.posted", { memberId: "m1", text: "one" });

      expect(() => log.read({ types: ["note.posetd" as never] })).toThrow(
        /Unknown event type/,
      );
      // The whole point: a caller who cannot see the source should still be
      // able to find out what would have worked.
      expect(() => log.read({ types: ["note.posetd" as never] })).toThrow(
        /note\.posted/,
      );
    } finally {
      cleanup();
    }
  });

  it("writes a batch all at once or not at all", () => {
    const { log, cleanup } = tempLog();
    try {
      const written = log.appendMany([
        { actor: "m1", type: "note.posted", data: { memberId: "m1", text: "a" } },
        { actor: "m1", type: "note.posted", data: { memberId: "m1", text: "b" } },
      ]);
      expect(written.map((e) => e.seq)).toEqual([1, 2]);
    } finally {
      cleanup();
    }
  });

  it("keeps nothing from a transaction that throws", () => {
    const { log, cleanup } = tempLog();
    try {
      expect(() =>
        log.transaction(() => {
          log.append("m1", "note.posted", { memberId: "m1", text: "doomed" });
          throw new Error("changed my mind");
        }),
      ).toThrow("changed my mind");

      expect(log.count()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("refuses to let recorded events be changed or removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-log-"));
    const dbPath = join(dir, "log.db");
    const log = EventLog.open(dbPath);
    try {
      log.append("m1", "note.posted", { memberId: "m1", text: "written down" });

      // Reach past the API to prove the rule holds at the storage layer.
      const raw = (log as unknown as { db: { exec(sql: string): void } })["db"];
      expect(() => raw.exec("UPDATE events SET actor = 'someone-else'")).toThrow(
        /append-only/,
      );
      expect(() => raw.exec("DELETE FROM events")).toThrow(/append-only/);

      expect(log.count()).toBe(1);
    } finally {
      log.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens where it left off", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-log-"));
    const dbPath = join(dir, "log.db");
    try {
      const first = EventLog.open(dbPath);
      first.append("m1", "note.posted", { memberId: "m1", text: "before" });
      first.close();

      const second = EventLog.open(dbPath);
      expect(second.head()).toBe(1);
      const next = second.append("m1", "note.posted", {
        memberId: "m1",
        text: "after",
      });
      expect(next.seq).toBe(2);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
