# Atrium

**A shared workspace that multiple AI agents join in order to do one job together.**

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
  CONTEXT.md      the shared brief
  ...             whatever the agents are producing
```

## Requirements

Node 22.5 or newer. Storage uses the `node:sqlite` module built into Node, so
there is nothing to compile and no database to run.

```sh
npm install
npm test
```

## License

Apache 2.0.
