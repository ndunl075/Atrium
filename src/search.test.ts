import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexRoom, searchArtifacts } from "./search.js";
import { Room } from "./room.js";

const created: Array<{ room: Room; dir: string }> = [];

function tempRoom(): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-search-"));
  const room = Room.create(join(dir, "job"));
  created.push({ room, dir });
  return room;
}

function write(room: Room, relPath: string, content: string): void {
  const abs = join(room.dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
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

describe("searchArtifacts", () => {
  it("finds a file by a word it contains", () => {
    const room = tempRoom();
    write(room, "notes.md", "the quokka is a marsupial found in western australia");
    write(room, "other.md", "nothing to do with the query at all");

    const hits = searchArtifacts(room, "quokka");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("notes.md");
    expect(hits[0]?.excerpt).toContain("quokka");
    expect(hits[0]?.bytes).toBeGreaterThan(0);
  });

  it("ranks the file that matches more often first", () => {
    const room = tempRoom();
    write(
      room,
      "strong.md",
      "widgets widgets widgets are the whole point of this document about widgets",
    );
    write(room, "weak.md", "this document mentions widgets exactly once in passing");

    const hits = searchArtifacts(room, "widgets");

    expect(hits.map((h) => h.path)).toEqual(["strong.md", "weak.md"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("returns an empty array, not an error, when nothing matches", () => {
    const room = tempRoom();
    write(room, "notes.md", "completely unrelated content");

    expect(searchArtifacts(room, "nonexistentwordxyz")).toEqual([]);
  });

  it("returns an empty array for an empty query", () => {
    const room = tempRoom();
    write(room, "notes.md", "some content");
    expect(searchArtifacts(room, "")).toEqual([]);
    expect(searchArtifacts(room, "   ")).toEqual([]);
  });

  it("returns an empty array for a punctuation-only query", () => {
    const room = tempRoom();
    write(room, "notes.md", "some content");
    expect(searchArtifacts(room, "***")).toEqual([]);
    expect(searchArtifacts(room, "()")).toEqual([]);
    expect(searchArtifacts(room, "!!!---...")).toEqual([]);
  });

  it("does not blow up on FTS5 special characters, and still finds real words in the same query", () => {
    const room = tempRoom();
    write(room, "notes.md", "hello world, this document mentions widgets");

    // Quotes, parens, asterisks, and the FTS5 boolean keywords, all thrown in
    // together the way an LLM-authored query might.
    const nasty = [
      `"unterminated quote`,
      `AND OR NOT ( * )`,
      `widgets" OR "1"="1`,
      `(widgets)`,
      `widgets*`,
      `a"b"c`,
    ];

    for (const query of nasty) {
      expect(() => searchArtifacts(room, query)).not.toThrow();
    }

    // The nastiest of them still contains the real word "widgets" and should
    // still find the file, rather than erroring out or silently matching
    // nothing because of the surrounding noise.
    expect(searchArtifacts(room, `widgets" OR "1"="1`).map((h) => h.path)).toEqual([
      "notes.md",
    ]);
  });

  it("skips .atrium, node_modules, .git, dist, oversized files, and binary files", () => {
    const room = tempRoom();
    write(room, "keep.md", "findme visible content");
    write(room, "node_modules/pkg/index.js", "findme should not be indexed");
    write(room, ".git/HEAD", "findme should not be indexed");
    write(room, "dist/bundle.js", "findme should not be indexed");
    // .atrium already holds room.json etc. from Room.create; add something
    // findable to it directly to prove it is skipped too.
    write(room, ".atrium/extra.txt", "findme should not be indexed");

    writeFileSync(join(room.dir, "huge.md"), "findme ".repeat(1000), "utf8");
    writeFileSync(join(room.dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x46]));

    const stats = indexRoom(room, { maxBytes: 100 });
    // keep.md and Room.create's own CONTEXT.md are the only files not inside a
    // skipped directory and not oversized/binary.
    expect(stats.files).toBe(2);
    expect(stats.skipped).toBeGreaterThanOrEqual(2); // huge.md and binary.bin

    const hits = searchArtifacts(room, "findme", { maxBytes: 100 });
    expect(hits.map((h) => h.path)).toEqual(["keep.md"]);
  });

  it("reports files and skipped counts via indexRoom", () => {
    const room = tempRoom();
    write(room, "a.md", "hello");
    write(room, "b.md", "world");
    writeFileSync(join(room.dir, "bin.dat"), Buffer.from([0x00, 0x11, 0x22]));

    // Room.create also wrote CONTEXT.md at the room root, so it counts too.
    const stats = indexRoom(room);
    expect(stats.files).toBe(3);
    expect(stats.skipped).toBe(1);
  });

  it("respects a limit of zero and small limits", () => {
    const room = tempRoom();
    write(room, "a.md", "findme in a");
    write(room, "b.md", "findme in b");

    expect(searchArtifacts(room, "findme", { limit: 0 })).toEqual([]);
    expect(searchArtifacts(room, "findme", { limit: 1 })).toHaveLength(1);
  });
});
