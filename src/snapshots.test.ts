import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { deleteArtifact, writeArtifact } from "./artifacts.js";
import {
  contentAt,
  contentStateAt,
  diffArtifact,
  gcBlobs,
  isBinaryContent,
  listVersions,
  loadBlob,
  pruneVersions,
  storeBlob,
} from "./snapshots.js";
import { sha256 } from "./util.js";

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

describe("trailing newlines", () => {
  it("reports a difference of only the final newline, with git's marker", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one\ntwo\n");
    const v2 = writeArtifact(room, a.id, "draft.md", "one\ntwo");

    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);

    expect(diff.identical).toBe(false);
    // The bytes differ, so an empty patch would be the diff contradicting
    // itself. The change is on the "to" side, which is the one missing it.
    expect(diff.patch).not.toBe("");
    expect(diff.patch).toContain("-two\n+two\n\\ No newline at end of file");
  });

  it("marks the from side when the newline is the thing being added", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one\ntwo");
    const v2 = writeArtifact(room, a.id, "draft.md", "one\ntwo\n");

    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);

    expect(diff.patch).toContain("-two\n\\ No newline at end of file\n+two");
  });

  it("counts the marker outside the hunk's line counts, as git does", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one\ntwo\n");
    const v2 = writeArtifact(room, a.id, "draft.md", "one\ntwo");

    expect(diffArtifact(room, "draft.md", v1.seq, v2.seq).patch).toContain("@@ -1,2 +1,2 @@");
  });

  it("still reports identical when the bytes really are identical", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one\ntwo");
    const v2 = writeArtifact(room, a.id, "draft.md", "one\ntwo");

    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);
    expect(diff.identical).toBe(true);
    expect(diff.patch).toBe("");
  });
});

describe("diffing large artifacts", () => {
  it("diffs a one-line edit in a big file without building a table over it", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "big.txt");

    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const v1 = writeArtifact(room, a.id, "big.txt", lines.join("\n") + "\n");
    lines[10_000] = "line 10000, edited";
    const v2 = writeArtifact(room, a.id, "big.txt", lines.join("\n") + "\n");

    // 20k x 20k is 400M cells, far past the budget. Trimming the common head
    // and tail leaves a single changed line, so this is both minimal and
    // cheap rather than falling back to a coarse patch.
    const diff = diffArtifact(room, "big.txt", v1.seq, v2.seq);

    expect(diff.patch).toContain("-line 10000\n+line 10000, edited");
    expect(diff.patch).toContain("@@ -9998,7 +9998,7 @@");
    expect(diff.patch.split("\n").length).toBeLessThan(15);
  });

  it("falls back to a whole-region replacement rather than allocating past the budget", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "big.txt");

    // Nothing in common, so head/tail trimming saves nothing and the table
    // would be ~9M cells: over the budget, and the coarse patch is used.
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join("\n") + "\n";
    const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join("\n") + "\n";
    const v1 = writeArtifact(room, a.id, "big.txt", before);
    const v2 = writeArtifact(room, a.id, "big.txt", after);

    const diff = diffArtifact(room, "big.txt", v1.seq, v2.seq);

    expect(diff.identical).toBe(false);
    // Coarse, but still a correct unified diff: it reconstructs the new file.
    expect(applyToSide(diff.patch)).toBe(after);
    expect(diff.patch).toContain("@@ -1,3000 +1,3000 @@");
  });
});

describe("gcBlobs", () => {
  // Joining a room records its brief (see recordBrief in context.ts), which
  // puts one blob in the store that no artifact event refers to. It is
  // referenced — by `context.written` — so gc keeps it, and every count in
  // this block includes it. Forgetting that is how a sweep would come to
  // delete every recorded version of a room's brief.
  const BRIEF_BLOB = 1;

  it("keeps every blob the log still points at, including superseded ones", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "version one");
    writeArtifact(room, a.id, "draft.md", "version two");

    const result = gcBlobs(room);

    expect(result.removed).toBe(0);
    expect(result.kept).toBe(2 + BRIEF_BLOB);
    // The point of keeping it: an old version is still readable afterwards.
    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("version one");
  });

  it("keeps the brief's blob, which no artifact event refers to", () => {
    const { room } = tempRoom();
    worker(room, "a");

    // Nothing has been written as an artifact at all, so an artifact-only
    // sweep would find this blob unreferenced and reclaim the room's brief.
    expect(gcBlobs(room, { dryRun: true }).removed).toBe(0);
    expect(gcBlobs(room, { dryRun: true }).kept).toBe(BRIEF_BLOB);
  });

  it("removes content stored by a write that never recorded its event", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "kept");

    // What writeArtifact leaves behind when it dies between storing the bytes
    // and appending the event that would have referred to them.
    const orphan = Buffer.from("nobody refers to this", "utf8");
    const orphanHash = sha256(orphan);
    storeBlob(room, orphanHash, orphan);
    expect(loadBlob(room, orphanHash)).toBeDefined();

    const result = gcBlobs(room);

    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1 + BRIEF_BLOB);
    expect(result.bytesReclaimed).toBe(orphan.length);
    expect(loadBlob(room, orphanHash)).toBeUndefined();
    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("kept");
  });

  it("sweeps temporary files left by a write that died before the rename", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "kept");

    const shard = join(room.paths.atrium, "objects", "ab");
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, "cdef.tmp-123-456"), "half-written");

    const result = gcBlobs(room);

    expect(result.paths).toEqual(["ab/cdef.tmp-123-456"]);
    expect(result.kept).toBe(1 + BRIEF_BLOB);
  });

  it("reports without removing anything on a dry run", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "kept");

    const orphan = Buffer.from("orphan", "utf8");
    const orphanHash = sha256(orphan);
    storeBlob(room, orphanHash, orphan);

    const result = gcBlobs(room, { dryRun: true });

    expect(result.removed).toBe(1);
    expect(loadBlob(room, orphanHash)).toBeDefined();
  });

  it("is a no-op on a room that has never written an artifact", () => {
    const { room } = tempRoom();
    expect(gcBlobs(room)).toEqual({ kept: 0, removed: 0, bytesReclaimed: 0, paths: [] });
  });
});

describe("pruneVersions", () => {
  it("keeps the most recent N versions of each path and drops the rest", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    const v2 = writeArtifact(room, a.id, "draft.md", "two");
    const v3 = writeArtifact(room, a.id, "draft.md", "three");

    const result = pruneVersions(room, { retain: 1 });

    expect(result.droppedVersions).toBe(2);
    expect(result.plans[0]?.seqs).toEqual([v1.seq, v2.seq]);
    expect(contentAt(room, "draft.md", v3.seq)?.toString("utf8")).toBe("three");
    // The versions themselves are still on record; only their bytes went.
    expect(listVersions(room, "draft.md")).toHaveLength(3);
  });

  it("will not drop a blob a retained version of another path still points at", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    acquireLease(room, a.id, "copy.md");

    const shared = writeArtifact(room, a.id, "draft.md", "shared text");
    writeArtifact(room, a.id, "draft.md", "moved on");
    // Same bytes, so content-addressing gives both paths the same blob. This
    // one is the only version of copy.md, so retain: 1 keeps it — and with it
    // the blob that draft.md's droppable first version also points at.
    writeArtifact(room, a.id, "copy.md", "shared text");

    const result = pruneVersions(room, { retain: 1 });

    // Nothing was dropped for draft.md: its old version's content is still
    // live via copy.md, so it stays readable and is not reported as pruned.
    expect(result.droppedVersions).toBe(0);
    expect(contentAt(room, "draft.md", shared.seq)?.toString("utf8")).toBe("shared text");
  });

  it("reports a version whose content is gone as pruned, not as absent", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    writeArtifact(room, a.id, "draft.md", "two");

    pruneVersions(room, { retain: 1 });

    const found = contentStateAt(room, "draft.md", v1.seq);
    // "absent" would mean the path did not exist then, which is a different
    // and false claim: it existed, and was written by a member.
    expect(found.state).toBe("pruned");
    if (found.state === "pruned") expect(found.bytes).toBe(3);
    // A seq before the path was ever written is the genuinely absent case.
    expect(contentStateAt(room, "draft.md", 1).state).toBe("absent");
  });

  it("records what it dropped in the log", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    writeArtifact(room, a.id, "draft.md", "one");
    writeArtifact(room, a.id, "draft.md", "two");

    pruneVersions(room, { retain: 1 });

    const [event] = room.log.read({ types: ["artifact.pruned"] });
    expect(event?.type).toBe("artifact.pruned");
    if (event?.type === "artifact.pruned") {
      expect(event.data.path).toBe("draft.md");
      expect(event.data.retained).toBe(1);
      expect(event.data.seqs).toHaveLength(1);
    }
  });

  it("changes nothing on a dry run", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    writeArtifact(room, a.id, "draft.md", "two");

    const result = pruneVersions(room, { retain: 1, dryRun: true });

    expect(result.droppedVersions).toBe(1);
    expect(contentAt(room, "draft.md", v1.seq)?.toString("utf8")).toBe("one");
    expect(room.log.read({ types: ["artifact.pruned"] })).toHaveLength(0);
  });

  it("refuses a retention that would leave a path with no content at all", () => {
    const { room } = tempRoom();
    expect(() => pruneVersions(room, { retain: 0 })).toThrow(/1 or more/);
  });
});

describe("diffing against pruned content", () => {
  it("refuses to diff rather than treating the missing side as an empty file", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one\ntwo\n");
    const v2 = writeArtifact(room, a.id, "draft.md", "one\nTWO\n");

    pruneVersions(room, { retain: 1 });
    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);

    expect(diff.pruned).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.patch).toMatch(/no longer retained/);
    // The lie this replaces: every line of the old version shown as an
    // addition against nothing.
    expect(diff.patch).not.toContain("+one");
  });

  it("does not call two versions identical just because neither can be read", () => {
    const { room } = tempRoom();
    const a = worker(room, "a");
    acquireLease(room, a.id, "draft.md");
    const v1 = writeArtifact(room, a.id, "draft.md", "one");
    const v2 = writeArtifact(room, a.id, "draft.md", "two");
    writeArtifact(room, a.id, "draft.md", "three");

    pruneVersions(room, { retain: 1 });
    const diff = diffArtifact(room, "draft.md", v1.seq, v2.seq);

    expect(diff.identical).toBe(false);
    expect(diff.pruned).toBe(true);
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
