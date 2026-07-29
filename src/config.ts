/**
 * Turning `Room.updateConfig` into something a human can drive from a
 * terminal, instead of hand-editing `.atrium/room.json`.
 *
 * `updateConfig` has worked since the room shipped and nothing in this
 * codebase ever called it. Every setting that governs how a room behaves —
 * how long a lease or a claim lasts, how many times work can be rejected
 * before it freezes, how much a room is allowed to spend, whether unchecked
 * completion is allowed at all — could only be changed by opening
 * `.atrium/room.json` in an editor and hoping the value you typed was the
 * right shape. Atrium's own refusals even say to do exactly that (see
 * `context.ts`'s "raise contextTokenCeiling in .atrium/room.json"), which is
 * an admission that a command was missing, not a design choice.
 *
 * The plumbing here — read a config, write a config — is trivial;
 * `updateConfig` already does it. The actual substance is validation. A CLI
 * receives strings. `RoomConfig` is typed as booleans and numbers, but
 * nothing stops `atrium config actionBudget banana` from reaching
 * `updateConfig` unless something coerces and checks first, and a bad value
 * that slips into `room.json` is a landmine: it does not go off here, it goes
 * off much later, in some unrelated command that trusted the type and got a
 * `NaN` or a negative claim length instead.
 *
 * Two conventions this file has to get right:
 *
 * - Several settings use a documented "0 means no cap" idiom —
 *   `roomSpendCapUsd`, `memberSpendCapUsd`, `retainVersionsPerPath`. For
 *   those, 0 is the *most* meaningful value a person could set, not an error.
 *   Everything else that takes a count (a budget, a duration, an attempt
 *   limit) has no such convention behind it, so 0 there is nonsense a room
 *   could never usefully run with, and is rejected accordingly.
 *
 * - `id`, `name`, and `createdAt` are not in this file's registry.
 *   `updateConfig`'s own type already excludes `id` and `createdAt` — a
 *   room's identity and birth date are facts about it, not settings on it.
 *   `name` is a closer call, since `updateConfig`'s type does permit changing
 *   it. It is left out of `atrium config` anyway: every other entry here
 *   gates a mechanical property of the room (a budget, a timeout, a safety
 *   switch) that this file's whole job is coercing and rejecting bad values
 *   for, where `name` is a free-form label that cannot be wrong in the way
 *   a negative `actionBudget` is wrong. Folding it in would blur what this
 *   command promises — "every value here was checked for sense" — for the
 *   one setting that has no sense to check. A rename command, if wanted, is
 *   a different and much simpler feature than this one.
 *
 * Extensibility: the settings this file *lists* are derived from
 * `DEFAULT_ROOM_CONFIG`'s own keys, not hand-copied, so a setting added to
 * `RoomConfig` later shows up in `atrium config` automatically instead of
 * being silently invisible. Validating a new value for that new setting is a
 * different matter — there is no way to infer "0 is legitimate here" or
 * "must be at least 1" from a default value alone, so `SETTING_SPECS` below
 * has to be extended by hand. `SETTING_SPECS` is typed as a `Record` over
 * every settings key, which means the compiler itself enforces that: a
 * setting added to `DEFAULT_ROOM_CONFIG` without a matching entry here fails
 * the build instead of silently accepting unvalidated values for it.
 */

import { InvalidError } from "./errors.js";
import { DEFAULT_ROOM_CONFIG, type RoomConfig } from "./types.js";
import type { Room } from "./room.js";

export type SettingKey = keyof typeof DEFAULT_ROOM_CONFIG;

/** Every setting `atrium config` knows how to list, in the order
 * `DEFAULT_ROOM_CONFIG` declares them. */
export function settingKeys(): SettingKey[] {
  return Object.keys(DEFAULT_ROOM_CONFIG) as SettingKey[];
}

export function isSettingKey(key: string): key is SettingKey {
  return (settingKeys() as string[]).includes(key);
}

export interface SettingListing {
  key: SettingKey;
  value: boolean | number;
  default: boolean | number;
  isDefault: boolean;
}

/** Every setting with its current value and whether that value is the
 * shipped default, for `atrium config`'s listing view. */
export function listSettings(config: RoomConfig): SettingListing[] {
  const defaults: Record<string, boolean | number> = DEFAULT_ROOM_CONFIG;
  const values: Record<string, boolean | number> = config as unknown as Record<
    string,
    boolean | number
  >;
  return settingKeys().map((key) => {
    const value = values[key]!;
    const def = defaults[key]!;
    return { key, value, default: def, isDefault: value === def };
  });
}

type SettingType = "boolean" | "integer" | "number";

interface SettingSpec {
  type: SettingType;
  /** Smallest legal value, inclusive. Every numeric setting has one — there
   * is no setting here that is sensible at every real number. */
  min: number;
  /** Plain-English statement of what is allowed, reused in every rejection
   * for this key so the message says what to do next rather than just what
   * was wrong. */
  allowed: string;
}

// One entry per key in DEFAULT_ROOM_CONFIG. Typing this as a Record over
// SettingKey (rather than Partial<Record<...>>) is what makes a setting
// added elsewhere in RoomConfig a compile error here until it is given a
// spec — the one bit of manual registration this file cannot avoid, because
// "how should a new setting be validated" is a judgment call, not something
// derivable from its default value.
const SETTING_SPECS: Record<SettingKey, SettingSpec> = {
  allowUncheckedAcceptance: {
    type: "boolean",
    min: 0,
    allowed: "true or false",
  },
  leaseSeconds: {
    type: "integer",
    min: 1,
    allowed: "a whole number of seconds, 1 or more",
  },
  claimSeconds: {
    type: "integer",
    min: 1,
    allowed: "a whole number of seconds, 1 or more",
  },
  // Not a "0 means no cap" setting, unlike the spend caps below: a command
  // acceptance with no time limit is a room that can hang on one hung
  // process, which is the failure the timeout exists to prevent. The floor is
  // 1 second rather than something more generous because a deliberately tiny
  // limit is a legitimate way to prove a command is being run at all.
  commandTimeoutSeconds: {
    type: "integer",
    min: 1,
    allowed: "a whole number of seconds, 1 or more",
  },
  maxAttempts: {
    type: "integer",
    min: 1,
    allowed: "a whole number of attempts, 1 or more",
  },
  actionBudget: {
    type: "integer",
    min: 1,
    allowed: "a whole number of actions, 1 or more",
  },
  contextTokenCeiling: {
    type: "integer",
    min: 1,
    allowed: "a whole number of tokens, 1 or more",
  },
  roomSpendCapUsd: {
    type: "number",
    min: 0,
    allowed: "a number of dollars, 0 or more (0 means no cap)",
  },
  memberSpendCapUsd: {
    type: "number",
    min: 0,
    allowed: "a number of dollars, 0 or more (0 means no cap)",
  },
  retainVersionsPerPath: {
    type: "integer",
    min: 0,
    allowed: "a whole number of versions, 0 or more (0 means keep everything)",
  },
};

export type ParsedSettingValue = boolean | number;

/**
 * Coerces one raw command-line string into the type `key` needs, and rejects
 * anything that cannot be coerced or that coerces cleanly but is meaningless
 * (a negative budget, a zero-second lease). Never throws — a rejection here
 * is an ordinary, expected outcome of a human mistyping a value, not a bug,
 * so it comes back as a result the caller decides how to report rather than
 * an exception.
 */
export function parseSettingValue(
  key: SettingKey,
  raw: string,
): { ok: true; value: ParsedSettingValue } | { ok: false; message: string } {
  const spec = SETTING_SPECS[key];
  // Reachable only if a key were added to DEFAULT_ROOM_CONFIG and somehow
  // made it past the compile-time check above (e.g. a stale build); reported
  // rather than crashing so the failure still names what is missing.
  if (!spec) {
    return {
      ok: false,
      message: `atrium has no validation rule for "${key}" yet; this is a bug in atrium itself, not your input.`,
    };
  }

  const fail = (): { ok: false; message: string } => ({
    ok: false,
    message: `${key} must be ${spec.allowed} (got "${raw}").`,
  });

  if (spec.type === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return { ok: true, value: true };
    if (normalized === "false") return { ok: true, value: false };
    return fail();
  }

  if (raw.trim() === "") return fail();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fail();
  if (spec.type === "integer" && !Number.isInteger(parsed)) return fail();
  if (parsed < spec.min) return fail();

  return { ok: true, value: parsed };
}

export interface ConfigChangeResult {
  key: SettingKey;
  previous: ParsedSettingValue;
  value: ParsedSettingValue;
  config: RoomConfig;
  /** Human-readable cautions about this specific change, e.g. turning on
   * unchecked acceptance or halting the room on its next action. Empty for
   * an ordinary change. Applying the change and warning about it are not
   * mutually exclusive: both of these are things a person is allowed to do
   * on purpose, so neither is refused — only done silently. */
  warnings: string[];
}

/**
 * Validates and applies one setting change, and reports what a human needs
 * to know about the specific value they just picked. Throws `InvalidError`
 * for an unknown key or a value that fails `parseSettingValue`; a successful
 * call has already written the change to `.atrium/room.json` via
 * `Room.updateConfig` by the time it returns.
 */
export function applyConfigChange(
  room: Room,
  key: string,
  raw: string,
): ConfigChangeResult {
  if (!isSettingKey(key)) {
    throw new InvalidError(
      `Unknown setting "${key}". Valid settings: ${settingKeys().join(", ")}.`,
    );
  }

  const parsed = parseSettingValue(key, raw);
  if (!parsed.ok) throw new InvalidError(parsed.message);

  const previous = (room.config as unknown as Record<string, ParsedSettingValue>)[key]!;
  const warnings: string[] = [];

  // ARCHITECTURE.md §5: self-declared completion ("none" acceptance) is the
  // failure this project exists to prevent, and rooms should probably
  // reject it by default. Turning that protection off is allowed — some
  // rooms genuinely have tasks where nothing needs checking — but never
  // silently: this is the one setting change where "it worked" is not
  // reassuring on its own.
  if (key === "allowUncheckedAcceptance" && parsed.value === true && previous === false) {
    warnings.push(
      'allowUncheckedAcceptance is now true. Tasks created in this room may use "none" ' +
        "acceptance, which auto-accepts on submit with nobody — no command, no reviewer, no " +
        "human — checking the work. ARCHITECTURE.md §5 calls self-declared completion the " +
        "single most common failure in multi-agent systems. Turn this on only for tasks where " +
        "that risk is genuinely acceptable.",
    );
  }

  // A lowered actionBudget can move below the room's current event count in
  // one step, and assertUsable halts on the very next action in that case —
  // there is no grace period. That is a legitimate thing to want (an
  // operator deliberately shutting a room down) and an easy thing to do by
  // accident (typing the new ceiling instead of the amount to raise it by),
  // so it is applied either way but never without saying what happens next.
  if (key === "actionBudget") {
    const used = room.log.count();
    const newBudget = parsed.value as number;
    if (newBudget <= used) {
      warnings.push(
        `actionBudget is now ${newBudget}, but this room has already recorded ${used} ` +
          `action${used === 1 ? "" : "s"}. The room will halt the next time anything tries to ` +
          `act, the same as if it had run its budget all the way out. Raise actionBudget above ` +
          `${used} if that is not what you meant.`,
      );
    }
  }

  const updated = room.updateConfig({
    [key]: parsed.value,
  } as Partial<Omit<RoomConfig, "id" | "createdAt">>);

  return { key, previous, value: parsed.value, config: updated, warnings };
}
