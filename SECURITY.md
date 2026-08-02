# Security

## Reporting a vulnerability

Report privately, not as a public issue.

Use [GitHub's private vulnerability reporting][advisory] on this repository —
the "Report a vulnerability" button on the Security tab. That opens a thread
visible only to you and the maintainers. If it is unavailable, email
ndunlap075@gmail.com with `atrium security` in the subject; that address is
already on every commit in this repository, so writing it here gives nothing
away that `git log` does not.

Useful things to include, in rough order of how much they help: the version or
commit, what an attacker ends up able to do, and the shortest thing that
demonstrates it. A script is worth more than a description. If you are not sure
whether something counts, report it — deciding that is the maintainers' job, and
a report that turns out to be intended behaviour is a sign the documentation
below needs to be clearer.

Expect an acknowledgement within a week. Atrium is pre-1.0 and maintained by one
person; there is no bounty, and no SLA beyond a genuine effort to reply.

Please give a reasonable window to ship a fix before publishing. In return: you
will be credited by whatever name you ask for, or not at all if you prefer, and
you will not be asked to stay quiet indefinitely.

[advisory]: https://github.com/ndunl075/Atrium/security/advisories/new

## Supported versions

The latest release on `main`. This project is pre-1.0 and has never been
published to a registry, so there is no installed base to backport to — fixes
land on `main` and go out in the next release.

## Trust model

Most of what Atrium does is run code on behalf of agents, so "vulnerability"
needs a boundary to be measured against. These are the properties Atrium intends
to hold. A way to break one is a bug worth reporting.

**A room member is semi-trusted.** Agents in a room are assumed to be capable of
anything a confused or adversarial language model does — writing nonsense,
claiming work it cannot do, trying paths it was not offered. Atrium's job is to
contain that, not to prevent it. A member should not be able to:

- read or write outside the room directory, by any spelling of a path, including
  through a symlink or a Windows junction
- read or write inside `.atrium/`, which holds the log, the config, and the
  session tokens
- act as another member, or acquire a second identity
- accept its own work, or hold a role the operator did not grant it
- claim a task somebody else holds, or take a lease somebody else holds

**A session token is the whole credential.** Anything holding one can act as the
member it names, at that member's role, until the member leaves. Tokens are 192
bits of `randomBytes`, stored only as a SHA-256 hash, and never written to the
log. The role is fixed when the token is minted with `atrium invite` and cannot
be changed by the holder.

**stdio trusts the process.** Over stdio the trust boundary is the pipe: whatever
can spawn the server can `join` as any role, because nothing else shares that
pipe. This is intended, and it is why there is no anonymous `join` over HTTP —
over a socket that same freedom would be an unauthenticated way to create a
privileged member.

**The operator is trusted.** Job files run commands. A `command:` in a job file,
and any `acceptance: { kind: command }`, executes with the privileges of whoever
ran `atrium run` — that is the feature, not a flaw. Atrium does not sandbox
worker processes and does not claim to. Two things follow, and both are real:

- Do not run a job file you would not run a shell script from.
- Do not interpolate `ATRIUM_TASK_TITLE` or `ATRIUM_TASK_DESCRIPTION` into a
  `command`. Those are written by whoever created the task, which is usually
  another agent, and `command` runs through a shell. On Windows `cmd.exe`
  expands `%VAR%` before parsing the line, so a task title containing `&` runs a
  second command. Read them from the environment inside the worker instead,
  where they never reach a shell. See the runner section of the README.

**The network surfaces are local-first.** Plain `atrium serve` is stdio and
opens no port at all. The two that listen — `atrium serve --http` and `atrium
watch`, which run on separate ports — bind to `127.0.0.1` unless a host is
passed. Passing one is an operator deliberately choosing to expose the room, and
what that exposes differs:

- `atrium serve --http` (the MCP endpoint and `/events`) requires a session
  token on every request. `/health` does not, and reports liveness and the log
  head.
- `atrium watch` requires **no token at all** and serves the room's entire
  history read-only. What makes that defensible is the bind address, so it also
  refuses any request whose `Host` header is not a name that reaches this
  machine — otherwise a website could reach it through DNS rebinding. Exposing
  `atrium watch` beyond loopback publishes the room to anything that can reach
  the port.

## Out of scope

Not because they do not matter, but because they are not defects in this
codebase:

- What a worker process does once launched. Atrium starts it and cannot police
  it, which is true of any process that runs a command from a config file.
- Anything reachable only by an operator who already has the privileges being
  demonstrated, or only after editing files in `.atrium/` by hand.
- Exposure that follows from deliberately binding a server beyond loopback, when
  it behaves as documented above.
- Resource exhaustion by a member of a room it was invited to. A room is a
  cooperative workspace; a member that floods it is a bad agent, not an
  intruder. Reports are still welcome where the cost is wildly disproportionate
  to the request.
- Findings from an automated scanner with no path to impact through the
  properties above. Atrium has no runtime dependencies, so dependency-scanner
  output in particular is usually about the build toolchain.
