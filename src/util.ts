import { createHash, randomBytes, randomUUID } from "node:crypto";

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
