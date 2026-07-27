/**
 * Failures an agent is expected to handle, rather than crash on.
 *
 * Each one carries a stable `code` so an MCP client can branch on it without
 * matching on message text.
 */

export type ErrorCode =
  /** Somebody else got there first. Re-read and try again. */
  | "conflict"
  /** The work was based on a version that has since moved on. */
  | "stale"
  /** Writing without holding the lease, or holding somebody else's. */
  | "lease"
  /** No such room, task, member, or file. */
  | "not_found"
  /** The caller is not allowed to do this. */
  | "permission"
  /** The request itself does not make sense. */
  | "invalid"
  /** The room has spent its budget and stopped. */
  | "halted";

export class AtriumError extends Error {
  readonly code: ErrorCode;
  /** Anything useful for fixing the call, e.g. the current lease holder. */
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Two members went for the same thing and this one lost. */
export class ConflictError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("conflict", message, details);
  }
}

/** The room moved on while the caller was working. */
export class StaleError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("stale", message, details);
  }
}

/** A write needs a lease on the path, held by the caller, still in date. */
export class LeaseError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("lease", message, details);
  }
}

export class NotFoundError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
  }
}

/** Includes the big one: nobody signs off their own work. */
export class PermissionError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("permission", message, details);
  }
}

export class InvalidError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("invalid", message, details);
  }
}

/** The room hit its action budget and will not do any more work. */
export class HaltedError extends AtriumError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("halted", message, details);
  }
}

export function isAtriumError(err: unknown): err is AtriumError {
  return err instanceof AtriumError;
}
