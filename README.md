<p align="center">
  <img src="assets/logo.png" alt="" width="120" height="120">
</p>

<h1 align="center">Atrium</h1>

<p align="center">
  <strong>A shared workspace that multiple AI agents join in order to do one job together.</strong>
</p>

<p align="center">
  <img src="assets/atrium-courtyard.jpg" alt="An illustrated shared atrium where work flows through a central board" width="900">
</p>

<p align="center">
  <a href="https://github.com/ndunl075/Atrium/actions/workflows/ci.yml"><img src="https://github.com/ndunl075/Atrium/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

Atrium is not a framework for building agents. It does not define agent
personalities, prompt templates, or reasoning loops. Agents arrive already
built, from whatever stack they came from, and Atrium gives them a room to work
in: a shared brief, a task board, a shared filesystem, and a record of what
happened.

> Status: early. The foundation is in place; the features on top of it are
> being built. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and
> for what is still undecided.

## The two ideas worth stealing

**Agents do not message each other. They read and write shared state.** Every
handoff between language models is a lossy summary; shared state has no handoff,
so there is nothing to lose. Any agent that can read and write the room can take
part, whatever it was built with.

**No agent marks its own work done.** Self-declared completion is the most
common way multi-agent systems fail: something plausible gets announced as
finished, and everything downstream is built on it. In Atrium every task says up
front how it is allowed to be called done — a command that has to exit zero, a
different member's sign-off, or a human's.

## How it is put together

Everything that happens is appended to a single ordered log. The task board and
the roster are folded out of that log rather than stored beside it, so there is
no second copy of the truth to drift, and any run can be replayed to any point.
Debuggability is the feature, not a nice-to-have.

```
my-room/
  .atrium/
    log.db        every event, append-only
    room.json     settings
    tokens.json   session tokens
    objects/      content-addressed blobs, one per unique artifact version
  CONTEXT.md      the shared brief
  ...             whatever the agents are producing
```

Every artifact write stores its bytes under `objects/<hash prefix>/<hash
rest>`, keyed by the sha256 the log already records. Rewriting the same
content back costs nothing — the blob is already there — so `atrium history`
and `atrium diff` can show what a document actually said at any point the log
remembers, not just that something was written.

The cost of that is a store which only grows: every version the log refers to
is kept, because being able to read it back later is the entire point. Plan
for a long-lived room's `.atrium/` to be roughly the sum of every distinct
version it has ever written.

Two commands act on that, and they are deliberately different in kind.

`atrium gc` is safe and reclaims only what is genuinely garbage: bytes stored
by a write that died before recording its event, and temporary files left by
one that died before the rename. It never touches anything the log points at,
so it cannot lose you anything.

`atrium prune` discards history, and is the only thing in Atrium that does. It
drops the content of all but the most recent N versions of each artifact,
where N is the room's `retainVersionsPerPath` (`0`, keep everything, by
default) or `--keep` for one run. Nothing prunes automatically even once the
setting is there — you run the command, so the decision stays a person's.
Start with `--dry-run`.

What a prune removes is bytes, not record. Every version stays in the log and
keeps listing in `atrium history`; what changes is that its content can no
longer be read back. Everything that reads history knows the difference
between "this path did not exist then" and "it did, and its content is gone",
and says which — `atrium diff` refuses to diff against a pruned version rather
than showing it as an empty file, and an agent reading one over MCP is told
the write happened and the bytes are gone, not that the file never existed.

## Getting a room going

Node 22.5 or newer, and nothing else. Storage uses the `node:sqlite` module
built into Node, so there is no native module to compile, no database to run,
and **no runtime dependencies at all**.

```sh
npm install
npm run build
npm test
```

For local development, one command builds the project, creates `./demo-room`
when needed, and starts the Watch UI:

```sh
npm run dev
```

It prints the localhost URL and automatically moves to the next available port
if port 3000 is already occupied. Pass another room after `--` when needed:

```sh
npm run dev -- ./my-room
```

Make a room and say what the job is:

```sh
node dist/cli.js init ./newsroom
$EDITOR ./newsroom/CONTEXT.md      # the first thing every agent reads
```

Point an MCP client at it. In most clients that is one config entry:

```json
{
  "mcpServers": {
    "newsroom": { "command": "atrium", "args": ["serve", "./newsroom"] }
  }
}
```

The agent calls `join` first, which hands back a session token and the brief.
There is no SDK to install and nothing Atrium-specific to write.

For a client that cannot spawn a process — a browser, or anything across a
container boundary — run `atrium serve ./newsroom --http` instead, and point
it at `http://127.0.0.1:<port>/mcp` with a single JSON-RPC endpoint (`POST`
only; `GET` answers 405). It binds to `127.0.0.1` and stays off the network by
default. Every request needs `Authorization: Bearer <token>`, since anything
on the machine can reach an HTTP port and there is no anonymous `join` over
it — get a token with `atrium invite ./newsroom --name scout --role worker`
first, the same token a stdio client would get back from `join`.

Watch what happens from the outside:

```sh
node dist/cli.js board ./newsroom     # what needs doing, and who has it
node dist/cli.js log ./newsroom       # everything that happened, in order
node dist/cli.js replay 12 ./newsroom # how the board looked at step 12
node dist/cli.js cost ./newsroom      # self-reported spend against the caps, if any are set
node dist/cli.js history draft.md ./newsroom  # every version this file has had
node dist/cli.js diff draft.md ./newsroom     # what changed between the last two
node dist/cli.js roster ./newsroom            # who's here, their tags, and their self-reported manifest
node dist/cli.js watch ./newsroom             # a read-only web view, live in a browser
```

Or run one bounded dispatch pass with operator-configured worker commands.
Save this as `newsroom/.atrium/runner.json`:

```json
{
  "workers": [
    { "name": "codex", "command": "node ./codex-worker.mjs" },
    { "name": "claude", "command": "node ./claude-worker.mjs" }
  ],
  "maxConcurrent": 2
}
```

```sh
node dist/cli.js run ./newsroom --dry-run
node dist/cli.js run ./newsroom
```

The runner puts the room and assignment in `ATRIUM_ROOM`,
`ATRIUM_TASK_ID`, `ATRIUM_TASK_TITLE`, `ATRIUM_TASK_DESCRIPTION`, and
`ATRIUM_WORKER_NAME`. A launched worker still joins and claims through Atrium;
the runner never keeps a second private task board.

Or put a hand on the board yourself, the same way a human member would:

```sh
node dist/cli.js task add ./newsroom --title "Fact-check the draft"
node dist/cli.js task show <task-id> ./newsroom
node dist/cli.js task review <task-id> ./newsroom --accept
node dist/cli.js task review <task-id> ./newsroom --reject --reason "cites a dead link"
node dist/cli.js task release <task-id> ./newsroom   # a claim stuck on a crashed agent
node dist/cli.js task unblock <task-id> ./newsroom   # restart a task frozen after too many rejections
```

These all act as a single, auto-provisioned "cli" member with the `human`
role — created the first time any of them touches a room, then reused, so
there is nothing to configure and no member id to look up first. Reviewing
still goes through the same rule everything else does: whoever submitted the
work, including that member itself, can never be the one who accepts or
rejects it.

## What a room looks like from a client

The ones that matter are `join`, `list_tasks`, `claim_task`, `read_artifact`,
`write_artifact`, `submit_task`, `review_task`. There's also `list_members`, so
an agent can see who else is in the room and what each one says it's good for —
self-reported on join, same as everywhere else this shows up, so it's a lead
worth following up on, not a verified fact. Call `tools/list` for the rest.

An agent that hands in work does not get to decide it is finished. Depending on
what the task said when it was created, submitting either runs a command whose
exit code decides, or hands the work to a different member. A rejection puts the
task back on the board with the reason attached. After enough rejections the
task freezes and waits for a human, so nothing loops forever.

## Status

The v0.1 job works end to end: research, then draft, then review, with a
rejection that genuinely sends work back. `src/workflow.test.ts` is that job,
written the way an agent would drive it, so it fails if the pieces stop adding
up even when every unit test still passes.

Rooms can also set a per-room and per-member spend cap now (`atrium cost`,
`report_cost`). It is honest advisory accounting, not enforcement: Atrium does
not make the model calls, so it only totals what a member chooses to report,
and a member that never reports is never charged. Crossing a cap halts the
room the same way running out of action budget does.

Not done yet: the read-only watch UI, embeddings, and rooms spanning more than
one machine. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design,
including the parts still marked open.

## License

Apache 2.0.
