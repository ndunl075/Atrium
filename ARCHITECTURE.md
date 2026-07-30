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

### Not built

| Capability | Status | Section |
|---|---|---|
| Reference worker under `examples/` | `[PLANNED]` — next | §12.1 |
| `atrium plan` — proposed board from the brief | `[PLANNED]` | §12.2 |
| `expectedOutput` contract on tasks | `[PLANNED]` | §12.3 |
| Event stream for external observability | `[PLANNED]` | §12.4 |
| `manager` role | `[PLANNED]` | §12.5 |
| Embeddings / semantic search | Deliberately deferred | §4 |
| Multi-machine rooms | Deliberately deferred | §9 |
| Enforced (non-advisory) cost caps | `[OPEN]` — may be unsolvable here | §6 |

### Known gaps that are not features

- **Not published to npm.** The README tells clients to run `atrium serve`, but the only working path today is clone → `npm install` → `npm run build` → `node dist/cli.js`. This is the single largest barrier to anyone using the project.
- **No runnable demo.** The rejection loop is the differentiating idea and it is currently only visible to someone reading `src/workflow.test.ts`. §12.1 shipped the half of the fix that seeds a board from `examples/newsroom.yaml`; the reference worker that drives it is still missing.
- **The runner has nothing to run.** `atrium run` shells out to operator-written worker commands that this repo does not ship, so the "make it actually go" path requires the user to first build the thing that uses it.

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

**This is not met.** Every mechanism it names exists and is tested, but a stranger cannot reach it: the package is not on npm, and there is no shipped job a person can run without first writing their own workers. `src/workflow.test.ts` proves the workflow to a reader of the test suite, which is not the same audience. §12.1 exists to close exactly this gap, and it is the reason it is first in the queue rather than the most interesting item.

### v0.3 target

**Definition of done for v0.3:** a stranger runs one command against a fresh clone and watches an agent's work get rejected and sent back, without writing any configuration.

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

**Open source is distribution, not strategy.** Stars are not adoption and adoption is not revenue. If this is a credibility play, define what a win looks like now — a number of external contributors, a specific person using it, an inbound conversation — so you can tell later whether it worked.

---

## 12. Planned work

Five items, in build order. Several are adapted from CrewAI, which is worth being explicit about, along with the filter used.

CrewAI solves a different problem than Atrium and solves it in the opposite direction: it *defines* agents (role, goal, backstory) and passes each task's output forward as the next task's context. Atrium takes pre-built agents and refuses to pass messages at all. A straight feature port would make this a worse CrewAI. What is worth taking is the parts that address Atrium's actual weakness — nothing here gets a stranger from clone to a working room — without touching the thesis in §2.

**Deliberately not taken, and why:**

- **Agent definitions.** The moment Atrium has an `Agent` class with a role and a backstory, the §1 non-goal is gone and the "any agent from any stack" claim goes with it.
- **Memory tiers (short-term / long-term / entity).** CrewAI needs three memory systems largely *because* its agents cannot see each other's state; memory is the patch for message-passing being lossy. Atrium has shared artifacts, `CONTEXT.md`, and search. Importing this would be importing a fix for a problem this design already avoids.
- **Flows (start / listen / router steps).** Imperative orchestration with a state machine on top — message passing with more ceremony. The board's `dependsOn` graph is the declarative equivalent and is the better fit for a blackboard.
- **Model provider integration (LiteLLM and similar).** Atrium does not make model calls. That is what makes the zero-runtime-dependency claim true, and it is load-bearing for §6's honesty about cost.
- **Runtime checkpointing.** CrewAI added SQLite checkpoints to resume long-running workflows. The append-only log already does this strictly better. Nothing to take — but §3.5 should claim it, because it currently does not.

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

Still outstanding for the v0.3 definition of done: this seeds a board, but a stranger still needs a worker to point at it. A shipped reference worker under `examples/` is the remaining half.

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
