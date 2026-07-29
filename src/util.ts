import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
