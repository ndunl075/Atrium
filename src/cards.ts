/**
 * A member's capability manifest, in a shape other tooling already reads.
 *
 * ARCHITECTURE.md §12.8, from A2A (§13.2). A member describes itself on join
 * with free text and some tags, and `list_members` hands that to other agents
 * as a lead worth following up rather than a fact. A2A has standardised the
 * shape of exactly this — a card saying what an agent can do — and enough of
 * the industry has agreed to it that emitting the same shape costs little and
 * buys interoperability.
 *
 * ## The part that needed care
 *
 * §12.8 records this as a reason for caution rather than enthusiasm, and it
 * is the whole design constraint here: **a standard shape makes a claim
 * easier to parse; it does not make it true.** Free text that obviously came
 * from the agent itself is read sceptically. A tidy card with named skill
 * objects looks like something that was checked, and nothing checked it.
 *
 * So every card carries `selfReported: true` and a `provenance` sentence
 * saying in words where the claim came from. Not as decoration — as the one
 * field a consumer has to see before it decides how much weight to put on
 * the rest. Atrium verifies a member's *role*, because it enforces that; it
 * verifies nothing about what the member says it is good at.
 *
 * ## What this is not
 *
 * Not an A2A endpoint. A2A agents are addressable services that receive
 * delegated tasks; an Atrium member is a participant in a room, and there is
 * no URL to put in a card because there is nothing to call. Cards here are
 * *descriptive*, which is why `url` is absent rather than faked. Serving a
 * whole room as an A2A endpoint is the large version, still open in §12.8.
 */

import type { Member, MemberRole } from "./types.js";

/** One thing a member says it can do. A2A calls these skills. */
export interface CardSkill {
  id: string;
  name: string;
}

/**
 * A member as a capability card.
 *
 * Field names follow A2A's card where they mean the same thing (`name`,
 * `description`, `skills`), so a consumer that already parses those does not
 * need a special case. Everything Atrium-specific is under `atrium`, so it
 * cannot be mistaken for part of the standard.
 */
export interface AgentCard {
  name: string;
  /** The member's own manifest, verbatim. Empty when it did not write one. */
  description: string;
  skills: CardSkill[];
  /**
   * Always true. Present on every card rather than only on doubtful ones,
   * because a field that appears sometimes gets read as a warning about
   * *those* cards, and this applies to all of them.
   */
  selfReported: true;
  /** The same caveat in words, for a reader rather than a branch. */
  provenance: string;
  atrium: {
    memberId: string;
    /** Verified: Atrium enforces what a role may do, unlike everything above. */
    role: MemberRole;
    joinedAt: string;
    active: boolean;
  };
}

const PROVENANCE =
  "Written by this member when it joined. Atrium does not check it, and nothing " +
  "here has been verified against what the member has actually done. The role is " +
  "the exception: Atrium enforces that.";

export function agentCard(member: Member): AgentCard {
  return {
    name: member.name,
    description: member.manifest,
    // Tags are free-form labels (§3.2) with no ontology behind them, so the
    // id and the name are the same string. Inventing a stable id would imply
    // a registry of skills that deliberately does not exist.
    skills: member.tags.map((tag) => ({ id: tag, name: tag })),
    selfReported: true,
    provenance: PROVENANCE,
    atrium: {
      memberId: member.id,
      role: member.role,
      joinedAt: member.joinedAt,
      active: member.active,
    },
  };
}

/** Cards for a whole roster, in the order the members joined. */
export function agentCards(members: Member[]): AgentCard[] {
  return members.map(agentCard);
}
