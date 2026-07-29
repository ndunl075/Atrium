# Changelog

Notable changes to Atrium. Dates are the day the change landed on `main`.

This project is pre-1.0 and has never been published to a registry, so the
version number tracks the shape of the API rather than promising anything to
an installed base. Breaking changes are listed first in each release and are
called breaking even when nothing could have been broken yet — the point of
writing them down is that the next person reading this cannot tell, from the
code alone, which changes were deliberate.

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
