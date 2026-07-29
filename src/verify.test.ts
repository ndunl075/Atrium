import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { writeArtifact } from "./artifacts.js";
import { pruneVersions, storeBlob } from "./snapshots.js";
import { sha256 } from "./util.js";
import { verifyRoom } from "./verify.js";
import { cmdVerify, type Sink } from "./cli.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(): { room: Room; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "atrium-verify-"));
  const room = Room.create(join(dir, "job"));
  created.push({ room, dir });
  return { room, dir };
}

afterEach(() => {
  while (created.length) {
    const entry = created.pop()!;
    try {
      entry.room.close();
    } catch {
      // already closed
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

function worker(room: Room, name: string) {
  return room.join({ name, role: "worker" }).member;
}

/** Where a blob for `hash` lives on disk, mirroring snapshots.ts's own
 * fan-out layout, so a test can reach in and tamper with it directly without
 * going through any atrium API — which is the whole point of these tests:
 * simulating damage that no atrium command would ever cause on its own. */
function blobFile(room: Room, hash: string): string {
  return join(room.paths.atrium, "objects", hash.slice(0, 2), hash.slice(2));
}

function sink(): Sink & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

describe("a healthy room", () => {
  it("reports healthy with no findings worth attention", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "hello");
    acquireLease(room, a.id, "notes.md");
    writeArtifact(room, a.id, "notes.md", "more content");

    const report = verifyRoom(room);

    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.artifactWrites).toBe(2);
  });

  it("is healthy on a brand-new room that has never written anything", () => {
    const { room } = tempRoom();
    const report = verifyRoom(room);
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

describe("a room after a legitimate prune", () => {
  it("still reports healthy — this is the whole point of the distinction", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    const v2 = writeArtifact(room, a.id, "draft.md", "two");
    const v3 = writeArtifact(room, a.id, "draft.md", "three");
    void v1;
    void v2;

    const pruned = pruneVersions(room, { retain: 1 });
    expect(pruned.droppedVersions).toBe(2); // sanity: the prune actually did something

    const report = verifyRoom(room);

    // A pruned version is not damage. A verify command that flagged this
    // would be worse than useless — it would train whoever runs it to
    // ignore the output entirely.
    expect(report.healthy).toBe(true);
    expect(report.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(contentStillReadable(room, v3.hash)).toBe(true);
  });

  it("still reports healthy when a shared blob keeps an old version's bytes readable", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    acquireLease(room, a.id, "copy.md");

    writeArtifact(room, a.id, "draft.md", "shared text");
    writeArtifact(room, a.id, "draft.md", "moved on");
    // Same bytes as draft.md's first version. copy.md's only version keeps
    // that blob alive even after pruning draft.md, so nothing is actually
    // dropped — pruneVersions itself does not report this as pruned either.
    writeArtifact(room, a.id, "copy.md", "shared text");

    pruneVersions(room, { retain: 1 });

    const report = verifyRoom(room);
    expect(report.healthy).toBe(true);
  });
});

function contentStillReadable(room: Room, hash: string | undefined): boolean {
  if (!hash) return false;
  try {
    statSync(blobFile(room, hash));
    return true;
  } catch {
    return false;
  }
}

describe("a blob deleted by hand", () => {
  it("is reported as missing, not silently ignored", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "important content");

    // No atrium command did this — a person, or something else, reached
    // into the object store directly.
    rmSync(blobFile(room, v1.hash));

    const report = verifyRoom(room);

    expect(report.healthy).toBe(false);
    const finding = report.findings.find((f) => f.check === "blob-missing");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.path).toBe("draft.md");
    expect(finding?.seq).toBe(v1.seq);
  });
});

describe("a corrupted blob", () => {
  it("is caught by rehashing its bytes, which absence alone could never find", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "original content");

    // The blob is still there — this is not the missing-blob case — but its
    // bytes no longer match the hash they are filed under.
    writeFileSync(blobFile(room, v1.hash), "tampered content");

    const report = verifyRoom(room);

    expect(report.healthy).toBe(false);
    const finding = report.findings.find((f) => f.check === "blob-corrupt");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.hash).toBe(v1.hash);
    expect(finding?.message).toContain("draft.md@" + v1.seq);
  });
});

describe("an unreferenced blob", () => {
  it("is reported as reclaimable space, not as damage", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "kept");

    // What a write that died between storing bytes and appending its event
    // leaves behind — gcBlobs's own test fixture for the same idea.
    const orphan = Buffer.from("nobody refers to this", "utf8");
    const orphanHash = sha256(orphan);
    storeBlob(room, orphanHash, orphan);

    const report = verifyRoom(room);

    // Still healthy: this is exactly the garbage atrium gc exists to
    // reclaim, not evidence that anything is wrong.
    expect(report.healthy).toBe(true);
    const finding = report.findings.find((f) => f.check === "reclaimable");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(report.summary.reclaimableBlobs).toBe(1);
    expect(report.summary.reclaimableBytes).toBe(orphan.length);
  });
});

describe("cmdVerify exit code", () => {
  it("returns 0 for a healthy room and 1 for a damaged one", () => {
    const { room, dir } = tempRoom();
    const roomDir = room.dir;
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "content");

    const healthySink = sink();
    expect(cmdVerify([roomDir], healthySink)).toBe(0);
    expect(healthySink.outLines.join("\n")).toMatch(/healthy/i);

    rmSync(blobFile(room, v1.hash));

    const damagedSink = sink();
    expect(cmdVerify([roomDir], damagedSink)).toBe(1);
    expect(damagedSink.outLines.join("\n")).toMatch(/CRITICAL/);
    void dir;
  });

  it("prints machine-readable JSON with --json, matching verifyRoom's own report", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "content");

    const s = sink();
    const code = cmdVerify(["--json", room.dir], s);
    expect(code).toBe(0);

    const printed = JSON.parse(s.outLines.join("\n"));
    expect(printed.healthy).toBe(true);
    expect(printed.findings).toEqual([]);
  });
});

describe("room.json and tokens.json", () => {
  it("flags a setting whose stored type does not match RoomConfig", () => {
    const { room } = tempRoom();
    room.close();

    const raw = JSON.parse(readFileSync(room.paths.config, "utf8"));
    raw.leaseSeconds = "300"; // should be a number
    writeFileSync(room.paths.config, JSON.stringify(raw, null, 2));

    const reopened = Room.open(room.dir);
    try {
      const report = verifyRoom(reopened);
      expect(report.healthy).toBe(false);
      const finding = report.findings.find(
        (f) => f.check === "config-type" && f.message.includes("leaseSeconds"),
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("warning");
    } finally {
      reopened.close();
    }
  });

  it("flags a token granting a session to a member who never joined", () => {
    const { room } = tempRoom();
    room.close();

    const tokens = JSON.parse(readFileSync(room.paths.tokens, "utf8"));
    tokens["deadbeef".repeat(8)] = "member_doesnotexist";
    writeFileSync(room.paths.tokens, JSON.stringify(tokens, null, 2));

    const reopened = Room.open(room.dir);
    try {
      const report = verifyRoom(reopened);
      expect(report.healthy).toBe(false);
      const finding = report.findings.find((f) => f.check === "tokens-dangling");
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("warning");
      expect(finding?.message).toContain("member_doesnotexist");
    } finally {
      reopened.close();
    }
  });
});
