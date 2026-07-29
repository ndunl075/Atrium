import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { acquireLease, releaseLease } from "./leases.js";
import {
  artifactInfo,
  deleteArtifact,
  listArtifacts,
  listDeletedArtifacts,
  readArtifact,
  readArtifactBytes,
  writeArtifact,
} from "./artifacts.js";
import { InvalidError, LeaseError, StaleError } from "./errors.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-artifacts-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
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

describe("readArtifact", () => {
  it("reports a missing file as absent rather than throwing", () => {
    const room = tempRoom();
    const result = readArtifact(room, "notes/draft.md");
    expect(result.exists).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.seq).toBe(0);
  });

  it("reads back exactly what was written, at the seq it was written at", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const info = writeArtifact(room, a.id, "draft.md", "hello room");

    const result = readArtifact(room, "draft.md");
    expect(result.exists).toBe(true);
    expect(result.content).toBe("hello room");
    expect(result.seq).toBe(info.seq);
  });

  it("still refuses paths that escape the room or reach into .atrium", () => {
    const room = tempRoom();
    expect(() => readArtifact(room, "../escape.txt")).toThrow(InvalidError);
    expect(() => readArtifact(room, ".atrium/log.db")).toThrow(InvalidError);
  });
});

describe("writeArtifact", () => {
  it("refuses to write without a lease", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => writeArtifact(room, a.id, "draft.md", "x")).toThrow(LeaseError);
    expect(existsSync(join(room.dir, "draft.md"))).toBe(false);
  });

  it("refuses to write while somebody else holds the lease", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");
    acquireLease(room, a.id, "draft.md");
    expect(() => writeArtifact(room, b.id, "draft.md", "x")).toThrow(LeaseError);
  });

  it("creates parent directories as needed", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "nested/dir/notes.md");
    writeArtifact(room, a.id, "nested/dir/notes.md", "hi");
    expect(existsSync(join(room.dir, "nested/dir/notes.md"))).toBe(true);
  });

  it("records the byte length and sha256 of what was written", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const info = writeArtifact(room, a.id, "draft.md", "hello");

    expect(info.bytes).toBe(5);
    // sha256("hello")
    expect(info.hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(info.lastWrittenBy).toBe(a.id);
  });

  it("accepts a Uint8Array as content", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "bin.dat");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const info = writeArtifact(room, a.id, "bin.dat", bytes);
    expect(info.bytes).toBe(4);
  });

  it("leaves no partial file behind: the write is atomic", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "first version");

    writeArtifact(room, a.id, "draft.md", "second version");

    // Nothing but the final artifact is left behind: no .tmp-* leftovers from
    // the write-then-rename.
    const entries = readdirSync(room.dir).filter((e) => e.startsWith("draft.md"));
    expect(entries).toEqual(["draft.md"]);
    expect(readArtifact(room, "draft.md").content).toBe("second version");
  });

  it("allows a write with no basedOnSeq regardless of history", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v1");
    expect(() => writeArtifact(room, a.id, "draft.md", "v2")).not.toThrow();
  });

  it("refuses a stale write and accepts a current one", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    const b = worker(room, "b");

    acquireLease(room, a.id, "draft.md");
    const first = writeArtifact(room, a.id, "draft.md", "v1");
    releaseLease(room, a.id, "draft.md");

    // b reads at `first.seq`, then steps away without writing.
    acquireLease(room, b.id, "draft.md");
    const stale = readArtifact(room, "draft.md");
    expect(stale.seq).toBe(first.seq);
    releaseLease(room, b.id, "draft.md");

    // Meanwhile the artifact moves on.
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v2 by a");
    releaseLease(room, a.id, "draft.md");

    // b comes back and tries to write based on the version it read earlier.
    acquireLease(room, b.id, "draft.md");
    expect(() =>
      writeArtifact(room, b.id, "draft.md", "clobber", { basedOnSeq: stale.seq }),
    ).toThrow(StaleError);
    expect(readArtifact(room, "draft.md").content).toBe("v2 by a");

    // Reading again first gives b the current position, and writing based on
    // that succeeds.
    const current = readArtifact(room, "draft.md");
    writeArtifact(room, b.id, "draft.md", "v3 by b", { basedOnSeq: current.seq });
    expect(readArtifact(room, "draft.md").content).toBe("v3 by b");
  });

  it("treats a deletion as moving the artifact on, too", () => {
    const room = tempRoom();
    const a = worker(room, "a");

    acquireLease(room, a.id, "draft.md");
    const first = writeArtifact(room, a.id, "draft.md", "v1");
    deleteArtifact(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v2");

    expect(() =>
      writeArtifact(room, a.id, "draft.md", "clobber", { basedOnSeq: first.seq }),
    ).toThrow(StaleError);
  });

  it("still refuses paths that escape the room or reach into .atrium", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => acquireLease(room, a.id, "../escape.txt")).toThrow(InvalidError);
    expect(() => acquireLease(room, a.id, ".atrium/log.db")).toThrow(InvalidError);
    // Even with a (nonsensical) lease bypassed, writeArtifact itself checks too.
    expect(() => writeArtifact(room, a.id, "../escape.txt", "x")).toThrow(
      InvalidError,
    );
    expect(() => writeArtifact(room, a.id, ".atrium/log.db", "x")).toThrow(
      InvalidError,
    );
  });
});

describe("deleteArtifact", () => {
  it("requires a lease, same as writing", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    expect(() => deleteArtifact(room, a.id, "draft.md")).toThrow(LeaseError);
  });

  it("removes the file and records the deletion", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "gone soon");

    deleteArtifact(room, a.id, "draft.md");

    expect(existsSync(join(room.dir, "draft.md"))).toBe(false);
    expect(readArtifact(room, "draft.md").exists).toBe(false);
    expect(artifactInfo(room, "draft.md")).toBeUndefined();

    const deletions = room.log.read({ types: ["artifact.deleted"] });
    expect(deletions).toHaveLength(1);
    if (deletions[0]?.type === "artifact.deleted") {
      expect(deletions[0].data.memberId).toBe(a.id);
    }
  });
});

describe("artifactInfo / listArtifacts", () => {
  it("describes what the room knows it produced, not what happens to sit on disk", () => {
    const room = tempRoom();
    const a = worker(room, "a");

    // A file dropped in by hand, outside the artifact API, is not an artifact.
    writeFileSync(join(room.dir, "untracked.md"), "surprise");

    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "tracked");

    const infos = listArtifacts(room);
    expect(infos.map((i) => i.path)).toEqual(["draft.md"]);
    expect(artifactInfo(room, "untracked.md")).toBeUndefined();
    expect(artifactInfo(room, "draft.md")?.path).toBe("draft.md");
  });

  it("drops a path from listArtifacts once it is deleted", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "one.md");
    writeArtifact(room, a.id, "one.md", "1");
    acquireLease(room, a.id, "two.md");
    writeArtifact(room, a.id, "two.md", "2");

    deleteArtifact(room, a.id, "one.md");

    expect(listArtifacts(room).map((i) => i.path)).toEqual(["two.md"]);
  });
});

describe("listDeletedArtifacts", () => {
  it("keeps a deleted path out of listArtifacts, and reports who deleted it and when instead", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "one.md");
    writeArtifact(room, a.id, "one.md", "1");
    acquireLease(room, a.id, "two.md");
    writeArtifact(room, a.id, "two.md", "2");

    deleteArtifact(room, a.id, "one.md");

    // The two lists never overlap: a live artifact and a tombstone are never
    // the same entry seen from two angles.
    expect(listArtifacts(room).map((i) => i.path)).toEqual(["two.md"]);

    const deleted = listDeletedArtifacts(room);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.path).toBe("one.md");
    expect(deleted[0]?.deletedBy).toBe(a.id);
    expect(deleted[0]?.deletedAt).toBeTruthy();
  });

  it("is empty when nothing has ever been deleted", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "hi");

    expect(listDeletedArtifacts(room)).toEqual([]);
  });

  it("re-lists a path once it is written again after being deleted", () => {
    const room = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v1");
    deleteArtifact(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "v2");

    expect(listArtifacts(room).map((i) => i.path)).toEqual(["draft.md"]);
    expect(listDeletedArtifacts(room)).toEqual([]);
  });
});

describe("binary artifacts", () => {
  it("gives back the exact bytes that were written", () => {
    const room = tempRoom();
    const worker = room.join({ name: "w1", role: "worker" }).member;
    acquireLease(room, worker.id, "logo.png");

    // Bytes that are not valid UTF-8, which is what a real image looks like.
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80,
    ]);
    writeArtifact(room, worker.id, "logo.png", original);

    const read = readArtifactBytes(room, "logo.png");
    expect(read.exists).toBe(true);
    expect(Buffer.compare(read.content!, original)).toBe(0);

    // Reading the same file as text mangles it, which is why the byte-wise
    // read exists at all.
    const asText = readArtifact(room, "logo.png");
    expect(Buffer.from(asText.content!, "utf8").length).not.toBe(original.length);
  });

  it("reports a missing binary file rather than throwing", () => {
    const room = tempRoom();
    const read = readArtifactBytes(room, "nothing-here.bin");
    expect(read.exists).toBe(false);
    expect(read.content).toBeUndefined();
    expect(read.seq).toBe(0);
  });
});
