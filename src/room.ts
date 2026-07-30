/**
 * A room: one job, one working directory, one log.
 *
 * Rooms are isolated from each other. Everything a room knows is either a file
 * in its working directory or an event in its log, which is what makes a room
 * something you can copy, inspect, and replay.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { recordBrief } from "./context.js";
import { EventLog } from "./log.js";
import {
  HaltedError,
  InvalidError,
  NotFoundError,
  PermissionError,
} from "./errors.js";
import { roomPaths, type RoomPaths } from "./paths.js";
import {
  DEFAULT_ROOM_CONFIG,
  type AnyEvent,
  type Member,
  type MemberId,
  type MemberRole,
  type RoomConfig,
} from "./types.js";
import { newId, newToken, now, renameWithRetry, sha256 } from "./util.js";

export interface CreateRoomOptions {
  /** Shown in the CLI and the log. Defaults to the directory name. */
  name?: string;
  /** Anything you want to differ from the defaults. */
  config?: Partial<Omit<RoomConfig, "id" | "name" | "createdAt">>;
}

export interface JoinOptions {
  name: string;
  role: MemberRole;
  /** How the agent describes what it is good for, in prose. */
  manifest?: string;
  tags?: string[];
}

export interface JoinResult {
  member: Member;
  /**
   * Shown once, at join time. Everything the member does afterwards is
   * authenticated with it, so it is not recoverable from the room later.
   */
  token: string;
}

/**
 * Replays membership events into the roster they describe.
 *
 * Kept as a pure fold so the live room and historical replay use exactly the
 * same rules for joins and departures.
 */
export function foldRoster(events: AnyEvent[]): Member[] {
  const members = new Map<MemberId, Member>();

  for (const event of events) {
    if (event.type === "member.joined") {
      members.set(event.data.memberId, {
        id: event.data.memberId,
        name: event.data.name,
        role: event.data.role,
        manifest: event.data.manifest,
        tags: event.data.tags,
        joinedAt: event.ts,
        active: true,
      });
    } else if (event.type === "member.left") {
      const existing = members.get(event.data.memberId);
      if (existing) existing.active = false;
    }
  }

  return [...members.values()];
}

export class Room {
  readonly paths: RoomPaths;
  readonly log: EventLog;
  private cachedConfig: RoomConfig;

  private constructor(paths: RoomPaths, log: EventLog, config: RoomConfig) {
    this.paths = paths;
    this.log = log;
    this.cachedConfig = config;
  }

  /** The working directory. Artifact paths are relative to this. */
  get dir(): string {
    return this.paths.root;
  }

  get config(): RoomConfig {
    return this.cachedConfig;
  }

  static isRoom(dir: string): boolean {
    return existsSync(roomPaths(dir).config);
  }

  static create(dir: string, options: CreateRoomOptions = {}): Room {
    const paths = roomPaths(dir);
    if (existsSync(paths.config)) {
      throw new InvalidError(`${paths.root} is already a room.`, {
        dir: paths.root,
      });
    }

    mkdirSync(paths.atrium, { recursive: true });

    const name = options.name ?? basename(paths.root);
    const config: RoomConfig = {
      ...DEFAULT_ROOM_CONFIG,
      ...options.config,
      id: newId("room"),
      name,
      createdAt: now(),
    };
    writeJson(paths.config, config);
    writeJson(paths.tokens, {}, 0o600);

    if (!existsSync(paths.context)) {
      writeFileSync(
        paths.context,
        `# ${name}\n\nWhat this room is for. Every agent that joins reads this first.\n`,
        "utf8",
      );
    }

    const log = EventLog.open(paths.db);
    log.append("system", "room.created", { roomId: config.id, name });

    // Deliberately not recording the brief here. The file `Room.create`
    // writes is a placeholder nobody has written yet, and recording it would
    // put a meaningless first version at the head of every room's history
    // while costing every room an event of its action budget. The first
    // version worth having is whatever somebody replaces it with, and that is
    // captured by `applyJob`, by `atrium context --record`, or by the next
    // join — whichever happens first.
    return new Room(paths, log, config);
  }

  static open(dir: string): Room {
    const paths = roomPaths(dir);
    if (!existsSync(paths.config)) {
      throw new NotFoundError(`${paths.root} is not a room.`, {
        dir: paths.root,
      });
    }
    // Layered over the defaults rather than trusted as-is. A room written
    // before a config field existed has no value for it on disk, and reading
    // that straight back would hand out a RoomConfig whose types lie: a
    // `number` field holding `undefined`. Whether that degrades quietly or
    // badly depends entirely on how the field happens to be used, so it is
    // filled in here instead of being left to each reader to survive.
    const stored = JSON.parse(readFileSync(paths.config, "utf8")) as Partial<RoomConfig>;
    const config: RoomConfig = { ...DEFAULT_ROOM_CONFIG, ...stored } as RoomConfig;
    return new Room(paths, EventLog.open(paths.db), config);
  }

  /** Changes settings on an open room and writes them back to disk. */
  updateConfig(
    changes: Partial<Omit<RoomConfig, "id" | "createdAt">>,
  ): RoomConfig {
    this.cachedConfig = { ...this.cachedConfig, ...changes };
    writeJson(this.paths.config, this.cachedConfig);
    return this.cachedConfig;
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  join(options: JoinOptions): JoinResult {
    this.assertUsable();

    // The brief is a plain file anybody can edit without telling Atrium (§4),
    // so this is where an edit made in somebody's editor gets into the log:
    // right before a member is handed that brief to work from. Recording it
    // at the moment it is about to be acted on is the honest point to do it,
    // and it appends nothing when the brief has not changed.
    //
    // `join` rather than `getContext` on purpose. Reads must stay reads — the
    // Watch UI calls getContext on a timer, and a read-only view that grew
    // the log every few seconds would be its own kind of wrong.
    recordBrief(this, "system", "observed");

    const name = options.name?.trim();
    if (!name) throw new InvalidError("A member needs a name.");
    if (!isRole(options.role)) {
      throw new InvalidError(
        `Unknown role "${options.role}". Use worker, reviewer, or human.`,
      );
    }

    const memberId = newId("member");
    this.log.append(memberId, "member.joined", {
      memberId,
      name,
      role: options.role,
      manifest: options.manifest ?? "",
      tags: options.tags ?? [],
    });

    const token = newToken();
    const tokens = this.readTokens();
    tokens[sha256(token)] = memberId;
    writeJson(this.paths.tokens, tokens, 0o600);

    return { member: this.member(memberId), token };
  }

  leave(memberId: MemberId): void {
    const member = this.member(memberId);
    if (!member.active) return;
    this.log.append(memberId, "member.left", { memberId });

    // A member that has left stays in the roster for replay and attribution,
    // but its credentials must not stay live. Remove every token for the
    // member rather than assuming there can only ever be one.
    const tokens = this.readTokens();
    let changed = false;
    for (const [tokenHash, holderId] of Object.entries(tokens)) {
      if (holderId !== memberId) continue;
      delete tokens[tokenHash];
      changed = true;
    }
    if (changed) writeJson(this.paths.tokens, tokens, 0o600);
  }

  /** Turns a session token into the member holding it. */
  authenticate(token: string): Member {
    const memberId = this.readTokens()[sha256(token ?? "")];
    if (!memberId) throw new PermissionError("That session token is not valid.");
    const member = this.member(memberId);
    if (!member.active) {
      // Defensive even though leave() removes tokens: old rooms, manual edits,
      // or an interrupted token-file update must not reactivate a departed
      // member merely because a stale credential still exists.
      throw new PermissionError(
        "That session token belongs to a member who has left.",
      );
    }
    return member;
  }

  /** Everyone who has ever joined, including those who have left. */
  roster(): Member[] {
    return foldRoster(
      this.log.read({ types: ["member.joined", "member.left"] }),
    );
  }

  member(id: MemberId): Member {
    const found = this.roster().find((m) => m.id === id);
    if (!found) throw new NotFoundError(`No member ${id} in this room.`, { id });
    return found;
  }

  /** Throws unless the member holds one of the given roles. */
  requireRole(memberId: MemberId, roles: MemberRole[]): Member {
    const member = this.member(memberId);
    if (!roles.includes(member.role)) {
      throw new PermissionError(
        `${member.name} is a ${member.role}; this needs ${roles.join(" or ")}.`,
        { memberId, role: member.role, needs: roles },
      );
    }
    return member;
  }

  // -------------------------------------------------------------------------
  // Budget
  // -------------------------------------------------------------------------

  /**
   * Whether the room has stopped itself. A halted room is still readable, so
   * you can go and find out what it spent the budget on.
   */
  isHalted(): boolean {
    return this.log.read({ types: ["room.halted"], limit: 1 }).length > 0;
  }

  /**
   * Called before anything that would add to the log. Every event counts as one
   * action, so the budget is simply how long the log is allowed to get. When it
   * runs out the room records that it stopped and refuses further work rather
   * than carrying on spending.
   */
  assertUsable(): void {
    if (this.isHalted()) {
      throw new HaltedError(
        "This room has stopped: it used up its action budget.",
        { roomId: this.config.id },
      );
    }
    if (this.log.count() >= this.config.actionBudget) {
      this.log.append("system", "room.halted", {
        reason: `Reached the limit of ${this.config.actionBudget} actions.`,
      });
      throw new HaltedError(
        `This room has stopped: it reached its limit of ${this.config.actionBudget} actions.`,
        { roomId: this.config.id, actionBudget: this.config.actionBudget },
      );
    }
  }

  close(): void {
    this.log.close();
  }

  /** Maps the hash of a session token to the member holding it. */
  private readTokens(): Record<string, MemberId> {
    if (!existsSync(this.paths.tokens)) return {};
    return JSON.parse(readFileSync(this.paths.tokens, "utf8")) as Record<
      string,
      MemberId
    >;
  }
}

// ---------------------------------------------------------------------------

function isRole(value: unknown): value is MemberRole {
  return value === "worker" || value === "reviewer" || value === "human";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "room";
}

/** Writes via a temporary file so an interrupted write cannot truncate. */
function writeJson(path: string, value: unknown, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode });
  renameWithRetry(tmp, path);
}
