import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { deleteArtifact, writeArtifact } from "./artifacts.js";
import {
  contentAt,
  diffArtifact,
  isBinaryContent,
  listVersions,
} from "./snapshots.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(): { room: Room; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "atrium-snapshots-"));
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

/**
 * Reconstructs the "to" side of a unified diff by keeping every context and
 * added line and stripping the leading `+`/` `. Good enough to check
 * correctness for a small fixture that fits in one hunk, without pulling in
 * a patch-apply library this project has no business depending on.
 */
function applyToSide(patch: string): string {
  const lines = patch.split("\n");
  const body = lines.filter((line) => !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("@@"));
  const kept = body.filter((line) => line.startsWith(" ") || line.startsWith("+"));
  const text = kept.map((line) => line.slice(1)).join("\n");
  return text === "" ? "" : text + "\n";
}

describe("content round-trips through history", () => {
  it("reads back each version's exact bytes at its own seq", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");

    const v1 = writeArtifact(room, a.id, "draft.md", "first draft");
    const v2 = writeArtifact(room, a.id, "draft.md", "second draft, longer");
    const v3 = writeArtifact(room, a.id, "draft.md", "third and final");

    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("first draft");
    expect(contentAt(room, "draft.md", v2.seq)?.toString("utf8")).toBe("second draft, longer");
    expect(contentAt(room, "draft.md", v3.seq)?.toString("utf8")).toBe("third and final");
  });

  it("lists every version oldest first, with seq, author and size", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "v1");
    const v2 = writeArtifact(room, a.id, "draft.md", "v2!");

    const versions = listVersions(room, "draft.md");
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ seq: v1.seq, author: a.id, kind: "written", bytes: 2 });
    expect(versions[1]).toMatchObject({ seq: v2.seq, author: a.id, kind: "written", bytes: 3 });
  });

  it("returns undefined for a seq before the path ever existed", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const before = room.log.head();
    writeArtifact(room, a.id, "draft.md", "content");

    expect(contentAt(room, "draft.md", before)).toBeUndefined();
  });
});

describe("content-addressed dedup", () => {
  it("stores identical content once, even across different writes and paths", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    acquireLease(room, a.id, "copy.md");

    const first = writeArtifact(room, a.id, "draft.md", "shared content");
    writeArtifact(room, a.id, "draft.md", "different content");
    // Rewriting the same bytes back, and writing them under a different path,
    // must not create new blobs: the path on disk is a function of the hash.
    const rewritten = writeArtifact(room, a.id, "draft.md", "shared content");
    writeArtifact(room, a.id, "copy.md", "shared content");

    expect(rewritten.hash).toBe(first.hash);

    // Exactly one blob for "shared content" lives in its shard directory,
    // no matter how many times it was written or under how many paths.
    const blobDir = join(room.paths.atrium, "objects", first.hash.slice(0, 2));
    const entries = readdirSync(blobDir);
    expect(entries).toEqual([first.hash.slice(2)]);
  });

  it("does not touch the blob file's mtime on a no-op rewrite", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const info = writeArtifact(room, a.id, "draft.md", "stable content");
    const blobPath = join(room.paths.atrium, "objects", info.hash.slice(0, 2), info.hash.slice(2));
    const before = statSync(blobPath).mtimeMs;

    writeArtifact(room, a.id, "draft.md", "stable content");

    const after = statSync(blobPath).mtimeMs;
    expect(after).toBe(before);
  });
});

describe("diffArtifact", () => {
  it("reports no differences when content is unchanged", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "same");
    const v2 = writeArtifact(room, a.id, "draft.md", "same");

    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);
    expect(diff.identical).toBe(true);
    expect(diff.patch).toBe("");
  });

  it("produces a unified diff that reconstructs the newer version", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const before = "line one\nline two\nline three\n";
    const after = "line one\nline TWO\nline three\nline four\n";
    const v1 = writeArtifact(room, a.id, "draft.md", before);
    const v2 = writeArtifact(room, a.id, "draft.md", after);

    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);
    expect(diff.identical).toBe(false);
    expect(diff.binary).toBe(false);
    expect(diff.patch).toContain(`--- draft.md@${v1.seq}`);
    expect(diff.patch).toContain(`+++ draft.md@${v2.seq}`);
    expect(diff.patch).toContain("-line two");
    expect(diff.patch).toContain("+line TWO");
    expect(diff.patch).toContain("+line four");
    expect(applyToSide(diff.patch)).toBe(after);
  });

  it("handles a diff against a path that did not exist yet as an all-additions hunk", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const before = room.log.head();
    const v1 = writeArtifact(room, a.id, "draft.md", "brand new\ncontent\n");

    const diff = diffArtifact(room, "draft.md", before, v1.seq);
    expect(diff.identical).toBe(false);
    expect(diff.patch).toContain("+brand new");
    expect(diff.patch).toContain("+content");
    expect(applyToSide(diff.patch)).toBe("brand new\ncontent\n");
  });
});

describe("binary safety", () => {
  it("treats content with a NUL byte as binary", () => {
    const bytes = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    expect(isBinaryContent(bytes)).toBe(true);
  });

  it("treats invalid UTF-8 as binary even without a NUL byte", () => {
    // A lone continuation byte is not valid UTF-8 on its own.
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    expect(isBinaryContent(bytes)).toBe(true);
  });

  it("treats plain text as not binary", () => {
    expect(isBinaryContent(Buffer.from("just some text\n", "utf8"))).toBe(false);
  });

  it("reports binary artifacts as differing without attempting a line diff", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "image.dat");
    const v1 = writeArtifact(room, a.id, "image.dat", Buffer.from([0x00, 0x01, 0x02]));
    const v2 = writeArtifact(room, a.id, "image.dat", Buffer.from([0x00, 0x01, 0x03]));

    const diff = diffArtifact(room, "image.dat", v1.seq, v2.seq);
    expect(diff.binary).toBe(true);
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).not.toContain("@@");
  });
});

describe("content survives deletion", () => {
  it("still reads the version recorded right before a delete", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "last words");
    deleteArtifact(room, a.id, "draft.md");

    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("last words");

    const versions = listVersions(room, "draft.md");
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ kind: "deleted" });
  });

  it("reads as absent once the delete has happened", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "gone soon");
    deleteArtifact(room, a.id, "draft.md");

    const head = room.log.head();
    expect(contentAt(room, "draft.md", head)).toBeUndefined();
  });
});

describe("history survives a fresh Room instance", () => {
  it("reads old versions after reopening the room directory from scratch", () => {
    const { room, dir } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "version one");
    const v2 = writeArtifact(room, a.id, "draft.md", "version two");
    const roomDir = room.dir;
    room.close();

    const reopened = Room.open(roomDir);
    try {
      expect(contentAt(reopened, "draft.md", v1.seq)?.toString("utf8")).toBe("version one");
      expect(contentAt(reopened, "draft.md", v2.seq)?.toString("utf8")).toBe("version two");
      expect(listVersions(reopened, "draft.md")).toHaveLength(2);
    } finally {
      reopened.close();
      // tempRoom() already owns cleanup of `dir`; avoid a second rmSync race.
      void dir;
    }
  });
});
