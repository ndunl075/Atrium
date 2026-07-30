import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One timestamp format everywhere, so the log sorts as text. */
export function now(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** True when `iso` is in the past. Ties count as expired. */
export function hasPassed(iso: string, at: string = now()): boolean {
  return Date.parse(iso) <= Date.parse(at);
}

/** Short readable ids, e.g. `task_9f2c1a`. Unique enough for one room. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * A rough token count, good enough for holding the shared brief under a
 * ceiling. Four characters per token is the usual approximation for English
 * prose and it does not need a tokenizer dependency to be useful here.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The installed package version, read from `package.json` rather than written
 * down anywhere in the source.
 *
 * There were two copies of this number before: one the CLI read from
 * `package.json` for `--version`, and one written as a literal into the MCP
 * server's handshake, which had already drifted a release behind and would
 * have kept drifting. A version a client is told is not a place to keep a
 * second copy of a fact — the same reasoning that took the tool count out of
 * the README.
 *
 * Read once at module load: `package.json` cannot change under a running
 * process in any way this program should care about, and neither caller wants
 * to pay a file read per call.
 */
export const PACKAGE_VERSION: string = readPackageVersion();

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    // Running from somewhere the package layout does not hold — a bundler's
    // output, say. Reporting 0.0.0 is a visibly wrong number rather than a
    // plausible stale one, which is the better failure of the two.
    return "0.0.0";
  }
}

/**
 * Renames a file, retrying briefly when the filesystem says "not right now".
 *
 * Three places in this codebase write a temporary file and rename it into
 * place, which is what makes a half-written config, blob, or artifact
 * impossible: the rename either happened or it did not. That reasoning holds
 * on POSIX, where rename really is atomic and never fails because somebody
 * else is looking at the target.
 *
 * Windows is different. A file that another process has open — a virus
 * scanner mid-scan, the search indexer, an editor with the artifact on screen
 * — makes the rename fail outright with EPERM or EACCES, even though nothing
 * is wrong and the same call a moment later succeeds. It surfaced here as a
 * test failing about one run in six, always on `writeArtifact`, always
 * `EPERM: operation not permitted, rename`. In a room rather than a test it
 * would be a write refused for no reason the member could act on, and the
 * advice "try again" is exactly what this does on their behalf.
 *
 * Only the codes that mean contention are retried. ENOENT or ENOSPC are real
 * answers and are thrown immediately rather than waited on, because retrying
 * them just delays the same failure. The backoff is short and finite: about a
 * second in total, after which a rename that still cannot happen is a genuine
 * error and is reported as one.
 *
 * The wait is synchronous because the writes it protects are synchronous, and
 * making them async to accommodate a Windows quirk would change how every
 * caller in this codebase is written. That does bound what this can fix, and
 * the bound is worth stating: while it waits, nothing else in this process
 * runs, so it can never outlast a handle *this* process is holding. It wins
 * only against a holder that lets go on its own schedule — a scanner, an
 * indexer, an editor — which is the case that was actually causing failures.
 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!isContendedRenameError(err) || attempt >= RENAME_ATTEMPTS) throw err;
      sleepSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Whether a failed rename is worth trying again.
 *
 * This is the whole judgement in {@link renameWithRetry}; the loop around it
 * is deliberately thin. `EPERM`, `EACCES` and `EBUSY` are Windows saying
 * somebody else has the file open right now, which is a statement about this
 * instant and not about the request. Everything else — a missing directory, a
 * full disk, a path that crosses devices — is a real answer, and waiting a
 * second before repeating it helps nobody.
 */
export function isContendedRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Ten attempts with a linear backoff, so roughly a second before giving up. */
const RENAME_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 20;

/** A blocking sleep. `Atomics.wait` on a buffer nothing will ever notify is
 * the only way to block a synchronous function without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
