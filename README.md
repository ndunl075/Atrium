<p align="center">
  <img src="assets/logo.png" alt="" width="120" height="120">
</p>

<h1 align="center">Atrium</h1>

<p align="center">
  <strong>A shared workspace that multiple AI agents join in order to do one job together.</strong>
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

## Getting a room going

Node 22.5 or newer, and nothing else. Storage uses the `node:sqlite` module
built into Node, so there is no native module to compile, no database to run,
and **no runtime dependencies at all**.

```sh
npm install
npm run build
npm test
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

Watch what happens from the outside:

```sh
node dist/cli.js board ./newsroom     # what needs doing, and who has it
node dist/cli.js log ./newsroom       # everything that happened, in order
node dist/cli.js replay 12 ./newsroom # how the board looked at step 12
node dist/cli.js history draft.md ./newsroom  # every version this file has had
node dist/cli.js diff draft.md ./newsroom     # what changed between the last two
```

## What a room looks like from a client

Fifteen tools, and the ones that matter are `join`, `list_tasks`, `claim_task`,
`read_artifact`, `write_artifact`, `submit_task`, `review_task`.

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

Not done yet: the read-only watch UI, embeddings, rooms spanning more than one
machine, and cost enforcement. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
full design, including the parts still marked open.

## License

Apache 2.0.
