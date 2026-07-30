# Changelog

Notable changes to Atrium. Dates are the day the change landed on `main`.

This project is pre-1.0 and has never been published to a registry, so the
version number tracks the shape of the API rather than promising anything to
an installed base. Breaking changes are listed first in each release and are
called breaking even when nothing could have been broken yet — the point of
writing them down is that the next person reading this cannot tell, from the
code alone, which changes were deliberate.

## 0.3.0 — 2026-07-30

The first release intended to be installable. Everything below was previously
reachable only from a source checkout.

### Breaking

- **The package is now `@ndunl075/atrium`.** The bare name `atrium` on npm is
  an unrelated placeholder package, so this publishes under a scope. The
  command it installs is still `atrium`.
- **`TaskState` has a new member, `needs_input`.** Anything exhaustively
  switching on task state will not compile until it handles the new case, and
  anything filtering a board by state will now see tasks it has not seen
  before. This is deliberately not additive-only: a caller that silently
  ignored the new state would show a board that is missing work.
- **`MemberRole` has a new member, `manager`.** Same reasoning.
- **The first `join` on a room costs two log events rather than one.** The
  extra event records the brief (see below). Rooms with a tight `actionBudget`
  will reach it one action sooner.
- **`gcBlobs` now treats `context.written` hashes as referenced.** A sweep run
  by 0.2.0 against a room written by 0.3.0 would delete every recorded version
  of that room's brief and report it as reclaimed space.

### Added

- **`atrium init --from job.yaml`** seeds a room's brief, tasks, dependency
  graph and acceptance rules from one file. Parsed by a hand-written YAML
  subset, so the project still has no runtime dependencies.
- **`npm run demo`** runs a four-task job end to end, including a rejection
  that sends work back, using reference MCP workers under `examples/demo/`.
  No key, no network. It doubles as a regression test.
- **`atrium fork <target> --at <seq>`** creates a new room that is an existing
  one as it stood at a point in its log, with the history and artifact
  versions intact, and is then free to go differently.
- **The room's brief is recorded in the log.** `CONTEXT.md` is still a plain
  file anybody can edit; its content is captured when somebody joins, so
  `atrium replay` and `atrium fork` can recover what an agent was actually
  told. `atrium context --record`, `--history` and `--at <seq>`.
- **`needs_input`**, so a worker that cannot continue can say so instead of
  guessing. It keeps its claim, which stops expiring while it waits.
  `ask_for_input`, `provide_input`, `withdraw_question`, `atrium task answer`.
- **`atrium tail`** and an SSE endpoint at `/events` stream the log to
  external tooling. Each event carries its payload alongside the rendered
  sentence.
- **`atrium lineage <path>`** says which task, at which attempt, produced each
  version of a file. Derived from the log, so it works on rooms created before
  this release.
- **`Task.produces`** declares the paths a task means to write. Optional, and
  alongside `dependsOn` rather than replacing it: some work legitimately
  produces no file.
- **`Task.expectedOutput`** declares what a finished result should look like,
  for whoever is accepting it. A contract, never a gate.
- **A `manager` role**: a reviewer that can also release somebody else's stuck
  claim. It cannot un-freeze an escalated task; only a human can.
- **Long-lived workers.** A runner worker with `"poll": true` is started once
  and claims its own work, and is handed no assignment at all.
- **Agent cards.** `list_members` with `cards: true`, and
  `atrium roster --cards`, emit A2A-shaped capability cards. Every card is
  marked self-reported, because a standard shape makes a claim easier to parse
  and no more true.
- **Named context blocks.** The brief's `##` sections are reported largest
  first, and a refused pin now names the largest parts of the brief.

### Fixed

- **Opening a room could fail with "database is locked."** `PRAGMA
  busy_timeout` was set one line *after* `PRAGMA journal_mode = WAL`, and
  changing the journal mode takes a lock — so the one statement most likely to
  meet a lock ran with no timeout in effect. Several processes sharing a room
  is the normal case here, not an exceptional one, so this took down whatever
  was opening the room: a worker, or `atrium serve` dying before it answered a
  single message.
- **Two processes writing the same room file could collide.** Every atomic
  write went through the same `<file>.tmp` name, so two writers raced: the
  first rename took the file and the second failed with `ENOENT`. The
  write-then-rename dance is meant to make an update atomic and this made it
  less safe than writing in place. Temporary names now carry the process id.
- **A concurrent join could silently drop another member's session token.**
  The token file was read, changed and rewritten with no lock, so the second
  writer overwrote the first. The member appeared on the roster with a
  credential that no longer existed, which surfaced much later as "that
  session token is not valid". The update now happens inside the log
  transaction, which already holds a lock that spans processes.
- **`gcBlobs` would have deleted every recorded version of a room's brief.**
  It collected referenced hashes from `artifact.written` alone, and the
  brief's blob is the one object in the store no artifact event mentions.
- **`isRole` carried its own hand-written list of role names**, so adding a
  role to the type left the runtime check silently refusing it — a green build
  and every join with the new role failing. Roles now go through a registry
  the compiler checks.
- **A demo worker died outright if its saved session token no longer worked.**
  A token file can go stale in ordinary use — the room was recreated, or
  forked, since forks deliberately do not copy tokens. It now says so and
  joins fresh.
- **CI built after it tested**, so the test that runs the shipped demo had
  nothing built to run against.

## 0.2.0 — 2026-07-29

### Breaking

- **`releaseLease` no longer takes a `reason` argument.** It used to accept
  `"voluntary" | "expired"` from the caller, which meant a forced release
  could be recorded as voluntary and the log had no way of knowing better. The
  reason is now derived: `"voluntary"` when the holder releases its own lease,
  the new `"forced"` when a human takes somebody else's, and `"expired"` only
  where it always came from — `acquireLease` noticing a lapse. Callers passing
  three arguments are unaffected; a caller passing a fourth now gets a type
  error in TypeScript and is ignored in JavaScript.
- **`"lease.released"` events can carry `reason: "forced"`.** Anything
  exhaustively matching on that field needs a branch for it. `memberId` is
  still the member who *held* the lease; `event.actor` is who caused the
  release, and the two differ exactly when the reason is `"forced"`.

### Added

- `atrium config` reads and changes room settings, with per-setting validation,
  so `.atrium/room.json` no longer has to be hand-edited. Turning on
  `allowUncheckedAcceptance`, or lowering `actionBudget` below the events a
  room has already recorded, are allowed but never silent.
- `commandTimeoutSeconds` on the room config, and `timeoutSeconds` on a
  `command` acceptance, replacing a hardcoded sixty seconds that no caller
  could change. A timed-out command now says which setting produced the limit
  and how to raise it, so a timeout cannot be misread as a test failure.
- `atrium lease release <path>` clears a lease stuck on a crashed agent
  instead of waiting out its expiry. `atrium leases` still works and now also
  answers to `atrium lease list`.
- `atrium watch` serves a read-only web view of a room: board, roster,
  artifacts, the Tier 1 brief with its pinned files, artifact diffs, and a live
  event stream over SSE. It runs on its own port and never mutates the room.
- `atrium roster` and the `list_members` MCP tool show who is in a room and
  the manifest each member self-reported on join.
- `atrium context --pin` / `--unpin` and the `unpin_artifact` MCP tool, so the
  shared brief can be curated rather than only read.
- `atrium leases` and the `list_leases` MCP tool.
- `atrium prune` and `retainVersionsPerPath` drop the content of old artifact
  versions. Nothing prunes automatically. `atrium gc` reclaims only unreachable
  blobs and cannot lose anything the log points at.

### Changed

- Reading a past artifact version now reports three outcomes rather than two:
  present, absent, and pruned. `contentStateAt` is the honest form;
  `contentAt` remains as a convenience that cannot tell the last two apart.
  A diff against a pruned version refuses instead of rendering it as an empty
  file, and MCP's `read_artifact` reports `exists: true, pruned: true` rather
  than telling an agent the write never happened.
- `Room.open` merges stored settings over `DEFAULT_ROOM_CONFIG`, so a room
  written before a setting existed reads back that setting's default instead
  of `undefined` behind a type that promised a number.
- The MCP server reports the package's real version in its handshake. It was a
  string literal that had already drifted a release behind.

### Fixed

- Two artifact versions differing only by a trailing newline are no longer
  reported as differing with an empty patch. Diffs now carry git's
  `\ No newline at end of file` marker.
- The line diff trims common head and tail before building its table and
  refuses to build one past a fixed cell budget, so a large artifact degrades
  to a coarser patch instead of exhausting memory.
- An acceptance test specified its command in POSIX shell and passed on Linux
  while silently exiting 0 on Windows.
