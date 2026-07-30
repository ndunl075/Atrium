import { describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isContendedRenameError, renameWithRetry } from "./util.js";

describe("isContendedRenameError", () => {
  // This predicate is the entire judgement in renameWithRetry — which failures
  // are worth waiting on and which are real answers — so it is tested directly
  // rather than through a mocked filesystem. The loop wrapped around it is
  // eight lines with nothing to hide.
  it("treats the codes Windows uses for an open file as worth retrying", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const err = new Error(`${code}: whatever`) as NodeJS.ErrnoException;
      err.code = code;
      expect(isContendedRenameError(err)).toBe(true);
    }
  });

  it("treats a real answer as a real answer, so it is not waited on", () => {
    // Retrying any of these just repeats the same failure a second later.
    for (const code of ["ENOENT", "ENOSPC", "EXDEV", "EISDIR"]) {
      const err = new Error(`${code}: whatever`) as NodeJS.ErrnoException;
      err.code = code;
      expect(isContendedRenameError(err)).toBe(false);
    }
  });

  it("does not mistake something that is not an errno for contention", () => {
    expect(isContendedRenameError(new Error("plain"))).toBe(false);
    expect(isContendedRenameError(undefined)).toBe(false);
    expect(isContendedRenameError(null)).toBe(false);
    expect(isContendedRenameError("EPERM")).toBe(false);
  });
});

describe("renameWithRetry", () => {
  it("renames a file when nothing is in the way", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-rename-"));
    try {
      const from = join(dir, "tmp");
      const to = join(dir, "final");
      writeFileSync(from, "content");

      renameWithRetry(from, to);

      expect(readFileSync(to, "utf8")).toBe("content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing target, which is what write-then-rename needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-rename-"));
    try {
      const from = join(dir, "tmp");
      const to = join(dir, "final");
      writeFileSync(to, "old");
      writeFileSync(from, "new");

      renameWithRetry(from, to);

      expect(readFileSync(to, "utf8")).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a rename that cannot work rather than waiting first", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-rename-"));
    try {
      // Nothing at the source: an answer, not contention, so it comes straight
      // back instead of spending a second on pointless backoff.
      const started = Date.now();
      expect(() => renameWithRetry(join(dir, "missing"), join(dir, "final"))).toThrow();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot outwait a handle this same process is holding, and says so by failing", () => {
    // Worth pinning down because it is the limit of the fix, not a bug in it.
    // The retry is synchronous — it has to be, since every caller is — so
    // while it waits, nothing else in this process runs, including whatever
    // would have closed the handle. It can only win against a holder that
    // releases on its own wall-clock schedule, which is exactly the case it
    // was written for: a virus scanner or indexer in another process.
    //
    // On POSIX an open handle does not block a rename at all, so there the
    // call simply succeeds. Both outcomes are correct; asserting one of them
    // everywhere would be asserting something untrue on the other platform.
    const dir = mkdtempSync(join(tmpdir(), "atrium-rename-"));
    let held: number | undefined;
    try {
      const from = join(dir, "tmp");
      const to = join(dir, "final");
      writeFileSync(to, "old");
      writeFileSync(from, "new");
      held = openSync(to, "r");

      let threw = false;
      try {
        renameWithRetry(from, to);
      } catch {
        threw = true;
      }

      if (process.platform === "win32") {
        expect(threw).toBe(true);
      } else {
        expect(threw).toBe(false);
        expect(readFileSync(to, "utf8")).toBe("new");
      }
    } finally {
      if (held !== undefined) closeSync(held);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
