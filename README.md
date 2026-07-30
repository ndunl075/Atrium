<p align="center">
  <img src="assets/logo.png" alt="Atrium logo" width="120" height="120">
</p>

<h1 align="center">Atrium</h1>

<p align="center">
  <strong>Local-first coordination infrastructure for multiple AI agents working in a shared room.</strong>
</p>

<p align="center">
  <a href="https://github.com/ndunl075/Atrium/actions/workflows/ci.yml"><img src="https://github.com/ndunl075/Atrium/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

<p align="center">
  <img src="assets/atrium-courtyard.jpg" alt="An illustrated shared atrium where work flows through a central board" width="900">
</p>

Atrium provides a shared brief, task board, filesystem, member roster, and
ordered event history for teams of AI agents. It is compatible with agents from
different frameworks because coordination happens through shared room state
rather than a framework-specific agent runtime.

Atrium does not define agent personalities, prompts, reasoning loops, or model
providers. Agents arrive with those capabilities and connect to a room through
MCP or a process adapter.

> **Development status:** Alpha (`0.3.0`). Room coordination, task acceptance,
> artifact history and lineage, replay, forking, the Watch UI, event
> streaming, and the optional runner are functional. Interfaces may still
> change.

## Design principles

### Shared state

Agents coordinate by reading and updating the same room state. This avoids
repeated point-to-point summaries and allows agents from unrelated runtimes to
work together.

### Independent acceptance

An agent cannot approve its own submission. Each task defines its acceptance
mechanism in advance:

- A command that must exit successfully.
- Approval from another reviewer.
- Approval from a human.
- Optional unchecked acceptance when explicitly permitted by room policy.

### Replayable history

Every state change is appended to one ordered event log. The task board and
member roster are projections of that log, allowing Atrium to reconstruct the
room at an earlier sequence number and explain how the current state was
reached.

## Capabilities

- Shared room context through `CONTEXT.md` and pinned artifacts, with every
  version of the brief recorded in the log.
- Dependency-aware tasks with atomic claims and expiring claim leases.
- Artifact leases that prevent concurrent writers from silently overwriting
  one another.
- Command, reviewer, and human acceptance policies.
- Worker, reviewer, manager, and human roles.
- Versioned artifact content with history and unified diffs.
- Ordered event history and point-in-time board replay.
- Forking a room from any point in its log, with its history and artifact
  versions intact.
- MCP access over stdio or authenticated HTTP.
- Read-only Watch UI with live task, member, artifact, and agent-activity
  views.
- Optional process runner for bounded worker dispatch, or long-lived workers
  that claim their own work.
- A `needs_input` state, so a blocked worker can ask instead of guessing.
- Event streaming over stdout or Server-Sent Events, for external tooling.
- Artifact lineage: which task, at which attempt, produced which version.
- Advisory per-room and per-member cost accounting.
- Storage verification, garbage collection, and explicit history pruning.

## Requirements

- Node.js 22.5 or newer.

Atrium uses the `node:sqlite` module included with Node. It has no runtime npm
dependencies and does not require a separate database server.

## Installation

```sh
npm install -g @ndunl075/atrium
atrium --version
```

The package is scoped because `atrium` on npm is an unrelated placeholder
package. The command it installs is still `atrium`.

From a source checkout instead:

```sh
npm install
npm run build
npm test
```

Commands in this README use `node dist/cli.js`, which is what works from a
checkout. If you installed the package, use `atrium` in their place.

## Local development

Start a local demo room and the Watch UI with one command:

```sh
npm run dev
```

The command:

1. Builds Atrium.
2. Creates `./demo-room` if it does not exist.
3. Selects an available localhost port.
4. Prints the URL for the Watch UI.

To use another room:

```sh
npm run dev -- ./my-room
```

## See it work

```sh
npm install
npm run demo
```

That builds the project, creates a room, and runs a four-task newsroom job to
completion using the reference workers in `examples/demo/`. No API key, no
network, about ten seconds.

The part worth watching is round 2:

```text
[scout]  claimed "Write the piece"
[scout]  wrote draft.md
[scout]  handed in "Write the piece" — waiting on somebody else to accept it
[editor] REJECTED "Write the piece" — "400" does not appear in sources.md, so
         nothing supports it: "The merger is expected to result in around 400
         job losses.". Cite it or take it out.

[scout]  claimed "Write the piece" (attempt 2)
[scout]  previous attempt was rejected: "400" does not appear in sources.md ...
[scout]  wrote draft.md
[editor] accepted "Write the piece"
```

`scout` did not get to decide its draft was finished. `editor` could not have
accepted its own work either — the room refuses that outright, whatever role a
member holds. And the rejection reason travelled through the board, not
through a message: when `scout` picked the task back up, it read the reason
out of the room.

Afterwards the room is still there to inspect:

```sh
node dist/cli.js diff draft.md ./demo-newsroom   # what changed after the rejection
node dist/cli.js log ./demo-newsroom             # everything that happened, in order
node dist/cli.js watch ./demo-newsroom           # the same thing in a browser
```

The demo workers are scripted — they do not call a model. They prove the
coordination works; they prove nothing about how well real agents behave in a
room. The reviewer's rejection is not staged, though: it applies a rule to the
text (every number in the draft must appear in the sources) and the first
draft fails it.

## Quick start

Create a room:

```sh
node dist/cli.js init ./newsroom
```

Edit the shared brief:

```sh
$EDITOR ./newsroom/CONTEXT.md
```

Start the read-only Watch UI:

```sh
node dist/cli.js watch ./newsroom
```

The Watch UI displays the brief, board, artifacts, activity history, and a live
agent floor that reflects member and task states.

## Declare a job in one file

Building a board one `task add` at a time is fine for a task or two. To set up
a whole job at once, describe it in a job file and seed the room from that:

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

```sh
node dist/cli.js init ./newsroom --from job.yaml
```

That writes `CONTEXT.md`, creates every task, wires up the dependency graph,
and sets each task's acceptance rule. `examples/newsroom.yaml` is a complete
worked file to start from.

Task names in the file are local labels used by `dependsOn`; Atrium resolves
them to task ids as it creates them, so tasks can be listed in any order.
`acceptance` takes either a bare kind (`reviewer`, `human`, `none`) or a
mapping — `command` needs the full form because it needs a command to run.

The file is read once, at `init`. After that the room's event log is the
truth, so editing the file later does not change a room already created from
it. Unknown keys are rejected rather than ignored, and the whole file is
validated before the room is created, so a typo leaves nothing half-built
behind.

## Connect an MCP client

### Local stdio transport

Add the room as an MCP server in the client configuration:

```json
{
  "mcpServers": {
    "newsroom": {
      "command": "atrium",
      "args": ["serve", "./newsroom"]
    }
  }
}
```

The agent calls `join` first and receives a session token and the room brief.
No Atrium-specific SDK is required.

### HTTP transport

For clients that cannot launch a local process:

```sh
node dist/cli.js serve ./newsroom --http
```

The server exposes a JSON-RPC MCP endpoint at:

```text
http://127.0.0.1:<port>/mcp
```

HTTP requests require a bearer token. Create one before connecting:

```sh
node dist/cli.js invite ./newsroom --name scout --role worker
```

Atrium binds to `127.0.0.1` by default. Binding to another interface can expose
room content and should be done deliberately.

## Operate a room

### Inspect state

```sh
node dist/cli.js open ./newsroom
node dist/cli.js board ./newsroom
node dist/cli.js roster ./newsroom
node dist/cli.js artifacts ./newsroom
node dist/cli.js log ./newsroom
node dist/cli.js cost ./newsroom
```

### Inspect history

```sh
node dist/cli.js replay 12 ./newsroom
node dist/cli.js history draft.md ./newsroom
node dist/cli.js diff draft.md ./newsroom
```

### The brief is versioned too

`CONTEXT.md` is a plain file you can edit in any editor — nothing about that
changed. What changed is that its content is recorded: every version is stored
under its hash and appended to the log, so a replay or a fork can recover what
an agent was actually told, not just what it did afterwards.

An edit made in your editor is captured the next time anybody joins the room,
which is the moment before a member is handed the brief to work from. Until
then the file and the log disagree, and `atrium verify` says so.

```sh
node dist/cli.js context --history ./newsroom   # every recorded version
node dist/cli.js context --at 12 ./newsroom     # what the brief said back then
node dist/cli.js context --record ./newsroom    # capture an edit right now
```

### Follow a room from another tool

```sh
node dist/cli.js tail ./newsroom --json          # one JSON object per event
node dist/cli.js tail ./newsroom                 # the same, as sentences
```

Each event carries its own payload alongside the rendered line, so a tool
branches on fields while a person reads the sentence. `atrium serve --http`
also exposes the same stream as Server-Sent Events at `/events`, authenticated
with the same bearer token as the MCP route.

Atrium emits the stream and charts nothing; pointing something that does chart
at it is the intended use.

### Trace a file back to the work that made it

```sh
node dist/cli.js lineage draft.md ./newsroom
```

`history` says what changed and when. `lineage` says which task each version
came out of, and which attempt — so the draft that was rejected reads
differently from the one that replaced it:

```text
#18  written by scout  Write the piece
#22  written by scout  Write the piece (attempt 2)
```

Nothing records this; it is derived from the log, so it works on rooms created
before the feature existed. A task can also declare `produces: [draft.md]` to
say up front what it means to write.

### Fork a room and try it differently

`replay` shows how the board looked at a point in the log. `fork` continues
from it:

```sh
node dist/cli.js fork ./variant ./newsroom --at 17 --dry-run
node dist/cli.js fork ./variant ./newsroom --at 17
```

The new room is the old one exactly as it stood at event 17 — same board,
same files, same members, same sequence numbers — and is then free to go
differently. Its log is the parent's events up to that point followed by one
`room.forked` event, so everything below the fork replays identically in both
rooms and the divergence has a sequence number.

Every artifact version at or below the fork point comes across too, so
`history` and `diff` work over the inherited past rather than starting blank.

Two limits, stated up front because a fork is only useful if you know what it
is not:

- **It reproduces the room, not the world.** The log records that an
  acceptance command ran; it does not record the email that command sent, and
  a fork cannot unsend one.
- **It cannot bring back pruned content.** Paths whose bytes a retention sweep
  dropped are named in the output and in the fork's own log. The same applies
  to the brief, which is otherwise rewound along with everything else.

Session tokens are not copied. Members exist in the fork's history, but nobody
can authenticate as one until you run `atrium invite` against it.

### When a worker gets stuck

A worker that cannot finish without something — an ambiguity in the brief, a
decision only a person can make — says so with `ask_for_input` instead of
guessing. Guessing is what produces plausible, wrong work, and it is what an
LLM will do if the only alternatives are abandoning the task or sitting on it.

The task moves to `needs_input` and keeps its claim, which stops expiring, so
asking costs nothing even if the answer takes until tomorrow. Answer it with
`atrium task answer`, or from another agent with `provide_input`. Whoever
asked cannot answer their own question; if they work it out themselves they
withdraw it.

The question and the answer both go on the board, not into a message, so a
worker picking the task up later reads the answer out of the room.

### Administer tasks

```sh
node dist/cli.js task add ./newsroom --title "Fact-check the draft"
node dist/cli.js task show <task-id> ./newsroom
node dist/cli.js task review <task-id> ./newsroom --accept
node dist/cli.js task review <task-id> ./newsroom --reject --reason "Citation is unavailable"
node dist/cli.js task release <task-id> ./newsroom
node dist/cli.js task unblock <task-id> ./newsroom
node dist/cli.js task answer <task-id> ./newsroom --text "800 words, not 1500"
```

Administrative task commands use an automatically provisioned CLI member with
the `human` role. The submitter of a task cannot review the same submission,
including when the submitter is the CLI member.

## Optional worker runner

Atrium can perform one bounded dispatch pass using operator-defined worker
commands. Create `newsroom/.atrium/runner.json`:

```json
{
  "workers": [
    {
      "name": "codex",
      "command": "node ./codex-worker.mjs"
    },
    {
      "name": "claude",
      "command": "node ./claude-worker.mjs"
    }
  ],
  "maxConcurrent": 2
}
```

Review the dispatch plan:

```sh
node dist/cli.js run ./newsroom --dry-run
```

Launch the configured workers:

```sh
node dist/cli.js run ./newsroom
```

Each process receives:

- `ATRIUM_ROOM`
- `ATRIUM_TASK_ID`
- `ATRIUM_TASK_TITLE`
- `ATRIUM_TASK_DESCRIPTION`
- `ATRIUM_WORKER_NAME`

The runner starts workers but does not maintain a separate task board. A worker
must still join the room and claim its assigned task through Atrium.

## MCP tool surface

Primary tools include:

- `join`
- `get_context`
- `list_members` — pass `cards: true` for A2A-shaped capability cards
- `list_tasks`
- `claim_task`
- `read_artifact`
- `write_artifact`
- `submit_task`
- `review_task`
- `ask_for_input` — say you are stuck rather than guessing
- `provide_input` — answer somebody else's question
- `withdraw_question`
- `post_note`
- `read_log`

Use `tools/list` from the MCP client for the complete tool set.

## Storage model

Each room is a normal directory:

```text
my-room/
  .atrium/
    log.db        append-only event log
    room.json     room settings
    tokens.json   session tokens
    objects/      content-addressed artifact versions
  CONTEXT.md      shared room brief
  ...             project artifacts
```

Artifact content is stored by SHA-256 hash. Identical content is stored once,
while each write remains represented in the event history.

The object store grows as new artifact versions are recorded. Atrium provides
two separate maintenance operations:

- `atrium gc` removes unreferenced blobs and abandoned temporary files. It does
  not remove content referenced by the event log.
- `atrium prune` deliberately removes older artifact content according to a
  retention policy. Run it with `--dry-run` before applying changes.

Pruning removes stored bytes, not historical records. History continues to show
that a version existed, while reads and diffs report that its content is no
longer retained.

## Current scope

Atrium currently supports local, single-machine rooms. The core research,
draft, review, rejection, and resubmission workflow is covered end to end by
`src/workflow.test.ts`.

Cost accounting is advisory because Atrium does not make model calls directly.
Members or adapters must report their usage. A process that does not report
costs cannot be included in Atrium's totals.

Distributed rooms, semantic retrieval, and enforced model-level cost metering
are not currently implemented.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design details and open
decisions — section 0 lists what is built versus planned, and section 12
covers what is being built next.

## License

Apache License 2.0.
