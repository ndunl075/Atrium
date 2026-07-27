import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { isRoomInternal, resolveArtifact, roomPaths, toArtifactPath } from "./paths.js";

const ROOT = resolve("/tmp/a-room");

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
