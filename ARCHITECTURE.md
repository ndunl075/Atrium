# Atrium — Architecture

**An open source office for AI agents to get context, coordinate, and finish real work.**

Status: v0.2 shipped; building toward v0.3
Last updated: 2026-07-30

---

## How to read this document

Every substantive claim is tagged:

| Tag | Meaning |
|---|---|
| `[SHIPPED]` | Built, tested, and in `main`. The description matches the code. |
| `[CONFIRMED]` | Decided. Comes directly from stated project intent. |
| `[PLANNED]` | Decided and scheduled, but not built. See §12 for the queue. |
| `[ASSUMPTION]` | A design choice made to keep this document coherent. Revisit before building. |
| `[OPEN]` | Unresolved. Blocks implementation of the section it appears in. |

Do not treat `[ASSUMPTION]` items as settled. They were chosen so the document could be written, not because they were reasoned to.

This document was originally written before any code existed. Sections that have since been built are marked `[SHIPPED]` and have been rewritten to describe what is actually there, not what was intended. Where the two disagreed, the code won.

---

## 0. Implementation status

The honest state of the project as of 2026-07-30. 21.5k lines of TypeScript, 522 tests across 20 files, zero runtime dependencies.

### Built and tested

| Capability | Where | Notes |
|---|---|---|
| Append-only event log, totally ordered | `src/log.ts` | SQLite via `node:sqlite`. Source of truth for everything else. |
| Room lifecycle, config, halting | `src/room.ts`, `src/config.ts` | Action budget and spend caps both halt through `assertUsable`. |
| Task board, folded from the log | `src/board.ts`, `src/tasks.ts` | No board table. `foldTasks` is the only reader. |
| Atomic claim under contention | `src/board.ts` | Read-check-write inside one SQLite write transaction. |
| Acceptance: `command`, `reviewer`, `human`, `none` | `src/acceptance.ts` | Submitter can never be the approver, whatever their role. |
| Rejection, attempt counting, escalation freeze | `src/tasks.ts`, `src/acceptance.ts` | Freezes at `maxAttempts` and waits for a human. |
| Artifacts with leases and stale-write rejection | `src/artifacts.ts`, `src/leases.ts` | Optimistic concurrency on the log sequence number. |
| Content-addressed blob store | `src/snapshots.ts` | Every version's bytes retained, keyed by the hash the log records. |
| `history` / `diff` across versions | `src/snapshots.ts`, `src/cli.ts` | Refuses to diff a pruned version rather than showing it empty. |
| `gc` (safe) and `prune` (destructive) | `src/snapshots.ts` | Nothing prunes on a timer; a person runs the command. |
| Room integrity check | `src/verify.ts` | Distinguishes "pruned" from "damaged" from "never written". |
| Full-text artifact search | `src/search.ts` | No embeddings, by design (§4 Tier 2). |
| Room context, pinning, token ceiling | `src/context.ts` | |
| Self-reported cost accounting, advisory caps | `src/cost.ts` | Advisory only — see §6 for why that ceiling is real. |
| MCP server over stdio | `src/mcp.ts` | 23 tools. |
| MCP server over HTTP | `src/http.ts` | `127.0.0.1` only, bearer token required, no anonymous join. |
| CLI | `src/cli.ts` | 24 commands including `task` administration as an auto-provisioned `human` member. |
| Read-only Watch UI | `src/watch.ts` | Board, live event stream, artifact diffs, live agent activity. |
| Thin runner | `src/runner.ts` | Operator-declared worker commands, bounded dispatch pass, `--dry-run`. |
| Single-file binary build | `scripts/build-binary.mjs`, `src/sea.ts` | |
| End-to-end workflow test | `src/workflow.test.ts` | research → draft → review with a real rejection. |
| YAML job declaration | `src/jobs.ts`, `src/yaml.ts` | `atrium init --from job.yaml`. Zero-dependency subset parser. §12.1 |
| Runnable demo with reference workers | `examples/demo/`, `src/demo.test.ts` | `npm run demo`. Scripted MCP clients; doubles as a regression test. §12.1a |
| Fork a room from a point in its log | `src/fork.ts` | `atrium fork`. Exact reconstruction, inherited history, provenance in the log. §12.7 |

### Not built

| Capability | Status | Section |
|---|---|---|
| `atrium plan` — proposed board from the brief | `[PLANNED]` — next | §12.2 |
| Record the brief in the log | `[OPEN]` — a real gap, found by §12.7 | §3.5, §12.7 |
| `expectedOutput` contract on tasks | `[PLANNED]` | §12.3 |
| Event stream for external observability | `[PLANNED]` | §12.4 |
| `manager` role | `[PLANNED]` | §12.5 |
| `needs_input` task state | `[PLANNED]` | §12.6 |
| Agent cards for the roster | `[OPEN]` | §12.8 |
| Long-lived polling workers | `[OPEN]` | §12.9 |
| Named context blocks | `[OPEN]` | §12.10 |
| Artifact-first tasks | `[OPEN]` — possible v1 shape | §13.6 |
| Embeddings / semantic search | Deliberately deferred | §4 |
| Multi-machine rooms | Deliberately deferred | §9 |
| Enforced (non-advisory) cost caps | `[OPEN]` — may be unsolvable here | §6 |

### Known gaps that are not features

- **Not published to npm.** The README tells clients to run `atrium serve`, but the only working path today is clone → `npm install` → `npm run build` → `node dist/cli.js`. Now that `npm run demo` works from a fresh clone, this is the last thing standing between a stranger and the project — and it is the single largest one.
- ~~No runnable demo.~~ Fixed by §12.1 and §12.1a: `npm run demo`.
- ~~The runner has nothing to run.~~ `examples/demo/worker.mjs` is a working `atrium run` worker.

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

CrewAI, AutoGen, LangGraph, and MetaGPT all solve **agent definition and orchestration**: you describe agents and the edges between them, and the framework runs the graph. Coordination is expressed as message passing or as a pre-declared control flow. §13 surveys these and several others in detail, including what has been taken from each and what has been deliberately refused.

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

Rooms are isolated from each other. `[CONFIRMED]` Nothing that happens in one Room can affect another: there is no shared board, no shared log, and no cross-Room reference an agent can follow.

One qualification, added when forking shipped (§12.7): a Room created by `atrium fork` records the Room it was forked from, in its log. That is provenance, not a live link — the parent is not consulted, cannot be reached from the fork, and does not know the fork exists. Isolation is about operation; a fork that could not say where its first two hundred events came from would be a Room that lies by omission.

### 3.2 Members

A **Member** is any process holding a session token for a Room. Members are typed:

- `worker` — claims tasks and produces artifacts
- `reviewer` — can accept or reject completed tasks, cannot accept its own work
- `human` — same permissions as reviewer, plus room administration

`[ASSUMPTION]` Agents self-describe capabilities on join via a short capability manifest (free text plus tags). No formal capability ontology at v1. Formal capability schemas are the kind of thing that eats three weeks and produces a taxonomy nobody uses.

### 3.3 Artifacts

Files in the Room's working directory. Real files on real disk, not abstractions. Any agent that can call `open()` can work with them. Artifacts are versioned through the event log rather than through a custom VCS. `[ASSUMPTION]` Git is deliberately not used internally at v1; a Room directory can itself live inside a git repo without Atrium knowing.

Every write's content is retained, not just its hash. `artifact.written` records a sha256 of the bytes it wrote; the bytes themselves are kept in a content-addressed blob store under `.atrium/objects/<hash prefix>/<hash rest>`, keyed by that same hash. This is what makes replay mean something for artifacts specifically, not just for the board: `atrium history` lists every version a path has had, and `atrium diff` shows what changed between two of them, including a version from before the path was deleted. Content-addressing keeps it cheap — identical bytes are stored once no matter how many times they are written or under how many paths — and it is still not a VCS: there is no tree, no commit graph, no merge, just a flat store of blobs that the log's own sequence numbers give history to.

Retention is explicit and manual. The store grows with the room by design, since a version that cannot be read back is not history; a room that sets `retainVersionsPerPath` can have `atrium prune` drop the content of older versions, but nothing discards anything on its own. `[ASSUMPTION]` A room's owner is better placed to decide what history is worth keeping than any policy Atrium could apply on a timer, so the policy is inert until somebody runs the command.

Pruning removes bytes, never record. The `artifact.written` events stay, the versions keep listing, and an `artifact.pruned` event records what was dropped and under which setting — so a version whose content is missing can always be told apart from one that was never written, and a missing blob can be told apart from a damaged store. This distinction is load-bearing rather than cosmetic: everything that reads past content reports "written, no longer retained" as its own outcome, because the alternatives are all false statements. A diff against a pruned version refuses instead of showing the file as empty, and MCP's `read_artifact` reports `exists: true, pruned: true` rather than telling an agent the write never happened.

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

One thing it does not currently cover, which §12.7 found and §4 should be read alongside: **the room's brief is not in the log.** Pinning and unpinning are events; editing `CONTEXT.md` is a plain file write that nothing records. So the log captures every consequence of the instruction and not the instruction, and no amount of replaying recovers what an agent was actually told at the time. This is a genuine gap in the claim this section makes, not a deliberate exclusion.

It also makes resumability fall out for free rather than needing a mechanism. A room has no in-memory state to lose: every reader folds the log, so a process that dies mid-job and a process that starts fresh a week later are the same case. Frameworks that pass state between agents in memory have to bolt on periodic checkpointing to get this back, and get a *sampled* history for their trouble; here there is nothing to checkpoint, because nothing was ever anywhere else.

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
Tier 1 context has a hard token ceiling. `[OPEN]` What happens on overflow — reject the pin, evict oldest, or summarize? Summarization reintroduces exactly the lossiness this design exists to avoid, so lean toward rejecting the pin and making the human choose. §12.10 would improve the *message* rather than the policy: a ceiling per named block can say which part is full, where one ceiling over everything can only say that something is.

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

### 7.3 Watch UI `[SHIPPED]`

`atrium watch <room>` serves a read-only local web view: board state, a live event stream, artifact diffs, and live agent activity. `src/watch.ts`, with `npm run dev` building and launching it against `./demo-room` in one command.

This was originally deferred past v1 on the reasoning that it is the most demo-able part of the project and therefore the most tempting thing to build first. That reasoning held right up until the project needed something a stranger could look at; being able to *see* a rejection land is most of what makes the acceptance model legible to someone who has not read §5.

### 7.4 Thin runner `[SHIPPED]`

Atrium coordinates work but deliberately does not launch agents. `atrium run`
(`src/runner.ts`) is a separate, optional layer that makes a Room operational
without turning the core into an agent framework:

1. Read the Room brief and board.
2. Launch agent commands declared by the operator in `.atrium/runner.json`.
3. Hand each worker its assignment through the environment (`ATRIUM_ROOM`, `ATRIUM_TASK_ID`, `ATRIUM_TASK_TITLE`, `ATRIUM_TASK_DESCRIPTION`, `ATRIUM_WORKER_NAME`).
4. Monitor claims, failures, retries, and spend reports.
5. Stop at the acceptance boundary for a command, another agent, or a human.

A launched worker still joins and claims through Atrium itself; the runner
never keeps a second private task board. `--dry-run` shows the dispatch pass
without launching anything.

The runner must not hold a private plan or become a second source of truth. It
may start workers and react to events, but tasks, dependencies, claims,
artifacts, acceptance, and history remain in the Room. Agents still coordinate
through shared state rather than direct messages.

**Atrium holds the truth; the runner manages the workers.**

Keeping the runner outside the core preserves framework agnosticism: Codex,
Claude Code, a shell script, or a third-party agent framework can all be
configured as worker commands. A human or an existing agent can perform the
same orchestration manually without the runner.

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

Shipped in v0.1 `[SHIPPED]`:
- Room create and join
- Event log with replay
- Task board with atomic claim
- Artifact read and write with leases
- `reviewer` and `command` acceptance
- MCP server
- CLI

Shipped in v0.2, past the original v0.1 line `[SHIPPED]`: HTTP transport, advisory cost caps, content-addressed artifact history with `history`/`diff`/`gc`/`prune`/`verify`, human task administration from the CLI, the Watch UI, the thin runner, and a single-file binary build.

Explicitly still cut: embeddings, remote or multi-machine Rooms, auth beyond a local token, enforced cost caps, agent marketplace, capability ontology, anything involving the word "orchestrator."

**Definition of done for v0.1:** a stranger clones the repo and gets three agents to produce one reviewed document in under ten minutes, without reading the source.

**Met, with one asterisk.** `npm run demo` takes a fresh clone to a finished job with a real rejection in it, in about ten seconds and without reading the source. The asterisk is "clones the repo": there is still no `npx atrium`, so the ten minutes assumes somebody already decided to clone.

### v0.3 target

**Definition of done for v0.3:** a stranger runs one command against a fresh clone and watches an agent's work get rejected and sent back, without writing any configuration.

**Met** by §12.1 and §12.1a. `npm run demo` seeds the board from a job file, runs the workers, and the draft comes back with a reason attached before it is accepted on the second attempt.

What that leaves is the honest limit of it: the workers are scripted, so this demonstrates that the *coordination* works and says nothing about whether real agents coordinate well. That question needs §12.1a's `--model` mode, or somebody pointing a real agent at a room and reporting back. The second would be worth more.

`[OPEN]` **Time budget.** This was scoped as a side project. Set a real cap in wall-clock hours and write it here. A number you have to look at is harder to blow through than a number you carry around in your head.

---

## 10. Open questions

Still open:

1. Room metaphor or dispatcher metaphor. Everything above assumes room. §1
2. Trayce boundary — real distinction or convenient story. §4
3. Context overflow policy. §6
4. Cost enforcement without controlling model calls. §6 — likely unsolvable from outside the model call; advisory may be the permanent answer.
5. Whether this stays a side project or becomes a thing. Answer it deliberately rather than by drift.
6. Whether shipping reference workers (§12.1) makes Atrium an agent framework by the back door. The line held so far is that a worker in `examples/` is a *demonstration* of the MCP interface, not part of the product surface, and nothing in `src/` may import one.

Resolved since first draft:

- ~~License.~~ Apache 2.0, for the patent grant. `LICENSE` is in the repo.
- ~~Whether the thin runner belongs in this repository.~~ It ships here as `src/runner.ts`, kept honest by the rule in §7.4: it may start workers and react to events, but it holds no private plan and no second board.

---

## 11. Risks worth naming

**The metaphor is not a moat.** "Office for agents" is good positioning and zero defensibility. The defensible parts, if any, are the acceptance model and the replayable log. Lead with those in technical writing, not with the office framing.

**Blackboard control is genuinely unsolved.** §2 states the counterargument honestly. If Rooms thrash in real use, the honest response is to add a lightweight scheduler, not to insist the pattern is pure.

That scheduler now has a shape, borrowed from AutoGen (§13.4): a pluggable **claim policy** deciding which idle member gets the next claimable task, with an explicit termination condition, defaulting to the current first-come behaviour. Naming it does not build it and is not a commitment to build it — the point is that the contingency is no longer a sentence saying something would be done, and the current behaviour is now a chosen default rather than an unexamined one.

**Open source is distribution, not strategy.** Stars are not adoption and adoption is not revenue. If this is a credibility play, define what a win looks like now — a number of external contributors, a specific person using it, an inbound conversation — so you can tell later whether it worked.

---

## 12. Planned work

The build queue. Provenance for the borrowed ideas — which system each came from, and what was refused along with it — is in §13.

Ordering is by what unblocks the v0.3 definition of done in §9, not by what is most interesting. §12.1 shipped; §12.1a is the other half of it and is next. Items marked `[PLANNED]` are decided and scheduled; items marked `[OPEN]` are here because they are worth wanting and are not yet decided — several carry a real objection in their own text, and none of them should be built before that objection has an answer.

### 12.1 YAML job declaration `[SHIPPED]`

A room's board was built one `atrium task add` at a time, which meant the only way to show someone the workflow was a shell script of CLI calls. The job is declared instead:

```yaml
# job.yaml
name: newsroom
context: |-
  Cover the Henley/Barrow merger for Friday's edition. 800 words, house style.
tasks:
  research:
    title: Gather sources on the merger
    description: At least four independent sources, each with a working link.
    acceptance: reviewer
  draft:
    title: Write the 800-word piece
    dependsOn: [research]
    acceptance: reviewer
  factcheck:
    title: Verify every claim in the draft
    dependsOn: [draft]
    acceptance: { kind: command, command: "npm run lint:links", timeoutSeconds: 120 }
```

`atrium init ./newsroom --from job.yaml` seeds the board, the dependency graph, the acceptance rules, and `CONTEXT.md` in one command. `examples/newsroom.yaml` is a worked file. `src/jobs.ts` holds the schema, `src/yaml.ts` the parser.

The acceptance field takes either a bare kind (`acceptance: reviewer`) or the full mapping. It says `kind`, not `type`, because that is the field name everywhere else this shape appears — `Task.acceptance`, MCP's `create_task`, the CLI's `--acceptance`. A file that says `type` gets an error pointing at `kind` rather than a task that silently defaults.

Task keys in the file are local names, resolved to task ids at load time, so `dependsOn` is written by a human without knowing generated ids. Tasks are created dependency-first regardless of the order the file lists them in, keeping file order among tasks that are ready at the same moment.

Everything is validated before the room is created, and a cycle is a load error rather than a runtime deadlock. This ordering is load-bearing rather than tidy: `atrium init` refuses to run twice on a directory, so a file with a typo in it that had already created a half-built room would leave the next attempt with nowhere to go.

`[CONFIRMED]` Unknown keys are refused, with a spelling suggestion where there is an obvious one. `titel:` is a typo, and a loader that skips it produces a task with the wrong title and no complaint.

`[ASSUMPTION]` Parsed with a hand-written subset parser rather than a YAML dependency (`src/yaml.ts`). The subset needed here is small — nested maps, lists, scalars, block strings, single-line flow collections — and the zero-dependency property in §8 is worth more than full YAML conformance. Everything outside the subset throws with a line number instead of being guessed at; anchors, aliases, tags, directives, and multi-document files are refused by name. If the subset starts growing to meet real files, take the dependency; do not grow a half-parser.

Still outstanding for the v0.3 definition of done: this seeds a board, but a stranger still needs a worker to point at it. That is §12.1a.

### 12.1a Reference worker and the demo `[SHIPPED]`

`npm run demo` builds the project, seeds a room from `examples/demo/job.yaml`, and runs the newsroom job to completion — including a rejection that sends the draft back and a rework that fixes it. Nothing to configure, no key, no network.

Three processes under `examples/demo/`, all of them ordinary MCP clients:

| File | What it is |
|---|---|
| `mcp.mjs` | A hundred-line MCP client. Line-delimited JSON-RPC over `atrium serve`'s stdio; no SDK. |
| `worker.mjs` | Claims the task the runner assigned it, writes artifacts, hands in. Launched by `atrium run`. |
| `reviewer.mjs` | Reads what is waiting and accepts or rejects it. A different member, which the room enforces. |
| `check-draft.mjs` | A `command` acceptance. Copied into the room, since acceptance commands run with the room as cwd. |
| `run.mjs` | The driver. Alternates dispatch passes and review passes, and narrates. |

`[CONFIRMED]` They live in `examples/`, not `src/`, and nothing in `src/` imports them. The line that keeps Atrium from becoming an agent framework by the back door (§10, open question 6) is that a reference worker is a *demonstration of the MCP interface*, the same as any third-party agent, with no privileged access. Writing them found no case where that was inconvenient, which is the useful result.

`[CONFIRMED]` The workers are scripted, and the decision to keep them so was deliberate. They do not call a model: the prose is in the file, and the first draft carries a figure no source supports. What is *not* staged is the verdict — the reviewer applies a rule to the text (every number in the draft must appear in the sources) and the first draft fails it. Nobody told the reviewer to reject that draft.

The argument for scripted over real is that this doubles as a regression test (`src/demo.test.ts`, 9 assertions). A demo nobody checks rots quietly, and the dangerous failure is not a crash — anyone notices a crash — but the rejection silently ceasing to happen while `npm run demo` still exits 0. The test asserts the *story*: work was handed in, turned down for a reason drawn from the text, came back changed, and was accepted by a different member. A model-backed worker would demonstrate more and could be relied on for less.

`[OPEN]` Whether to add a `--model` mode later. It would make the demo honest about agent behaviour rather than only about the plumbing, at the cost of a key, a per-run charge, and a second code path. Not needed for the v0.3 goal, which is why it did not ship with this.

**One finding worth recording.** A `command` acceptance is logged against the member that *submitted* the work, since that is who triggered the run, and only the phrase "via command" in the rendered line distinguishes it from a member's judgement. Anyone auditing "did somebody approve their own work" by actor alone gets a false positive. Nothing is wrong — no judgement was involved, the exit code decided — but the log leans on a phrase to carry that, and §12.4's event stream should expose the acceptance kind as a field rather than making a consumer parse prose for it.

### 12.2 `atrium plan` `[PLANNED]`

CrewAI's `planning=True` has a model decompose the goal into a task sequence before execution. Atrium's board is the natural target for this and is currently filled by hand.

`atrium plan ./newsroom` reads `CONTEXT.md` and emits a *proposed* board as a §12.1 job file. A human reads it, edits it, and applies it. Nothing is created until they do.

`[CONFIRMED]` The proposal is never self-applied. A plan that creates its own work and then approves it is §5's failure mode wearing a different hat.

`[OPEN]` Atrium does not make model calls (§8), so `plan` cannot generate the proposal itself. Either it shells out to an operator-configured command the way the runner does, or it emits a prompt for an agent already in the room to answer through MCP. The second keeps the no-model-calls property intact and is preferred, but it is slower to demo. Decide before building.

### 12.3 `expectedOutput` on tasks `[PLANNED]`

CrewAI tasks declare an `expected_output` and validate against it with guardrails. Atrium's `acceptance` (§5) is the stronger mechanism — it is adversarial where a guardrail is self-checking — but it is currently thin on *what* is being checked: a reviewer gets a title and a description and has to infer the bar.

Add an optional `expectedOutput` to `Task`: prose stating what a finished version looks like, optionally with a JSON schema for structured work. It is carried into the reviewer's prompt through MCP and available to a `command` acceptance as an environment variable.

`[CONFIRMED]` This is a contract, not a gate. It does not accept anything on its own; it tells whoever *is* accepting what they are accepting against. Adding a self-validating guardrail path would reintroduce self-declared completion.

### 12.4 Event stream `[PLANNED]`

The log is already a typed event stream; there is no way for anything outside Atrium to subscribe to it. `atrium tail --json` for a line-delimited stream on stdout, and an SSE endpoint on the HTTP server for anything else.

This is the one place the §1 non-goal ("not an observability product") needs a stated boundary: Atrium emits the stream and charts nothing. Making the log consumable by a tool that *does* chart is the opposite of building that tool.

### 12.5 `manager` role `[PLANNED]`

CrewAI's hierarchical process has a manager agent that delegates and reviews. The mechanics already exist here — roles in §3.2, acceptance in §5 — but there is no member type whose job is fanning work out.

Add `manager` to the roles in §3.2: may create tasks, and is the default reviewer for tasks that name none.

`[ASSUMPTION]` A manager is a member like any other, not a scheduler and not a control loop. It has no privileged view of the board and cannot accept its own submissions — the rule in §5 has no exceptions and this role does not become the first one. If rooms turn out to thrash without a real scheduler (§11), that is a separate decision to make deliberately, not something to let this role quietly become.

### 12.6 `needs_input` task state `[PLANNED]`

From A2A's task lifecycle (§13.2). Atrium's states are `open → claimed → submitted → accepted | rejected`, plus `blocked`. There is no state for *the worker started and cannot continue without something*.

Today an agent in that position has three bad options: release the claim and lose its place, sit on the claim until the lease lapses, or guess. Guessing is the one that produces the plausible-but-wrong output §5 exists to catch, and it is the one an LLM will pick.

Add `needs_input`: the claim is held, a question is recorded against the task, and any other member — human or agent — can answer it. Answering returns the task to `claimed` with the answer in the log.

`[CONFIRMED]` The question and the answer are events on the log, not a message between two members. That is what keeps this inside the §2 thesis rather than reintroducing handoffs: a third agent reading the room later sees the question, the answer, and what was done with it, in order.

`[OPEN]` Whether a claim's lease should keep ticking while a task waits on a human. It should probably pause, or every overnight question loses its claim by morning — but a lease that pauses is a lease that can be held forever by a worker that crashed right after asking.

### 12.7 Fork a room from a point in its log `[SHIPPED]`

From LangGraph's time travel (§13.1), and the strongest idea in the survey.

`atrium replay 12` shows how the board looked at event 12; nothing could *continue* from it. `atrium fork ./variant ./room --at 12` now produces a new room that is the old one as it stood at event 12, and is then free to go differently. `src/fork.ts`, with `--dry-run` and `--json`.

This is the thing multi-agent systems most lack. When a run goes wrong at step 40 because of a decision at step 12, the options were re-run the whole job and hope, or hand-patch the end state. "What if the reviewer had accepted this" is now a command.

Atrium is unusually well placed here, and building it confirmed why. LangGraph branches from a checkpoint — whatever state the framework thought to persist. A fork here copies the parent's events **with their original sequence numbers and timestamps**, which matters more than it sounds: every `basedOnSeq`, every artifact version, and every prune record in those events refers to those numbers, so a fork that renumbered them would be subtly wrong everywhere. `EventLog.importHistory` exists only for this, and refuses any log that already holds an event, because interleaving copied history with new events is the way that guarantee gets lost.

Blobs for every version at or below the fork point come across too, not just the current bytes. A fork with only the current content would work and have no past: `atrium history` would list versions whose content could not be read, and `atrium diff` would refuse. The inherited history is most of the point.

**Provenance** `[CONFIRMED]`, resolving the open question that was here. The fork's log is the parent's events 1..N followed by one `room.forked` event naming the parent room, its name, the sequence forked from, and any paths whose content could not come across. It sits *after* the copied history so everything at or below N replays identically in both rooms and the divergence has a sequence number of its own. It lives in the log rather than only in `room.json` because a room that could not say what it was forked from would be telling the truth about everything except its own first cause. §3.1's isolation claim has been amended to match: rooms are isolated in operation, and a fork records where it came from, which is provenance rather than a live link.

**The world outside the room** `[CONFIRMED]`, resolving the other open question. A fork reproduces the room, not the world: the log records that an acceptance command ran, not the email that command sent, and forking cannot unsend one. This is not fixable from here — it is a property of being an out-of-process observer, the same ceiling §6 hits on cost. So it is stated rather than solved, in the command's own `--help` where somebody reads it before trusting a fork rather than after.

**Tokens are not copied** `[CONFIRMED]`. Members exist in a fork because they are in the copied history, but nobody can authenticate as one until `atrium invite` is run against it. A session token is a credential, and copying credentials to a new location as a side effect of a debugging command is not something this should do quietly.

**A pruned version cannot come back.** If a retention sweep dropped the bytes a fork needs, the fork has none either. Those paths are named in the result and in the `room.forked` event, so the new room's own history says what is missing instead of presenting a file that was never there as merely absent.

#### The finding: the brief is not in the log

Building this turned up a real hole in §3.5's claim that the log is the single source of truth. **`CONTEXT.md` is not in it.** `context.pinned` and `context.unpinned` are events, but editing the brief itself is a plain file write that nothing records.

So `atrium replay 12` cannot tell you what the brief said at event 12, and neither can a fork. A fork copies the brief *as it is now* and says which it did, because that is the only honest option available.

This is worth naming as its own defect rather than a footnote on forking. The brief is Tier 1 context (§4) — the first thing every agent reads, and therefore an input to every decision the log does record. A log that captures every consequence and not the instruction is missing the one thing that would explain the rest. Forking is simply the first feature to trip over it.

`[OPEN]` The fix is presumably a `context.written` event recording a hash of the brief, with the bytes in the same content-addressed store the artifacts use — at which point the brief is versioned exactly like everything else and `atrium history CONTEXT.md` works. The open part is whether the brief then stops being a file a person can edit in a text editor without Atrium knowing, which is currently one of the better things about it.

### 12.8 Agent cards for the roster `[OPEN]`

From A2A (§13.2). A member's capability manifest is self-reported free text plus tags (§3.2), which `list_members` hands to other agents as a lead, not a fact. A2A has standardised the shape of exactly this — a card describing what an agent can do — and 150-plus organisations have agreed to it.

Adopting that shape for the manifest costs little and buys interoperability: tooling that already reads agent cards could read an Atrium roster.

`[CONFIRMED]` If this happens, the manifest stays self-reported and everything that surfaces it keeps saying so. A standard shape makes a claim easier to parse; it does not make it true, and a card that looks official is more likely to be trusted than free text that obviously is not. That is a reason for caution, not enthusiasm.

`[OPEN]` The bigger version — exposing a whole room as an A2A endpoint, so an A2A client could work in an Atrium room the way an MCP client does — is a real interop bet and a large one. Not now, but it is the reason to get the small version's shape right.

### 12.9 Long-lived workers in the runner `[OPEN]`

From Temporal's worker model (§13.5). `atrium run` launches one process per assignment and waits for it. Temporal instead has long-lived workers polling a task queue, which is cheaper per task and is what a real deployment looks like.

For an agent this matters more than it does for a data pipeline: process startup for an agent runtime is not milliseconds, and a worker that stays up can hold a warm connection to the room.

`[OPEN]` It also breaks the thing that currently makes the runner obviously *not* an orchestrator: a per-task process cannot hold private state between tasks, so it cannot become a second source of truth by accident. A long-lived worker can. If this is built, the rule in §7.4 needs teeth beyond good intentions.

### 12.10 Named context blocks `[OPEN]`

From Letta's memory blocks (§13.3). Tier 1 context is one `CONTEXT.md` plus pinned artifacts. Letta's version is labelled blocks — persona, goals, constraints — that are individually editable and always in context.

The specific thing this would fix is the `[OPEN]` in §6 about context overflow. "The brief is too long, reject the pin" is a bad message. "The `constraints` block is full" is an actionable one, and it lets a room set a ceiling per block instead of one ceiling for everything.

`[ASSUMPTION]` Blocks would be sections of `CONTEXT.md`, addressed by heading, not a new store. A room's brief must stay a file a person can open and read in a text editor; that property is worth more than tidy addressing.

---

## 13. What other systems do

Surveyed 2026-07-30. Every item in §12 that came from somewhere else came from here, and the reasoning for what was *refused* is worth more than the reasoning for what was taken — the failure mode for a project with a thesis is absorbing the features of the systems it disagrees with until it no longer disagrees with them.

One filter applies throughout. Atrium's bet (§2) is that coordination lives in shared state, that no agent marks its own work done, and that the log is the only truth. A feature that contradicts any of those is not a feature Atrium is missing; it is the other system being a different system. A feature that addresses Atrium's *actual* weakness — that nothing here gets a stranger from clone to a working room, and that blackboard control is unsolved — is worth taking however it arrived.

| System | What it is | The idea worth taking | Refused |
|---|---|---|---|
| CrewAI | Role-based crews, Python | Declarative job config; planning before acting | Agent definitions, memory tiers, flows, LiteLLM |
| LangGraph | Stateful graph runtime | Time travel — branch from a checkpoint | Graph-as-control-flow; checkpointing (already better here) |
| A2A | Inter-agent protocol, 150+ orgs | Task lifecycle states; agent cards | Agent-to-agent messaging as the coordination primitive |
| Letta / MemGPT | Stateful memory runtime | Labelled, individually editable context blocks | Self-managing memory; archival retrieval |
| AutoGen / AG2 | Conversational multi-agent | Pluggable speaker selection as the shape of a scheduler | Group chat; conversation as the substrate |
| Temporal | Durable execution | Long-lived workers polling a queue | Nothing — it validates the design |
| Dagster | Data orchestration | Declare the asset, not the task | Scheduling, materialisation, the data-platform surface |
| OpenAI Agents SDK | Agent framework | Tracing as an exportable span stream | Handoffs, sessions, guardrails as self-validation |

### 13.1 LangGraph — time travel

LangGraph treats a run as a durable graph execution, saving state at each superstep, organised into threads. Checkpoints give it fault recovery, state history, human-in-the-loop pauses, and time travel: edit state at a checkpoint and continue down an alternative branch.

**Taken:** time travel, shipped as §12.7. This was the best idea in the survey and Atrium is better placed to do it than LangGraph is. LangGraph branches from a *checkpoint* — sampled state, whatever the framework thought to persist. Atrium has every event and, since v0.2, every artifact version's bytes, so a fork is exact reconstruction rather than approximation, down to the parent's own sequence numbers and timestamps.

Building it also paid a debt: §3.5 had been claiming replayability as the product feature since the first draft, and forking is the part of that claim nobody had collected. It also found the one place the claim is false — the brief is not in the log — which no amount of re-reading the document would have turned up.

**Refused:** the graph. A pre-declared control flow is what §2 argues against, and durable execution of a graph is a better *graph*, not an argument for having one. Also refused: checkpointing, for the reason now written into §3.5 — a room has no in-memory state to lose, so there is nothing to checkpoint.

**Worth noting against Atrium:** LangGraph's human-in-the-loop interrupt is more developed than anything here, which is what §12.6 is about.

### 13.2 A2A — task lifecycle and agent cards

An open protocol for agents from different vendors to discover each other and delegate work. Every agent publishes an Agent Card at a well-known URL describing what it does and how to reach it. Tasks move through `submitted → working → input-required → completed | canceled | failed`, and produce Artifacts. As of April 2026 it has support from 150-plus organisations including Google, Microsoft, AWS, Salesforce and IBM.

**Taken:** two things. The `input-required` state, as §12.6 — Atrium has no state for "started, stuck, needs something", and the absence pushes agents toward guessing. And the agent-card shape for the roster manifest, as §12.8, for interoperability with tooling that already reads them.

**Refused:** the premise. A2A is a *messaging* protocol — agents delegate to each other and return results. That is precisely the handoff §2 argues loses information. The convergence is worth noticing, though: A2A independently arrived at task lifecycle states and artifacts as the units that survive between agents, which is the same conclusion as the board and the working directory. Two designs reaching the same nouns from opposite directions is mild evidence the nouns are right.

**Worth noting against Atrium:** A2A has industry weight and Atrium has none. If a standard for this settles, it will be that one. §12.8's open question — exposing a room as an A2A endpoint — is the version of this project that survives that outcome.

### 13.3 Letta / MemGPT — memory blocks

Memory as a first-class part of agent state: labelled blocks (`persona`, `human`, goals, preferences) always present in context and editable by the agent through tools, with archival memory in a database retrieved on demand.

**Taken:** the labelled block, as §12.10 — not as memory, but as structure for the brief. §6 has an open question about what to do when Tier 1 context overflows, and named blocks turn a useless error into an actionable one.

**Refused:** the memory system itself, for the reason already in §12's CrewAI notes and worth restating because Letta makes the cleanest version of the argument: agent memory is largely a fix for agents not being able to see each other's state. Atrium's answer to "what does the next agent know" is that it reads the same room. Adding a memory layer on top would be solving a problem twice, and the second solution would be the lossy one.

### 13.4 AutoGen / AG2 — speaker selection

Group chat with a pluggable speaker-selection method: a function receiving the last speaker and the chat, returning who goes next, or `None` to terminate. Plus termination conditions and a retry cap on selection.

**Taken:** nothing yet, but the *shape*. §11 admits that if rooms thrash, the honest response is a lightweight scheduler rather than insisting the pattern is pure — and that contingency has never had a form. AutoGen's is the right form: a pluggable policy deciding who acts next, with an explicit termination condition, defaulting to something dumb. Atrium's equivalent is a claim policy — which idle member gets the next claimable task — currently first-come and unnamed. Writing it down as the shape the scheduler would take makes §11's contingency concrete without building anything.

**Refused:** conversation as the coordination substrate, which is the whole of AutoGen.

### 13.5 Temporal — durable execution

Deterministic replay from event history, with long-lived workers polling task queues. Increasingly the durability layer under agent frameworks that lack one — the OpenAI Agents SDK has no checkpointing, state persistence, or failure recovery, and Temporal is the standard answer.

**Taken:** the worker model, as §12.9. Atrium's runner launches a process per assignment; Temporal's workers stay up and poll. For agents that difference is larger than for data pipelines, because agent runtimes are slow to start.

**Refused:** nothing. Temporal is the system this design most resembles, arrived at independently from the same premise — that an ordered event history you can replay beats state you have to trust — and applied to a different problem. That the durable-execution layer is what agent frameworks in 2026 keep reaching for is the strongest external evidence that §3.5 is the right foundation.

**Worth noting against Atrium:** Temporal is what "the log is the truth" looks like when it is built by people who have been doing it for a decade. The gap between that and `src/log.ts` is not conceptual, it is everything else — scale, tooling, failure modes met in production.

### 13.6 Dagster — declare the asset, not the task

Data orchestration built on software-defined assets: rather than orchestrating tasks, you declare the asset that should exist and what produces it, and get lineage of actual artifacts instead of lineage of task runs. Freshness and staleness policies attach to the asset.

**Taken:** nothing yet, and this is the one that might matter most later, so it is recorded rather than queued.

Atrium's board is task-first and its artifacts are, in Dagster's terms, untracked side effects: a task says what to do, and `dependsOn` is written by hand between tasks. Dagster's inversion would have a task declare `produces: draft.md`, from which the dependency graph *derives* — draft depends on research because it reads what research wrote. Combined with the content-addressed store, that yields real lineage: which task, at which attempt, produced which version of which file.

That is a strong fit with what already exists and a large change to the core model, which is exactly the combination that should sit in a design doc for a while before anyone writes code. It is the most plausible shape of a v1 that is not just v0.3 with more commands.

`[OPEN]` Whether artifact-first tasks replace `dependsOn` or sit alongside it. Some work genuinely produces no file — a review, a decision — and a model where everything must produce an artifact would make those awkward or fake.

### 13.7 OpenAI Agents SDK — tracing

Agents with tools, handoffs, guardrails and built-in tracing that records LLM generations, tool calls, handoffs and guardrail events across a run.

**Taken:** the shape of §12.4. Tracing should export as spans in a format existing tools already read — OpenTelemetry — rather than a bespoke JSON stream. Emitting the stream is in scope; charting it is not (§1).

**Refused:** handoffs, for the usual reason. And guardrails, which is worth separating carefully from acceptance because they look similar and are opposites: a guardrail is a check the agent runs on itself, in parallel with its own execution, and passing it is self-certification. Acceptance (§5) is a check performed by something that is not the agent, and no configuration makes the submitter the approver. §12.3's `expectedOutput` is deliberately a contract for whoever *is* accepting, not a self-validation step — that distinction is the project.
