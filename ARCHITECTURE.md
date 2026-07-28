# Atrium — Architecture

**An open source office for AI agents to get context, coordinate, and finish real work.**

Status: pre-implementation design draft
Last updated: 2026-07-27

---

## How to read this document

Every substantive claim is tagged:

| Tag | Meaning |
|---|---|
| `[CONFIRMED]` | Decided. Comes directly from stated project intent. |
| `[ASSUMPTION]` | A design choice made to keep this document coherent. Revisit before building. |
| `[OPEN]` | Unresolved. Blocks implementation of the section it appears in. |

Do not treat `[ASSUMPTION]` items as settled. They were chosen so the document could be written, not because they were reasoned to.

---

## 1. What Atrium is

Atrium is a **shared workspace that multiple AI agents join in order to do one job together.**

It is not a framework for building agents. It does not define agent personalities, prompt templates, or reasoning loops. Agents arrive already built, from whatever stack they came from, and Atrium gives them a room to work in: shared context, a task board, a shared filesystem, and a record of what happened.

`[ASSUMPTION]` **The metaphor is a room, not a dispatcher.** The name "Atrium" encodes an open shared space where workers can see each other. This document is written for that model. The alternative model — a central dispatcher that routes jobs to whichever agent fits, with no shared room — is a materially different system. If that is what you actually want, roughly 60% of this document is wrong and should be rewritten before any code is written.

### Non-goals

- Not an agent framework. No `Agent` base class to inherit from.
- Not a model router or gateway.
- Not an observability product. Atrium records events; it does not chart them.
- Not a hosted service at v1. Local-first, single machine.

---

## 2. Why this is not just another agent framework

CrewAI, AutoGen, LangGraph, and MetaGPT all solve **agent definition and orchestration**: you describe agents and the edges between them, and the framework runs the graph. Coordination is expressed as message passing or as a pre-declared control flow.

Atrium takes the opposite position. `[ASSUMPTION]`

**Agents do not talk to each other. They read and write shared state.**

This is the blackboard architecture, a pattern from classical AI systems like Hearsay-II. Specialists observe a common workspace, contribute when they have something to contribute, and observe the results of others' contributions. There is no orchestrator holding the plan in its head.

Why this is the better bet:

1. **Message passing between LLM agents loses information.** Every handoff is a lossy summarization step. Shared state has no handoff, so there is nothing to lose.
2. **Pre-declared graphs are brittle.** Real work reorders itself. A blackboard tolerates an agent doing step 4 before step 3 if step 4 is unblocked.
3. **Framework agnosticism becomes possible.** If coordination lives in shared state rather than in a message protocol, any agent that can read and write that state can participate. A Claude Code session, a LangGraph app, and a shell script can all sit in the same room.

**Honest counterargument:** the blackboard model was largely abandoned in the 1980s because control became hard to reason about — with no orchestrator, systems thrash, and nobody can explain why the system did what it did. Modern LLM agents are far more expensive per action than the rule-based specialists of that era, so thrashing costs real money. Section 6 is the answer to this and it is the highest-risk part of the design. If Atrium fails, it most likely fails here.

---

## 3. Core model

### 3.1 The Room

A **Room** is a named, persistent container for one job. It owns:

- a working directory on disk (the artifacts being produced)
- a context store (what agents need to know)
- a task board (what needs doing)
- an event log (what has happened)
- a roster (who is in the room)

Rooms are isolated from each other. `[CONFIRMED]`

### 3.2 Members

A **Member** is any process holding a session token for a Room. Members are typed:

- `worker` — claims tasks and produces artifacts
- `reviewer` — can accept or reject completed tasks, cannot accept its own work
- `human` — same permissions as reviewer, plus room administration

`[ASSUMPTION]` Agents self-describe capabilities on join via a short capability manifest (free text plus tags). No formal capability ontology at v1. Formal capability schemas are the kind of thing that eats three weeks and produces a taxonomy nobody uses.

### 3.3 Artifacts

Files in the Room's working directory. Real files on real disk, not abstractions. Any agent that can call `open()` can work with them. Artifacts are versioned through the event log rather than through a custom VCS. `[ASSUMPTION]` Git is deliberately not used internally at v1; a Room directory can itself live inside a git repo without Atrium knowing.

### 3.4 Tasks

A work item on the board. States:

```
open → claimed → submitted → accepted
                     ↓
                  rejected → open
       ↓
    blocked → open
```

Tasks carry: title, description, `depends_on[]`, `acceptance` (see §5), claim lease, attempt count.

### 3.5 The Event Log

Append-only, totally ordered, the **single source of truth**. The board and the roster are projections of the log, not independently mutable state.

This matters more than it sounds. Multi-agent systems fail in ways that are invisible at the time of failure and inexplicable afterward. An ordered log means any run can be replayed, diffed, and explained. Debuggability is the actual product feature here, not a nice-to-have.

---

## 4. Getting context

Three tiers, in priority order:

**Tier 1 — Room context.** Curated, shared, small. A `CONTEXT.md` in the Room root plus pinned artifacts. Injected into every agent that joins. This is the brief.

**Tier 2 — Artifact retrieval.** On-demand search over the Room working directory. `[ASSUMPTION]` Full-text search only at v1. No embeddings, no vector store. Most Rooms will hold fewer than a few hundred files, where FTS beats semantic search on both precision and setup cost. Add embeddings when a real Room proves FTS insufficient, not before.

**Tier 3 — The log.** Agents can query what has already happened, which is how a joining agent catches up without anyone summarizing for it.

### Boundary with Trayce `[OPEN]`

This needs a public answer before the repo goes live, because it will be the first question a technical reader asks.

Working answer: **Trayce is user-scoped context — what *you* know, your files, your voice, your history. Atrium is job-scoped context — what *this room* knows about *this piece of work*.** A user might attach Trayce to a Room as a Tier 2 context source through MCP, which makes them complementary rather than competing.

Decide whether that is genuinely true or whether it is a story told to justify building both. If Atrium's context layer starts growing a personal knowledge graph, the projects have collided and one should absorb the other.

---

## 5. Finishing real work

The phrase "finish real work" carries the entire weight of this project, so it needs a mechanical definition.

**An agent cannot mark its own work done.** `[CONFIRMED — this is the core design principle]`

Self-declared completion is the single most common failure in multi-agent systems. An agent produces something plausible, announces success, and downstream agents build on a foundation that was never checked.

Every task carries an `acceptance` field with one of:

| Type | Meaning | Trust level |
|---|---|---|
| `command` | A shell command that must exit 0 | Highest — objective |
| `reviewer` | A different member must accept | Medium — LLM judgment |
| `human` | A human must accept | Highest, slowest |
| `none` | Auto-accept on submit | Lowest — should warn on use |

`[ASSUMPTION]` Tasks default to `reviewer` if unspecified. Rooms can be configured to reject `none` entirely, and probably should be by default.

Prefer `command` wherever the work admits it. A passing test suite is worth more than an agent's opinion that the code looks correct.

---

## 6. Coordination and correctness

The hard part. Failure modes and their mitigations:

**Two agents claim the same task.**
Claims are compare-and-swap against the log. Exactly one wins; the loser sees a conflict and re-reads the board. Not a lock — an atomic append that either lands or does not.

**Two agents edit the same artifact.**
Artifact **leases**. Writing requires holding a lease on that path. Leases expire (`[ASSUMPTION]` 5 minutes, renewable) so a crashed agent does not deadlock the Room.

**An agent works from stale context.**
Every read returns the log sequence number it was valid at. Submitting work carries the sequence number it was based on. If the artifact changed since, the submission is rejected as stale. Optimistic concurrency, borrowed wholesale from databases because it works.

**Infinite handoff loops.**
Tasks carry an attempt counter. `[ASSUMPTION]` Three rejections escalates to a human and freezes the task. Rooms also carry a global action budget; on exhaustion the Room halts rather than continuing to spend.

**Context bloat.**
Tier 1 context has a hard token ceiling. `[OPEN]` What happens on overflow — reject the pin, evict oldest, or summarize? Summarization reintroduces exactly the lossiness this design exists to avoid, so lean toward rejecting the pin and making the human choose.

**Cost runaway.**
Per-Room and per-member spend caps exist now (`src/cost.ts`), built honestly around the constraint the rest of this section states: **Atrium does not make the model calls, so it can only total what an adapter self-reports.** A member calls `report_cost` (MCP) or the equivalent library function with a USD amount after each call it makes; Atrium folds those events into running per-member and per-room totals, the same way the board and roster are folded from the log. If a report crosses either cap, the room halts through the existing action-budget mechanism (`Room.assertUsable` / `room.halted`) — the report that crossed the cap still lands, because the money was already spent and the log must not lie about that, but every action after it is refused until a human raises the cap or starts over. `0`, or never setting the fields, means no cap, so a room that ignores this feature behaves exactly as it did before it existed.

What remains genuinely unsolved, `[OPEN]`: a member that never calls `report_cost` is never charged, and nothing in this design can force it to. A misbehaving or just-unaware adapter can spend without limit and Atrium will show a total of $0 the entire time. This is not a bug to fix later; it is the actual ceiling on what an out-of-process observer can enforce. The only way past it is agents running behind a metering proxy that reports on their behalf, which is a deployment choice, not something this repo can guarantee. Advisory is the honest word for what this is.

---

## 7. Interfaces

### 7.1 MCP server (primary)

Atrium exposes a Room as an MCP server. Any MCP-capable agent joins with zero Atrium-specific code. This is the adoption path — the install story is a config entry, not an SDK.

Tools exposed: `join`, `get_context`, `search_artifacts`, `list_tasks`, `claim_task`, `read_artifact`, `write_artifact`, `submit_task`, `review_task`, `post_note`, `read_log`.

### 7.2 CLI

`atrium init`, `atrium open <room>`, `atrium board`, `atrium log`, `atrium invite`, `atrium replay <seq>`.

### 7.3 Watch UI `[ASSUMPTION]`

Read-only local web view: board state, live event stream, artifact diffs. Deferred past v1. It is the most demo-able part of the project and therefore the most tempting thing to build first, which is exactly why it should be built last.

---

## 8. Stack `[ASSUMPTION]`

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node + TypeScript | Existing fluency, best MCP tooling |
| Storage | SQLite (WAL) | Single file, atomic appends, no daemon |
| Artifacts | Plain filesystem | Any tool can participate |
| Transport | MCP over stdio and HTTP | Zero-SDK adoption |
| Tests | Vitest | — |

Dependency budget: keep it small. Every dependency is friction for an OSS contributor, and this project's audience will read the dependency list before the README.

---

## 9. MVP scope

**One workflow, end to end: research → draft → review.**

Three agents in one Room producing one document, where the reviewer genuinely rejects bad drafts and the rejection genuinely sends work back. Nothing else.

Ships in v0.1:
- Room create and join
- Event log with replay
- Task board with atomic claim
- Artifact read and write with leases
- `reviewer` and `command` acceptance
- MCP server
- CLI

Explicitly cut from v0.1: web UI, embeddings, remote or multi-machine Rooms, auth beyond a local token, cost enforcement, agent marketplace, capability ontology, anything involving the word "orchestrator."

**Definition of done for v0.1:** a stranger clones the repo and gets three agents to produce one reviewed document in under ten minutes, without reading the source.

`[OPEN]` **Time budget.** This was scoped as a side project. Set a real cap in wall-clock hours and write it here. A number you have to look at is harder to blow through than a number you carry around in your head.

---

## 10. Open questions

1. Room metaphor or dispatcher metaphor. Everything above assumes room. §1
2. Trayce boundary — real distinction or convenient story. §4
3. Context overflow policy. §6
4. Cost enforcement without controlling model calls. §6
5. License. `[OPEN]` Apache 2.0 is the safe default for infrastructure intended for adoption. MIT if you want maximum uptake and do not care about patent grants.
6. Whether this stays a side project or becomes a thing. Answer it deliberately rather than by drift.

---

## 11. Risks worth naming

**The metaphor is not a moat.** "Office for agents" is good positioning and zero defensibility. The defensible parts, if any, are the acceptance model and the replayable log. Lead with those in technical writing, not with the office framing.

**Blackboard control is genuinely unsolved.** §2 states the counterargument honestly. If Rooms thrash in real use, the honest response is to add a lightweight scheduler, not to insist the pattern is pure.

**Open source is distribution, not strategy.** Stars are not adoption and adoption is not revenue. If this is a credibility play, define what a win looks like now — a number of external contributors, a specific person using it, an inbound conversation — so you can tell later whether it worked.
