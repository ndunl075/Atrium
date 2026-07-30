import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isRoomInternal, resolveArtifact, roomPaths, toArtifactPath } from "./paths.js";

const created: string[] = [];
let ROOT: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

beforeEach(() => {
  ROOT = tempDir("atrium-paths-root-");
});

afterEach(() => {
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe("resolveArtifact", () => {
  it("resolves an ordinary relative path inside the room", () => {
    expect(resolveArtifact(ROOT, "notes/draft.md")).toBe(
      resolve(ROOT, "notes/draft.md"),
    );
  });

  it("tidies up paths that are awkward but still inside", () => {
    expect(resolveArtifact(ROOT, "./notes/../notes/draft.md")).toBe(
      resolve(ROOT, "notes/draft.md"),
    );
  });

  it("refuses to climb out of the room", () => {
    expect(() => resolveArtifact(ROOT, "../secrets.txt")).toThrow(/outside the room/);
    expect(() => resolveArtifact(ROOT, "notes/../../secrets.txt")).toThrow(
      /outside the room/,
    );
  });

  it("refuses absolute paths", () => {
    expect(() => resolveArtifact(ROOT, "/etc/passwd")).toThrow(/not absolute/);
  });

  it("refuses to treat the room's own records as an artifact", () => {
    expect(() => resolveArtifact(ROOT, ".atrium/log.db")).toThrow(/not writable/);
    expect(() => resolveArtifact(ROOT, ".atrium")).toThrow(/not writable/);
  });

  it("refuses the room directory itself and empty paths", () => {
    expect(() => resolveArtifact(ROOT, ".")).toThrow(/outside the room/);
    expect(() => resolveArtifact(ROOT, "")).toThrow(/required/);
  });

  it("refuses null bytes", () => {
    expect(() => resolveArtifact(ROOT, "a\0b")).toThrow(/null bytes/);
  });

  it("requires the room root to exist before approving a path", () => {
    expect(() => resolveArtifact(join(ROOT, "not-created"), "draft.md")).toThrow(
      /root must exist/,
    );
  });

  it("refuses an existing symlink or junction that redirects outside the room", () => {
    const parent = tempDir("atrium-paths-");
    const room = join(parent, "room");
    const outside = join(parent, "outside");
    mkdirSync(room);
    mkdirSync(outside);
    directoryLink(outside, join(room, "escape"));

    expect(() => resolveArtifact(room, "escape/secret.txt")).toThrow(
      /outside the room through a symlink/,
    );
  });

  it("refuses an alias into the room's own bookkeeping directory", () => {
    const room = tempDir("atrium-paths-room-");
    mkdirSync(join(room, ".atrium"));
    directoryLink(join(room, ".atrium"), join(room, "records"));

    expect(() => resolveArtifact(room, "records/log.db")).toThrow(/not writable/);
  });

  it("allows a symlink or junction whose target stays inside the room", () => {
    const room = tempDir("atrium-paths-room-");
    const target = join(room, "shared");
    mkdirSync(target);
    directoryLink(target, join(room, "alias"));

    expect(resolveArtifact(room, "alias/draft.md")).toBe(
      resolve(room, "alias/draft.md"),
    );
  });

  it("rejects a dangling symlink instead of approving its future target", () => {
    if (process.platform === "win32") return;

    const room = tempDir("atrium-paths-room-");
    symlinkSync(join(room, "..", "not-created"), join(room, "dangling"), "dir");

    expect(() => resolveArtifact(room, "dangling/secret.txt")).toThrow(/cannot be resolved safely/);
  });
});

describe("toArtifactPath", () => {
  it("gives a room-relative path with forward slashes", () => {
    expect(toArtifactPath(ROOT, resolve(ROOT, "notes/draft.md"))).toBe(
      "notes/draft.md",
    );
  });
});

describe("isRoomInternal", () => {
  it("spots the bookkeeping directory", () => {
    expect(isRoomInternal(ROOT, resolve(ROOT, ".atrium/log.db"))).toBe(true);
    expect(isRoomInternal(ROOT, resolve(ROOT, "draft.md"))).toBe(false);
  });
});

describe("roomPaths", () => {
  it("puts the bookkeeping under .atrium and the brief at the top", () => {
    const paths = roomPaths(ROOT);
    expect(paths.db).toBe(resolve(ROOT, ".atrium/log.db"));
    expect(paths.config).toBe(resolve(ROOT, ".atrium/room.json"));
    expect(paths.context).toBe(resolve(ROOT, "CONTEXT.md"));
  });
});
