/**
 * Agent cards (ARCHITECTURE.md §12.8).
 *
 * Most of these test one property, because it is the property the section
 * was cautious about: a standard shape makes a claim easier to parse and no
 * more true, so a card must never read as though something checked it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentCard, agentCards } from "./cards.js";
import { cmdRoster, type Sink } from "./cli.js";
import { Room } from "./room.js";
import type { Member } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(): { room: Room; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "atrium-cards-"));
  dirs.push(base);
  const dir = join(base, "room");
  const room = Room.create(dir);
  rooms.push(room);
  return { room, dir };
}

function sink(): Sink & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

afterEach(() => {
  while (rooms.length) {
    try {
      rooms.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function joined(room: Room): Member {
  return room.join({
    name: "scout",
    role: "worker",
    manifest: "Good at finding primary sources.",
    tags: ["research", "web"],
  }).member;
}

describe("agentCard", () => {
  it("maps a member onto the fields A2A already uses", () => {
    const { room } = tempRoom();

    const card = agentCard(joined(room));

    expect(card.name).toBe("scout");
    expect(card.description).toBe("Good at finding primary sources.");
    expect(card.skills).toEqual([
      { id: "research", name: "research" },
      { id: "web", name: "web" },
    ]);
  });

  it("says on its face that nothing verified it", () => {
    const { room } = tempRoom();

    const card = agentCard(joined(room));

    // The whole caution in §12.8: free text obviously came from the agent;
    // a tidy card looks like something that was checked, and nothing was.
    expect(card.selfReported).toBe(true);
    expect(card.provenance).toMatch(/Atrium does not check it/);
  });

  it("carries the caveat even for a member that claims nothing", () => {
    const { room } = tempRoom();
    const bare = room.join({ name: "quiet", role: "worker" }).member;

    const card = agentCard(bare);

    // A field that appeared only on doubtful cards would read as a warning
    // about those cards specifically.
    expect(card.selfReported).toBe(true);
    expect(card.description).toBe("");
    expect(card.skills).toEqual([]);
  });

  it("keeps everything Atrium-specific out of the standard fields", () => {
    const { room } = tempRoom();
    const member = joined(room);

    const card = agentCard(member);

    expect(card.atrium).toEqual({
      memberId: member.id,
      role: "worker",
      joinedAt: member.joinedAt,
      active: true,
    });
    // Nothing A2A defines should be quietly reused for something else.
    expect(card).not.toHaveProperty("role");
    expect(card).not.toHaveProperty("memberId");
  });

  it("has no url, because a member is not an addressable service", () => {
    const { room } = tempRoom();

    // A2A cards carry a URL to call. An Atrium member participates in a room
    // and there is nothing to call, so the field is absent rather than faked.
    expect(agentCard(joined(room))).not.toHaveProperty("url");
  });

  it("shows a member that has left as inactive rather than dropping it", () => {
    const { room } = tempRoom();
    const member = joined(room);
    room.leave(member.id);

    const card = agentCards(room.roster())[0]!;
    expect(card.atrium.active).toBe(false);
  });
});

describe("atrium roster --cards", () => {
  it("prints cards as JSON", () => {
    const { room, dir } = tempRoom();
    joined(room);
    const s = sink();

    expect(cmdRoster([dir, "--cards"], s)).toBe(0);
    const cards = JSON.parse(s.outLines.join("\n"));

    expect(cards[0].name).toBe("scout");
    expect(cards[0].selfReported).toBe(true);
  });

  it("still says the roster is self-reported in its help", () => {
    const s = sink();
    expect(cmdRoster(["--help"], s)).toBe(0);
    expect(s.outLines.join("\n")).toMatch(/self-reported/);
  });
});
