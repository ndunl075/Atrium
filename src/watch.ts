/**
 * The watch UI: a read-only window onto a running room, in a browser.
 *
 * ARCHITECTURE.md §7.3 asks for "board state, live event stream, artifact
 * diffs" and is blunt that this is the most demo-able part of the project and
 * therefore the most tempting thing to build first, which is why it should be
 * built last. It is being built last. Everything it shows is folded from the
 * log by modules that already existed; this file adds no new knowledge about
 * the room, only a way to look at what the room already knows.
 *
 * It runs its own server rather than adding routes to `http.ts`, and that is
 * the one design decision here worth defending. The MCP endpoint in `http.ts`
 * holds a single invariant — every request carries a session token, because
 * over HTTP there is no process boundary to inherit trust from. Hanging an
 * unauthenticated read-only surface off that same port would quietly break it:
 * an operator who deliberately exposed the MCP port, having decided that
 * handing out a token was an acceptable risk, would also be publishing the
 * room's briefs, drafts and diffs to anyone who could reach it, without ever
 * having agreed to that. A separate server on a separate port keeps the two
 * decisions separate. Starting the watch UI is its own opt-in.
 *
 * What that buys is the freedom to have no token at all, which is what makes
 * this usable from a browser. The protections instead are: it binds to
 * 127.0.0.1 unless a human deliberately says otherwise, and it is structurally
 * read-only — every method other than GET is refused before any routing
 * happens, and no handler below calls anything that appends to the log. That
 * is a weaker boundary than the MCP endpoint's and it is stated plainly rather
 * than dressed up: anything running on the machine can read the room through
 * this port while it is open.
 *
 * The page is self-contained. All CSS and JS are inline and nothing is fetched
 * from the internet, so it still works offline. That is partly principle —
 * this project's dependency budget is zero and a CDN link is a dependency
 * wearing a disguise — and partly the plain observation that a tool for
 * watching local work should not need the internet to draw itself.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { listArtifacts } from "./artifacts.js";
import { getTask, listTasks } from "./board.js";
import {
  describeHistory,
  getContext,
  type HistoryLine,
  type PinnedArtifact,
  type RoomContext,
} from "./context.js";
import { isAtriumError } from "./errors.js";
import type { Room } from "./room.js";
import { diffArtifact, listVersions } from "./snapshots.js";
import { blockingDependencies } from "./tasks.js";
import type { EventType, MemberId, MemberRole, Task, TaskId, TaskState } from "./types.js";

export interface ServeWatchOptions {
  /** Defaults to 127.0.0.1. Only change this deliberately. */
  host?: string;
  /** Defaults to 0, which asks the OS for any free port. */
  port?: number;
  /** How often the event stream looks for new log entries. Defaults to 1000ms. */
  pollMs?: number;
}

export interface WatchServerHandle {
  readonly host: string;
  readonly port: number;
  /** Convenience for logging and for tests. */
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_POLL_MS = 1000;

/** Log lines shown on first paint. The stream carries everything after. */
const INITIAL_LOG_LINES = 200;

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escapes text for interpolation into HTML.
 *
 * Everything this UI renders is attacker-influenced: an artifact path, a task
 * title, a member's self-reported name and manifest, a line of a diff. All of
 * it arrives from whoever was in the room, and a room is explicitly a place
 * where agents from unrelated stacks write things. So this is applied to every
 * single interpolation without exception, including values that "obviously"
 * cannot contain markup — the moment that judgement is made per-call-site is
 * the moment one of them is wrong.
 *
 * `&` is replaced first; doing it later would double-escape the entities the
 * other replacements just introduced.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes a value for use inside a URL query string. */
function q(value: string): string {
  return encodeURIComponent(value);
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

/**
 * A light, flat, paper-like palette: warm off-white ground, near-black ink, a
 * single gold accent, and hairline rules instead of shadows. There are no
 * gradients anywhere in this stylesheet, which is a deliberate constraint
 * rather than an omission — flat fills keep the state colours legible at a
 * glance, which is the entire job of a board you are watching rather than
 * reading.
 *
 * Fonts are system stacks by necessity: a web font is a network fetch, and
 * this page is required to render on a machine with no network. The pairing
 * still does some work — a serif for headings against a sans UI and a
 * monospace for anything positional (sequence numbers, hashes, diffs, paths),
 * so that the things you scan for line up and the things you read do not.
 */
const STYLES = `
:root {
  --paper: #fbfaf7;
  --surface: #ffffff;
  --ink: #1b1a17;
  --ink-soft: #56534c;
  --ink-faint: #8a867d;
  --line: #e7e3d9;
  --line-soft: #f1eee6;
  --accent: #b87d14;
  --accent-fill: #fdf5e2;

  --state-open: #1f5c8b;      --state-open-fill: #e9f1f8;
  --state-blocked: #6b6862;   --state-blocked-fill: #f1efe9;
  --state-claimed: #b87d14;   --state-claimed-fill: #fdf5e2;
  --state-submitted: #63488f; --state-submitted-fill: #f1ecf8;
  --state-rejected: #a3341f;  --state-rejected-fill: #fbeae6;
  --state-accepted: #2c6b4a;  --state-accepted-fill: #e8f3ec;

  --add-ink: #205a38; --add-fill: #eaf5ec; --add-rule: #4e9a6b;
  --del-ink: #8f2e1c; --del-fill: #fbeae6; --del-rule: #c25a45;

  --serif: Georgia, "Iowan Old Style", "Palatino Linotype", ui-serif, serif;
  --sans: system-ui, -apple-system, "Segoe UI", Helvetica, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--line); }
a:hover { border-bottom-color: var(--accent); }

.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 28px 80px; }

header.masthead { border-bottom: 2px solid var(--ink); padding-bottom: 18px; margin-bottom: 34px; }
.masthead h1 { font-family: var(--serif); font-size: 30px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
.masthead .meta { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
.masthead .meta span + span::before { content: "·"; margin: 0 8px; color: var(--line); }
.live { color: var(--accent); }

section { margin-bottom: 40px; }
section > h2 {
  font-family: var(--serif); font-size: 13px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--ink-soft); margin: 0 0 14px;
  padding-bottom: 8px; border-bottom: 1px solid var(--line);
}

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }

.stategroup { margin-bottom: 20px; }
.stategroup > h3 {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.09em;
  margin: 0 0 8px; color: var(--ink-soft);
}
.pill {
  display: inline-block; font-family: var(--mono); font-size: 10px;
  padding: 2px 7px; border-radius: 3px; letter-spacing: 0.06em; text-transform: uppercase;
}
.pill.open      { color: var(--state-open);      background: var(--state-open-fill); }
.pill.blocked   { color: var(--state-blocked);   background: var(--state-blocked-fill); }
.pill.claimed   { color: var(--state-claimed);   background: var(--state-claimed-fill); }
.pill.submitted { color: var(--state-submitted); background: var(--state-submitted-fill); }
.pill.rejected  { color: var(--state-rejected);  background: var(--state-rejected-fill); }
.pill.accepted  { color: var(--state-accepted);  background: var(--state-accepted-fill); }

.task { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 12px 14px; margin-bottom: 8px; }
.task .title { font-weight: 600; }
.task .id { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); }
.task .extra { font-size: 13px; color: var(--ink-soft); margin-top: 4px; }
.task .extra em { font-style: normal; color: var(--state-rejected); }
.board-tools {
  display: flex; align-items: center; gap: 10px; margin: -2px 0 14px;
}
.board-tools label {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ink-faint);
}
.board-tools input {
  min-width: 240px; flex: 0 1 420px;
  font-family: var(--sans); font-size: 13px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 4px; padding: 7px 9px;
}
.board-tools input:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.board-tools output { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); font-weight: 600; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; }
tr:last-child td { border-bottom: none; }
.manifest { color: var(--ink-soft); font-size: 13px; }
.left { color: var(--ink-faint); }

#log { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 12.5px; }
#log li { display: flex; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--line-soft); }
#log li:first-child { animation: fresh 1.1s ease-out; }
#log .seq { color: var(--ink-faint); min-width: 46px; text-align: right; }
#log .ts { color: var(--ink-faint); min-width: 62px; }
#log .line { color: var(--ink); font-family: var(--sans); font-size: 13.5px; }
@keyframes fresh { from { background: var(--accent-fill); } to { background: transparent; } }

/* The same "something just changed" cue the newest log line gets, reused for
   a board/roster/artifacts/brief region the instant the stream redraws it —
   restrained to the one keyframe already in the vocabulary rather than a
   second animation this page would then have to justify. */
.flash { animation: fresh 1.1s ease-out; }

/* A dropped stream means every folded region on the page stopped moving the
   instant it disconnected, so it must stop *looking* current too — dimming
   is the same warm-gray already used for "blocked", not a new colour. */
body.stale #board, body.stale #roster, body.stale #artifacts, body.stale #brief {
  opacity: 0.55;
}

body.stale #agent-floor { opacity: 0.55; }

pre.brief {
  margin: 0; font-family: var(--mono); font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; overflow-x: auto;
}

pre.patch { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; overflow-x: auto; }
pre.patch .l { display: block; padding: 0 10px; white-space: pre; }
pre.patch .add { color: var(--add-ink); background: var(--add-fill); box-shadow: inset 2px 0 0 var(--add-rule); }
pre.patch .del { color: var(--del-ink); background: var(--del-fill); box-shadow: inset 2px 0 0 var(--del-rule); }
pre.patch .hunk { color: var(--accent); background: var(--accent-fill); }
pre.patch .file { color: var(--ink-faint); }
pre.patch .noeol { color: var(--ink-faint); font-style: italic; }

form.compare { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
form.compare .label { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); }
select, button {
  font-family: var(--mono); font-size: 12px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 4px; padding: 6px 9px;
}
button { cursor: pointer; border-color: var(--ink-soft); }
button:hover { background: var(--accent-fill); border-color: var(--accent); color: var(--accent); }
select:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.note { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--surface); border-radius: 4px; padding: 12px 14px; color: var(--ink-soft); }
.empty { color: var(--ink-faint); font-style: italic; }
.crumb { font-family: var(--mono); font-size: 12px; margin-bottom: 22px; }

@media (max-width: 640px) {
  .wrap { padding: 26px 16px 60px; }
  #log li { flex-wrap: wrap; gap: 6px; }
}

/* OpenNote-inspired notebook shell. The original rules above remain the
   component baseline for room, task, and diff pages; these overrides add the
   stronger art direction without changing live-update ids or semantics. */
:root {
  --paper: #f2efe6;
  --surface: #fffdf7;
  --ink: #1d1d18;
  --ink-soft: #55534b;
  --ink-faint: #8a867b;
  --line: #d8d2c3;
  --line-soft: #ebe6da;
  --accent: #8a5b00;
  --accent-fill: #f8eaa5;
  --sun: #f3d34f;
  --sun-soft: #fbefb2;
  --mint: #ddefd9;
  --shadow: 5px 5px 0 #1d1d18;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif;
  --sans: "Avenir Next", Avenir, "Century Gothic", "Trebuchet MS", sans-serif;
  --mono: "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace;
}

html { scroll-behavior: smooth; }

body {
  min-height: 100vh;
  background:
    radial-gradient(circle at 1px 1px, rgba(29, 29, 24, 0.075) 1px, transparent 1.2px)
      0 0 / 22px 22px,
    var(--paper);
  font-size: 14px;
}

body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto;
  height: 7px;
  z-index: 20;
  background: var(--sun);
  border-bottom: 1px solid var(--ink);
}

a {
  color: inherit;
  border-bottom-color: currentColor;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

a:hover { color: #654300; }

.wrap { max-width: 1320px; padding: 36px 32px 96px; }

.app-shell {
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
  gap: 30px;
  align-items: start;
}

.notebook-rail {
  position: sticky;
  top: 30px;
  min-height: calc(100vh - 66px);
  display: flex;
  flex-direction: column;
  padding: 22px 18px 18px;
  color: var(--ink);
  background: var(--sun);
  border: 1.5px solid var(--ink);
  border-radius: 22px;
  box-shadow: var(--shadow);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 20px;
  border-bottom: 1px solid rgba(29, 29, 24, 0.35);
}

.brand-mark {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: var(--ink);
  color: var(--sun);
  border-radius: 12px 12px 4px 12px;
  font-family: var(--serif);
  font-size: 23px;
  font-weight: 800;
  transform: rotate(-3deg);
}

.brand-name {
  font-family: var(--serif);
  font-size: 21px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.03em;
}

.brand-caption {
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  opacity: 0.65;
}

.room-nav { display: grid; gap: 5px; margin-top: 25px; }

.room-nav a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border: 0;
  border-radius: 11px;
  font-weight: 700;
  transition: transform 140ms ease, background 140ms ease;
}

.room-nav a::before {
  content: "";
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border: 1px solid var(--ink);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.5);
}

.room-nav a:hover {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.52);
  transform: translateX(3px);
}

.rail-note {
  margin-top: auto;
  padding: 13px;
  background: rgba(255, 255, 255, 0.46);
  border: 1px solid rgba(29, 29, 24, 0.4);
  border-radius: 13px;
  font-size: 11px;
  line-height: 1.45;
}

.rail-note strong {
  display: block;
  margin-bottom: 3px;
  font-family: var(--mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.workspace { min-width: 0; }

header.masthead {
  position: relative;
  overflow: hidden;
  margin-bottom: 24px;
  padding: 30px 32px 27px;
  background: var(--surface);
  border: 1.5px solid var(--ink);
  border-radius: 24px 24px 8px 24px;
  box-shadow: var(--shadow);
}

.room-masthead {
  min-height: 0;
  padding-block: 25px 23px;
}

.masthead-copy {
  position: relative;
  z-index: 2;
  min-width: 0;
}

.masthead-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 15px;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.masthead-kicker::before {
  content: "";
  width: 28px;
  height: 2px;
  background: var(--ink);
}

.agent-floor-shell {
  position: relative;
  overflow: hidden;
  min-height: 430px;
  padding: 22px;
  color: #f8f1dc;
  background:
    radial-gradient(circle at 50% 48%, rgba(243, 211, 79, 0.15), transparent 31%),
    linear-gradient(145deg, #132b40, #1d1d18 72%);
  border: 1.5px solid #0c1822;
  border-radius: 18px 18px 6px 18px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
}

.agent-floor-shell::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0.22;
  background:
    linear-gradient(30deg, transparent 49.6%, rgba(243, 211, 79, 0.35) 50%, transparent 50.4%)
      0 0 / 74px 74px,
    linear-gradient(150deg, transparent 49.6%, rgba(243, 211, 79, 0.2) 50%, transparent 50.4%)
      0 0 / 74px 74px;
  pointer-events: none;
}

.floor-toolbar {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}

.floor-toolbar p {
  max-width: 580px;
  margin: 3px 0 0;
  color: #b9c5ca;
  font-size: 12px;
}

.floor-mode {
  flex: 0 0 auto;
  padding: 5px 9px;
  color: #1d1d18;
  background: var(--sun);
  border: 1px solid #f7e58e;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.agent-scene {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(210px, 0.75fr) minmax(0, 2fr);
  gap: 20px;
  align-items: stretch;
}

.shared-core {
  position: relative;
  display: grid;
  place-content: center;
  min-height: 270px;
  padding: 24px;
  text-align: center;
  color: #1d1d18;
  background: var(--sun);
  border: 1.5px solid #0c1822;
  border-radius: 48% 52% 45% 55% / 55% 43% 57% 45%;
  box-shadow: 7px 7px 0 #08131c;
  transform: rotate(-1deg);
}

.shared-core::before,
.shared-core::after {
  content: "";
  position: absolute;
  width: 34px;
  height: 46px;
  background: #fff9df;
  border: 1px solid #1d1d18;
  box-shadow: 2px 2px 0 rgba(29, 29, 24, 0.35);
}

.shared-core::before { top: 24px; left: 28px; transform: rotate(-9deg); }
.shared-core::after { right: 28px; bottom: 24px; transform: rotate(7deg); }

.core-mark {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  margin: 0 auto 9px;
  color: var(--sun);
  background: var(--ink);
  border-radius: 16px 16px 5px 16px;
  font-family: var(--serif);
  font-size: 28px;
  font-weight: 800;
}

.shared-core strong {
  font-family: var(--serif);
  font-size: 21px;
  letter-spacing: -0.025em;
}

.core-counts {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 11px;
}

.core-counts span {
  padding: 4px 7px;
  background: rgba(255, 255, 255, 0.52);
  border: 1px solid rgba(29, 29, 24, 0.35);
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 9px;
}

.agent-stations {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.agent-station {
  position: relative;
  min-height: 128px;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 11px;
  align-items: center;
  padding: 13px;
  color: var(--ink);
  background: #fff9e8;
  border: 1.5px solid #0c1822;
  border-radius: 16px 16px 5px 16px;
  box-shadow: 4px 4px 0 #08131c;
}

.agent-station[data-status="away"] { filter: grayscale(0.8); opacity: 0.63; }
.agent-station[data-preview="true"] { border-style: dashed; }

.agent-character {
  position: relative;
  width: 68px;
  height: 92px;
}

.agent-head {
  position: absolute;
  top: 2px;
  left: 20px;
  width: 31px;
  height: 31px;
  background: #f0b987;
  border: 1.5px solid var(--ink);
  border-radius: 50% 50% 44% 44%;
  z-index: 3;
}

.agent-head::before {
  content: "";
  position: absolute;
  inset: -3px 2px 16px -2px;
  background: var(--agent-color, #de7a35);
  border-radius: 60% 60% 35% 35%;
}

.agent-head::after {
  content: "••";
  position: absolute;
  left: 8px;
  top: 11px;
  color: var(--ink);
  font-size: 8px;
  letter-spacing: 5px;
}

.agent-body {
  position: absolute;
  top: 31px;
  left: 15px;
  width: 41px;
  height: 43px;
  background: var(--agent-color, #de7a35);
  border: 1.5px solid var(--ink);
  border-radius: 12px 12px 5px 5px;
  z-index: 2;
}

.agent-arm {
  position: absolute;
  top: 43px;
  left: 5px;
  width: 30px;
  height: 9px;
  background: #f0b987;
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  transform-origin: right center;
  transform: rotate(-13deg);
  z-index: 3;
}

.mini-desk {
  position: absolute;
  left: 2px;
  right: 0;
  bottom: 2px;
  height: 22px;
  background: #d9c590;
  border: 1.5px solid var(--ink);
  border-radius: 5px 5px 2px 2px;
  z-index: 4;
}

.mini-desk::before {
  content: "";
  position: absolute;
  width: 26px;
  height: 18px;
  right: 7px;
  bottom: 15px;
  background: #183149;
  border: 1.5px solid var(--ink);
  border-radius: 3px;
}

.agent-copy { min-width: 0; }

.agent-copy strong {
  display: block;
  overflow: hidden;
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-role {
  display: block;
  margin: 4px 0 9px;
  color: var(--ink-faint);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.agent-action {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 800;
}

.agent-action::before {
  content: "";
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  background: #658049;
  border: 1px solid var(--ink);
  border-radius: 50%;
}

[data-status="working"] .agent-action::before { background: #e37a2f; }
[data-status="reviewing"] .agent-action::before,
[data-status="waiting"] .agent-action::before { background: #d8b927; }
[data-status="away"] .agent-action::before { background: #938f84; }

.agent-task {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 5px;
  color: var(--ink-soft);
  font-size: 10px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.agent-station.role-reviewer { --agent-color: #d9b93c; }
.agent-station.role-human { --agent-color: #789260; }
.agent-station.role-worker { --agent-color: #dd7938; }

@media (prefers-reduced-motion: no-preference) {
  [data-status="working"] .agent-arm { animation: agent-type 620ms ease-in-out infinite alternate; }
  [data-status="reviewing"] .agent-head { animation: agent-review 1.4s ease-in-out infinite alternate; }
  [data-status="waiting"] .agent-action::before { animation: agent-pulse 1.2s ease-in-out infinite; }
}

@keyframes agent-type {
  from { transform: rotate(-16deg) translateY(0); }
  to { transform: rotate(-4deg) translateY(2px); }
}

@keyframes agent-review {
  from { transform: translateX(-2px) rotate(-2deg); }
  to { transform: translateX(2px) rotate(2deg); }
}

@keyframes agent-pulse {
  50% { box-shadow: 0 0 0 5px rgba(216, 185, 39, 0.25); }
}

header.masthead::after {
  content: "";
  position: absolute;
  width: 112px;
  height: 112px;
  top: -58px;
  right: -28px;
  background: var(--sun);
  border: 1.5px solid var(--ink);
  border-radius: 50%;
}

.masthead h1 {
  position: relative;
  z-index: 1;
  max-width: 760px;
  margin-bottom: 13px;
  font-size: clamp(36px, 5.5vw, 66px);
  font-weight: 800;
  line-height: 0.95;
  letter-spacing: -0.055em;
}

.masthead .meta {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  font-family: var(--sans);
  font-size: 11px;
}

.masthead .meta span {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 4px 9px;
  color: var(--ink-soft);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.masthead .meta span + span::before { content: none; margin: 0; }

.masthead .meta .live {
  color: #184c2e;
  background: var(--mint);
  border-color: #84ad83;
  font-weight: 800;
}

.masthead .meta .live::before {
  content: "";
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #2d7b49;
  box-shadow: 0 0 0 3px rgba(45, 123, 73, 0.14);
}

.workspace section {
  scroll-margin-top: 24px;
  margin-bottom: 20px;
  padding: 23px;
  background: rgba(255, 253, 247, 0.92);
  border: 1.5px solid var(--ink);
  border-radius: 21px 21px 8px 21px;
  box-shadow: 3px 3px 0 var(--ink);
}

.wrap > section {
  margin-bottom: 20px;
  padding: 23px;
  background: rgba(255, 253, 247, 0.92);
  border: 1.5px solid var(--ink);
  border-radius: 21px 21px 8px 21px;
  box-shadow: 3px 3px 0 var(--ink);
}

section > h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  padding: 0;
  border: 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 22px;
  font-weight: 800;
  text-transform: none;
  letter-spacing: -0.025em;
}

section > h2::after {
  content: "";
  height: 1px;
  flex: 1;
  margin-left: 4px;
  background: var(--line);
}

.card {
  overflow: hidden;
  background: var(--surface);
  border-color: var(--line);
  border-radius: 14px;
}

#brief pre.brief {
  padding: 18px;
  background: #fff8d7;
  border: 1px solid #dacb7c;
  border-radius: 13px;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.7;
}

#board {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

#board > .empty { grid-column: 1 / -1; }

.stategroup {
  min-width: 0;
  margin: 0;
  padding: 13px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 15px;
}

.stategroup > h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
}

.pill {
  padding: 4px 9px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
}

.task {
  padding: 13px 14px;
  border-color: #cfc8b7;
  border-radius: 12px;
  box-shadow: 0 2px 0 rgba(29, 29, 24, 0.08);
  transition: transform 140ms ease, box-shadow 140ms ease;
}

.task:hover {
  transform: translateY(-2px) rotate(-0.15deg);
  box-shadow: 0 5px 0 rgba(29, 29, 24, 0.09);
}

.task .title {
  font-family: var(--serif);
  font-size: 16px;
}

.task .title a { border: 0; }
.task .id { margin-top: 3px; }

.board-tools {
  padding: 10px;
  background: var(--sun-soft);
  border: 1px solid #d6c15d;
  border-radius: 13px;
}

.board-tools input {
  min-height: 38px;
  background: var(--surface);
  border-color: #b7aa75;
  border-radius: 9px;
}

table { min-width: 620px; }

th {
  padding-top: 11px;
  color: var(--ink-soft);
  background: #f6f2e8;
}

th, td { padding: 10px 12px; }

#log {
  overflow: hidden;
  background: #24241f;
  border: 1.5px solid #0f0f0d;
  border-radius: 15px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.055);
}

#log li {
  gap: 14px;
  padding: 9px 13px;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

#log .seq { color: #ddbf45; }
#log .ts { color: #85847a; }
#log .line { color: #f4f0e6; }

.note {
  border-color: var(--ink);
  border-left-width: 1px;
  border-radius: 14px 14px 5px 14px;
  background: var(--sun-soft);
  box-shadow: 3px 3px 0 var(--ink);
}

.crumb a {
  display: inline-flex;
  padding: 7px 11px;
  background: var(--surface);
  border: 1px solid var(--ink);
  border-radius: 999px;
}

select, button { border-color: var(--ink); border-radius: 9px; }

button {
  background: var(--sun);
  font-weight: 800;
  box-shadow: 2px 2px 0 var(--ink);
}

button:hover {
  color: var(--ink);
  background: var(--sun-soft);
  transform: translate(1px, 1px);
  box-shadow: 1px 1px 0 var(--ink);
}

@media (prefers-reduced-motion: no-preference) {
  .notebook-rail { animation: settle-in 420ms cubic-bezier(.2,.8,.2,1) both; }
  .workspace { animation: rise-in 500ms 70ms cubic-bezier(.2,.8,.2,1) both; }
}

@keyframes settle-in {
  from { opacity: 0; transform: translateX(-12px) rotate(-0.7deg); }
  to { opacity: 1; transform: translateX(0) rotate(0); }
}

@keyframes rise-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 900px) {
  .wrap { padding: 26px 18px 70px; }
  .app-shell { grid-template-columns: 1fr; }
  .notebook-rail {
    position: static;
    min-height: 0;
    padding: 14px;
    border-radius: 18px;
  }
  .brand { padding-bottom: 13px; }
  .room-nav {
    display: flex;
    gap: 4px;
    margin-top: 12px;
    overflow-x: auto;
  }
  .room-nav a { flex: 0 0 auto; padding: 8px 10px; }
  .room-nav a::before, .rail-note { display: none; }
  .agent-scene { grid-template-columns: 1fr; }
  .shared-core { min-height: 190px; border-radius: 30px 30px 9px 30px; }
}

@media (max-width: 640px) {
  .wrap { padding: 23px 11px 50px; }
  header.masthead { padding: 25px 21px 22px; }
  .masthead h1 { font-size: 39px; }
  .workspace section { padding: 17px 14px; }
  #board { grid-template-columns: 1fr; }
  .board-tools { align-items: stretch; flex-direction: column; }
  .board-tools input { min-width: 0; width: 100%; }
  .card { overflow-x: auto; }
  #log li { display: grid; grid-template-columns: 42px 1fr; }
  #log .line { grid-column: 1 / -1; padding-left: 0; }
  .agent-floor-shell { min-height: 0; padding: 15px; }
  .floor-toolbar { display: block; }
  .floor-mode { display: inline-block; margin-top: 10px; }
  .agent-stations { grid-template-columns: 1fr; }
}
`;

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/**
 * The token total against the ceiling, rendered so that being over it reads
 * as unmistakably bad rather than as a slightly larger number.
 *
 * `getContext` deliberately reports the real total even past the ceiling —
 * `CONTEXT.md` is a plain file a human can hand-edit past the limit, and
 * clamping the number here would just move that surprise somewhere harder to
 * debug (see the doc comment on `getContext` in context.ts). So this never
 * clamps either; it only chooses a colour. Reusing the task-state palette
 * (`accepted` green, `rejected` red) rather than inventing a third state
 * colour for "over budget" keeps the vocabulary the rest of the page already
 * trained a reader on.
 */
function renderContextBudget(context: RoomContext): string {
  const overBy = context.tokens - context.ceiling;
  if (overBy > 0) {
    return `<span id="ctx-budget" class="pill rejected">${context.tokens} / ${context.ceiling} tokens · ${overBy} over ceiling</span>`;
  }
  return `<span id="ctx-budget" class="pill accepted">${context.tokens} / ${context.ceiling} tokens</span>`;
}

/**
 * One pinned artifact: its path, a link to the diff view if it has more than
 * one version to compare, and its full content — because the content is the
 * actual thing every joining agent was handed, not just its name. Path and
 * content both come from a file somebody in the room wrote, so both are
 * escaped the same as everything else on this page.
 */
function renderPinnedArtifact(room: Room, pinned: PinnedArtifact): string {
  const versions = listVersions(room, pinned.path).filter((v) => v.kind === "written");
  const link =
    versions.length >= 2
      ? `<a href="/diff?path=${q(pinned.path)}">view diff</a>`
      : `<span class="empty">one version</span>`;

  return `<div class="card" style="margin-bottom:12px">
    <div class="mono" style="margin-bottom:8px">${escapeHtml(pinned.path)} · ${link}</div>
    <pre class="brief">${escapeHtml(pinned.content)}</pre>
  </div>`;
}

/**
 * Tier 1, in full: `CONTEXT.md` plus every pinned artifact, which
 * ARCHITECTURE.md §4 calls "the brief" — the one thing injected into every
 * agent that joins the room. Nothing about the room is more worth showing a
 * human watching it work, and until now this page did not show it at all.
 *
 * `CONTEXT.md` is Markdown on disk, and this codebase has no Markdown library
 * and a zero-dependency budget that forbids adding one. A tiny hand-rolled
 * subset (headings and paragraphs, say) was the other option considered, and
 * it was rejected: real briefs will contain the Markdown such a subset does
 * not cover — lists, links, code fences, emphasis — and rendering those
 * silently wrong is exactly the quiet wrongness this codebase refuses to
 * ship. So the brief is shown faithfully instead: every character the file
 * holds, verbatim, as preformatted text in the monospace style already used
 * for positional content elsewhere on this page. A literal `# Heading` shows
 * up as the four characters `# Heading` rather than a styled heading. That is
 * a real readability cost, paid deliberately in exchange for never asserting
 * a structure the text does not actually have.
 */
function renderBrief(room: Room, context: RoomContext): string {
  // An empty brief is the ordinary state of a room nobody has curated yet,
  // not an error — so it gets a sentence saying that, the same way the board
  // and roster explain an empty state rather than drawing an empty box.
  const briefBody =
    context.brief.trim() === ""
      ? `<p class="empty">CONTEXT.md is empty. That's normal for a fresh room — nobody has written a brief for it yet.</p>`
      : `<pre class="brief">${escapeHtml(context.brief)}</pre>`;

  const pinnedBody =
    context.pinned.length === 0
      ? `<p class="empty">Nothing is pinned.</p>`
      : context.pinned.map((p) => renderPinnedArtifact(room, p)).join("");

  return `
<div class="stategroup">
  <h3>CONTEXT.md</h3>
  ${briefBody}
</div>
<div class="stategroup">
  <h3>Pinned artifacts</h3>
  ${pinnedBody}
</div>`;
}

const STATE_ORDER: TaskState[] = [
  "open",
  "blocked",
  "claimed",
  "submitted",
  "rejected",
  "accepted",
];

function shortTime(ts: string): string {
  // The date is almost never the interesting part while watching a room work;
  // the ordering is, and the sequence number already carries that.
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

function renderTask(task: Task, names: Map<MemberId, string>): string {
  const extras: string[] = [];
  if (task.claimedBy) extras.push(`claimed by ${names.get(task.claimedBy) ?? task.claimedBy}`);
  if (task.waitingOn && task.waitingOn.length > 0) {
    extras.push(`waiting on ${task.waitingOn.join(", ")}`);
  }
  if (task.attempts > 0) extras.push(`${task.attempts} attempt${task.attempts === 1 ? "" : "s"}`);

  const escalated = task.escalated ? `<em>escalated — needs a human</em>` : "";
  const extra = extras.length > 0 || escalated
    ? `<div class="extra">${escapeHtml(extras.join(" · "))}${
        extras.length > 0 && escalated ? " · " : ""
      }${escalated}</div>`
    : "";

  return `<div class="task">
    <div class="title"><a href="/task?id=${q(task.id)}">${escapeHtml(task.title)}</a></div>
    <div class="id">${escapeHtml(task.id)} · ${escapeHtml(task.acceptance.kind)} acceptance</div>
    ${extra}
  </div>`;
}

function renderBoard(tasks: Task[], names: Map<MemberId, string>): string {
  if (tasks.length === 0) return `<p class="empty">No tasks on the board yet.</p>`;

  const groups: string[] = [];
  for (const state of STATE_ORDER) {
    const group = tasks.filter((t) => t.state === state);
    if (group.length === 0) continue;
    groups.push(`<div class="stategroup">
      <h3><span class="pill ${state}">${escapeHtml(state)}</span> ${group.length}</h3>
      ${group.map((t) => renderTask(t, names)).join("")}
    </div>`);
  }
  return groups.join("");
}

type AgentFloorStatus = "working" | "reviewing" | "waiting" | "ready" | "away";

interface AgentFloorItem {
  name: string;
  role: MemberRole;
  status: AgentFloorStatus;
  action: string;
  detail: string;
  preview?: boolean;
}

function memberFloorItem(
  member: ReturnType<Room["roster"]>[number],
  tasks: Task[],
): AgentFloorItem {
  if (!member.active) {
    return {
      name: member.name,
      role: member.role,
      status: "away",
      action: "Away from room",
      detail: "This member has left.",
    };
  }

  const ownTask = tasks.find(
    (task) =>
      (task.state === "claimed" || task.state === "submitted") &&
      (task.claimedBy === member.id || task.submittedBy === member.id),
  );
  if (ownTask?.state === "claimed") {
    return {
      name: member.name,
      role: member.role,
      status: "working",
      action: "Working now",
      detail: ownTask.title,
    };
  }
  if (ownTask?.state === "submitted") {
    return {
      name: member.name,
      role: member.role,
      status: "waiting",
      action: "Waiting on review",
      detail: ownTask.title,
    };
  }

  const review = tasks.find((task) => task.state === "submitted");
  if ((member.role === "reviewer" || member.role === "human") && review) {
    return {
      name: member.name,
      role: member.role,
      status: "reviewing",
      action: "Reviewing work",
      detail: review.title,
    };
  }

  const escalation = tasks.find((task) => task.escalated);
  if (member.role === "human" && escalation) {
    return {
      name: member.name,
      role: member.role,
      status: "reviewing",
      action: "Handling escalation",
      detail: escalation.title,
    };
  }

  return {
    name: member.name,
    role: member.role,
    status: "ready",
    action:
      member.role === "human" || member.role === "manager"
        ? "Coordinating room"
        : "Ready for work",
    detail: tasks.some((task) => task.state === "open")
      ? "An open task is available."
      : "Watching the shared board.",
  };
}

function renderAgentStation(item: AgentFloorItem): string {
  return `<article class="agent-station role-${item.role}" data-status="${item.status}"${
    item.preview ? ` data-preview="true"` : ""
  } aria-label="${escapeHtml(`${item.name}, ${item.action}: ${item.detail}`)}">
    <div class="agent-character" aria-hidden="true">
      <span class="agent-head"></span>
      <span class="agent-body"></span>
      <span class="agent-arm"></span>
      <span class="mini-desk"></span>
    </div>
    <div class="agent-copy">
      <strong>${escapeHtml(item.name)}</strong>
      <span class="agent-role">${escapeHtml(item.role)}</span>
      <span class="agent-action">${escapeHtml(item.action)}</span>
      <span class="agent-task">${escapeHtml(item.detail)}</span>
    </div>
  </article>`;
}

function renderAgentFloor(room: Room, tasks = listTasks(room)): string {
  const members = room.roster();
  const preview = members.length === 0;
  const items: AgentFloorItem[] = preview
    ? [
        {
          name: "Scout",
          role: "worker",
          status: "working",
          action: "Researching",
          detail: "Collecting evidence for the shared brief.",
          preview: true,
        },
        {
          name: "Builder",
          role: "worker",
          status: "working",
          action: "Building",
          detail: "Turning an open task into an artifact.",
          preview: true,
        },
        {
          name: "Critic",
          role: "reviewer",
          status: "reviewing",
          action: "Reviewing work",
          detail: "Checking a submission before acceptance.",
          preview: true,
        },
      ]
    : members.map((member) => memberFloorItem(member, tasks));

  const working = preview
    ? 2
    : items.filter((item) => item.status === "working").length;
  const reviewing = preview
    ? 1
    : items.filter((item) => item.status === "reviewing").length;
  const waiting = preview
    ? 0
    : items.filter((item) => item.status === "waiting").length;

  return `<div class="agent-floor-shell">
    <div class="floor-toolbar">
      <div>
        <strong>${preview ? "See how a populated room moves" : "What every agent is doing right now"}</strong>
        <p>${
          preview
            ? "Preview crew — these sample agents disappear as soon as real members join."
            : "This view is folded from the same room log as the board and updates live."
        }</p>
      </div>
      <span class="floor-mode">${preview ? "preview" : "live room"}</span>
    </div>
    <div class="agent-scene">
      <div class="shared-core" aria-label="Shared Atrium board">
        <span class="core-mark">A</span>
        <strong>Shared board</strong>
        <div class="core-counts">
          <span>${working} working</span>
          <span>${reviewing} reviewing</span>
          <span>${waiting} waiting</span>
        </div>
      </div>
      <div class="agent-stations">
        ${items.map(renderAgentStation).join("")}
      </div>
    </div>
  </div>`;
}

function renderRoster(room: Room): string {
  const members = room.roster();
  if (members.length === 0) return `<p class="empty">Nobody has joined yet.</p>`;

  const rows = members
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.name)}${m.active ? "" : ` <span class="left">(left)</span>`}</td>
      <td class="mono">${escapeHtml(m.role)}</td>
      <td class="mono">${escapeHtml(m.tags.join(", ") || "—")}</td>
      <td class="manifest">${escapeHtml(m.manifest || "—")}</td>
    </tr>`,
    )
    .join("");

  return `<div class="card"><table>
    <tr><th>member</th><th>role</th><th>tags</th><th>manifest (self-reported)</th></tr>
    ${rows}
  </table></div>`;
}

function renderArtifacts(room: Room): string {
  const artifacts = listArtifacts(room);
  if (artifacts.length === 0) return `<p class="empty">No artifacts recorded yet.</p>`;

  const rows = artifacts
    .map((info) => {
      const versions = listVersions(room, info.path).filter((v) => v.kind === "written");
      // A diff needs two versions to compare. Offering a link that can only
      // produce "there is nothing to diff" would be a worse answer than not
      // offering one, so the count is shown either way and the link is not.
      const link =
        versions.length >= 2
          ? `<a href="/diff?path=${q(info.path)}">view diff</a>`
          : `<span class="empty">one version</span>`;
      return `<tr>
        <td class="mono">${escapeHtml(info.path)}</td>
        <td class="mono">${info.bytes} B</td>
        <td class="mono">#${info.seq}</td>
        <td>${link}</td>
      </tr>`;
    })
    .join("");

  return `<div class="card"><table>
    <tr><th>path</th><th>size</th><th>at</th><th></th></tr>
    ${rows}
  </table></div>`;
}

function renderLogLine(line: HistoryLine): string {
  return `<li><span class="seq">#${line.seq}</span><span class="ts">${escapeHtml(
    shortTime(line.ts),
  )}</span><span class="line">${escapeHtml(line.line)}</span></li>`;
}

/**
 * The client half of the live stream. It opens one EventSource and reads two
 * kinds of thing off it: the unnamed `message` events, which are log lines,
 * exactly as before; and a handful of *named* events — `board`, `roster`,
 * `agents`, `artifacts`, `brief`, `meta`, `halted` — each carrying a pre-rendered,
 * pre-escaped HTML fragment for the one region of the page that a board-
 * shaped event just changed. The client's job stays "dumb": drop the string
 * into the element with that id. All the judgment about *whether* something
 * board-shaped happened lives once, on the server, in `regionsTouchedBy`
 * below — not duplicated here as a second opinion about which events matter.
 *
 * Reconnect backoff, diffing, virtual scrolling: still not this page's job,
 * for the same reason as before — `EventSource` reconnects on its own, and
 * anything cleverer is complexity this page has not earned.
 */
function clientScript(fromSeq: number): string {
  return `
(function () {
  var log = document.getElementById("log");
  var status = document.getElementById("status");
  var taskFilter = document.getElementById("task-filter");
  var taskFilterStatus = document.getElementById("task-filter-status");
  var src = new EventSource("/events?from=${fromSeq}");

  function applyTaskFilter() {
    var board = document.getElementById("board");
    if (!board || !taskFilter) return;
    var query = taskFilter.value.trim().toLowerCase();
    var total = 0;
    var visible = 0;
    board.querySelectorAll(".stategroup").forEach(function (group) {
      var groupVisible = 0;
      group.querySelectorAll(".task").forEach(function (task) {
        total += 1;
        var heading = group.querySelector("h3");
        var haystack = (task.textContent + " " + (heading ? heading.textContent : "")).toLowerCase();
        var matches = !query || haystack.includes(query);
        task.hidden = !matches;
        if (matches) { visible += 1; groupVisible += 1; }
      });
      group.hidden = groupVisible === 0;
    });
    if (taskFilterStatus) {
      taskFilterStatus.textContent = query ? visible + " of " + total + " tasks" : "";
    }
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth; // forces a reflow so the animation restarts
    el.classList.add("flash");
  }
  function swap(id, html) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    if (id === "board") applyTaskFilter();
    flash(el);
  }

  function setLive() {
    status.textContent = "live";
    status.className = "live";
    document.body.classList.remove("stale");
  }

  src.onmessage = function (e) {
    var d = JSON.parse(e.data);
    var li = document.createElement("li");
    var seq = document.createElement("span"); seq.className = "seq"; seq.textContent = "#" + d.seq;
    var ts = document.createElement("span"); ts.className = "ts"; ts.textContent = d.ts.slice(11, 19);
    var ln = document.createElement("span"); ln.className = "line"; ln.textContent = d.line;
    li.appendChild(seq); li.appendChild(ts); li.appendChild(ln);
    log.insertBefore(li, log.firstChild);
    setLive();
  };

  src.addEventListener("meta", function (e) {
    var d = JSON.parse(e.data);
    ["members", "tasks", "tokens", "head"].forEach(function (key) {
      if (d[key] === undefined) return;
      var el = document.getElementById("hdr-" + key);
      if (el) el.textContent = d[key];
    });
  });

  src.addEventListener("board", function (e) { swap("board", JSON.parse(e.data)); });
  src.addEventListener("roster", function (e) { swap("roster", JSON.parse(e.data)); });
  src.addEventListener("agents", function (e) { swap("agent-floor", JSON.parse(e.data)); });
  src.addEventListener("artifacts", function (e) { swap("artifacts", JSON.parse(e.data)); });
  src.addEventListener("brief", function (e) {
    var d = JSON.parse(e.data);
    var budget = document.getElementById("ctx-budget");
    if (budget) budget.outerHTML = d.budget;
    swap("brief", d.body);
  });
  src.addEventListener("halted", function (e) { swap("halted", JSON.parse(e.data)); });

  src.onerror = function () {
    status.textContent = "stream disconnected — reconnecting";
    status.className = "";
    // The regions below stopped being told about anything the moment the
    // stream dropped; they are frozen, not live, and must say so rather than
    // keep looking like the rest of a page that is still moving.
    document.body.classList.add("stale");
  };
  if (taskFilter) {
    taskFilter.addEventListener("input", applyTaskFilter);
    applyTaskFilter();
  }
})();`;
}

function renderRoomPage(room: Room): string {
  const config = room.config;
  const tasks = listTasks(room);
  const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
  const context = getContext(room);
  const head = room.log.head();

  // Newest first: the reason to have this page open is what just happened.
  const lines = describeHistory(room, { from: Math.max(1, head - INITIAL_LOG_LINES + 1) })
    .slice()
    .reverse();

  const body = `
<div class="app-shell">
<aside class="notebook-rail" aria-label="Room sections">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">A</div>
    <div>
      <div class="brand-name">Atrium</div>
      <div class="brand-caption">room notebook</div>
    </div>
  </div>
  <nav class="room-nav">
    <a href="#agent-floor-section">Agent floor</a>
    <a href="#brief-section">Brief</a>
    <a href="#board-section">Board</a>
    <a href="#members-section">Members</a>
    <a href="#artifacts-section">Artifacts</a>
    <a href="#log-section">Activity</a>
  </nav>
  <div class="rail-note"><strong>Read-only view</strong>This notebook mirrors the room as it changes. Use the CLI or MCP tools to act.</div>
</aside>
<main class="workspace" id="main-content">
<header class="masthead room-masthead">
  <div class="masthead-copy">
    <div class="masthead-kicker">Shared room, one source of truth</div>
    <h1>${escapeHtml(config.name)}</h1>
    <div class="meta">
      <span>${escapeHtml(config.id)}</span>
      <span id="hdr-members">${room.roster().length} member${room.roster().length === 1 ? "" : "s"}</span>
      <span id="hdr-tasks">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
      <span id="hdr-tokens">${context.tokens}/${context.ceiling} context tokens</span>
      <span id="hdr-head">log at #${head}</span>
      <span id="status" class="live">live</span>
    </div>
  </div>
</header>
<div id="halted">${room.isHalted() ? HALTED_NOTE : ""}</div>
<section id="agent-floor-section"><h2>Live agent floor</h2><div id="agent-floor">${renderAgentFloor(room, tasks)}</div></section>
<section id="brief-section"><h2>Brief ${renderContextBudget(context)}</h2><div id="brief">${renderBrief(room, context)}</div></section>
<section id="board-section"><h2>Board</h2>
  <div class="board-tools">
    <label for="task-filter">Filter tasks</label>
    <input id="task-filter" type="search" placeholder="title, id, state, member..." autocomplete="off">
    <output id="task-filter-status" aria-live="polite"></output>
  </div>
  <div id="board">${renderBoard(tasks, names)}</div>
</section>
<section id="members-section"><h2>Members</h2><div id="roster">${renderRoster(room)}</div></section>
<section id="artifacts-section"><h2>Artifacts</h2><div id="artifacts">${renderArtifacts(room)}</div></section>
<section id="log-section"><h2>Activity</h2><ul id="log">${lines.map(renderLogLine).join("")}</ul></section>
</main>
</div>
`;

  return page(`${config.name} — atrium watch`, body, clientScript(head));
}

/** Classifies a patch line for colouring. Purely presentational: the patch
 * text itself is whatever `diffArtifact` produced and is never rewritten. */
function patchLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("\\")) return "noeol";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function renderDiffPage(room: Room, path: string, from?: number, to?: number): string {
  const versions = listVersions(room, path).filter((v) => v.kind === "written");

  let fromSeq = from;
  let toSeq = to;
  if (fromSeq === undefined || toSeq === undefined) {
    if (versions.length < 2) {
      return page(
        `${path} — atrium watch`,
        `<div class="crumb"><a href="/">← room</a></div>
         <section><h2>${escapeHtml(path)}</h2>
         <div class="note">This path has ${
           versions.length === 0 ? "no recorded versions" : "only one recorded version"
         }, so there is nothing to compare it against.</div></section>`,
      );
    }
    fromSeq = versions[versions.length - 2]!.seq;
    toSeq = versions[versions.length - 1]!.seq;
  }

  const diff = diffArtifact(room, path, fromSeq, toSeq);

  // Three outcomes that are not a patch, each reported as itself. Rendering a
  // pruned version as an empty file is exactly the lie snapshots.ts refuses to
  // tell, and this page does not get to reintroduce it at the last step.
  let content: string;
  if (diff.identical) {
    content = `<div class="note">No differences between #${fromSeq} and #${toSeq}.</div>`;
  } else if (diff.pruned || diff.binary) {
    content = `<div class="note">${escapeHtml(diff.patch.trim())}</div>`;
  } else {
    content = `<div class="card"><pre class="patch">${diff.patch
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => `<span class="l ${patchLineClass(l)}">${escapeHtml(l) || "&nbsp;"}</span>`)
      .join("")}</pre></div>`;
  }

  const picker = versions
    .map(
      (v) =>
        `<option value="${v.seq}">#${v.seq} · ${escapeHtml(shortTime(v.ts))} · ${v.bytes} B</option>`,
    )
    .join("");

  return page(
    `${path} — atrium watch`,
    `<div class="crumb"><a href="/">← room</a></div>
<section>
  <h2>${escapeHtml(path)}</h2>
  <form method="get" action="/diff" class="card compare" style="margin-bottom:16px">
    <input type="hidden" name="path" value="${escapeHtml(path)}">
    <span class="label">from</span>
    <select name="from" aria-label="earlier version">${picker.replace(
      `value="${fromSeq}"`,
      `value="${fromSeq}" selected`,
    )}</select>
    <span class="label">to</span>
    <select name="to" aria-label="later version">${picker.replace(
      `value="${toSeq}"`,
      `value="${toSeq}" selected`,
    )}</select>
    <button type="submit">compare</button>
  </form>
  ${content}
</section>`,
  );
}

// ---------------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------------

/**
 * The same acceptance wording `atrium task show` prints (see `cmdTaskShow` /
 * `acceptanceLabel` in cli.ts), reproduced here rather than imported: cli.ts
 * pulls in `parseArgs` and process-level concerns this server has no business
 * touching, so the one sentence of formatting is duplicated instead of
 * dragging a CLI module into a server that a browser talks to.
 */
function describeAcceptance(acceptance: Task["acceptance"]): string {
  switch (acceptance.kind) {
    case "command":
      return (
        `command — "${acceptance.command}" must exit 0` +
        (acceptance.timeoutSeconds !== undefined
          ? ` (killed after ${acceptance.timeoutSeconds}s)`
          : "")
      );
    case "reviewer":
      return "reviewer — a different member must accept";
    case "human":
      return "human — a human must accept";
    case "none":
      return "none — auto-accepts on submit";
  }
}

interface Rejection {
  seq: number;
  at: string;
  by: MemberId;
  reason: string;
}

/**
 * Every rejection this task has ever collected, oldest first, read straight
 * from the log rather than from the folded `Task`.
 *
 * `foldTasks` (tasks.ts) only keeps `lastRejection` on purpose — the board's
 * job is "what is true right now," and a full history would be a second thing
 * for it to carry that nothing on the board needs. The individual
 * `task.rejected` events are still sitting in the log with everything the
 * fold discarded, so a page whose whole point is showing history reads them
 * directly instead of trying to reconstruct a sequence out of a count.
 */
function taskRejections(room: Room, taskId: TaskId): Rejection[] {
  const rejections: Rejection[] = [];
  for (const event of room.log.read({ types: ["task.rejected"] })) {
    if (event.type === "task.rejected" && event.data.taskId === taskId) {
      rejections.push({
        seq: event.seq,
        at: event.ts,
        by: event.data.by,
        reason: event.data.reason,
      });
    }
  }
  return rejections;
}

/** One row of the dependency table: the dependency's own title and state,
 * linked to its own detail page, and whether it is still holding this task
 * up. `unmet` comes from `blockingDependencies` (tasks.ts) rather than being
 * worked out again here — that function is already the one place "has this
 * dependency been accepted" is decided, and re-deriving it here risks the two
 * disagreeing the moment either one changes. */
function renderDependencyRow(dep: Task | undefined, depId: TaskId, unmet: Set<TaskId>): string {
  const status = unmet.has(depId)
    ? `<span class="pill rejected">unmet</span>`
    : `<span class="pill accepted">met</span>`;

  if (!dep) {
    // A dependsOn pointing nowhere is exactly as unmet as one pointing at
    // real, unfinished work (see blockingDependencies' own doc comment), and
    // a human looking at a stalled task deserves to see that plainly rather
    // than a broken link.
    return `<tr>
      <td class="mono">${escapeHtml(depId)}</td>
      <td class="empty">no such task</td>
      <td>${status}</td>
    </tr>`;
  }

  return `<tr>
    <td><a href="/task?id=${q(dep.id)}">${escapeHtml(dep.title)}</a> <span class="id">${escapeHtml(dep.id)}</span></td>
    <td><span class="pill ${dep.state}">${escapeHtml(dep.state)}</span></td>
    <td>${status}</td>
  </tr>`;
}

/**
 * Claim and submission, together, because they are really one story told in
 * two possible chapters: who is holding the task now, and — if it has ever
 * been handed in — what was handed in and where to see it change. A fresh
 * task has neither, and says so in one line rather than drawing two empty
 * boxes for a state that is completely ordinary.
 */
function renderClaimAndSubmission(room: Room, task: Task, nameOf: (id: MemberId) => string): string {
  const parts: string[] = [];

  if (task.claimedBy) {
    parts.push(
      `<p>Claimed by <strong>${escapeHtml(nameOf(task.claimedBy))}</strong> at ` +
        `${escapeHtml(task.claimedAt ?? "")}, expires ${escapeHtml(task.claimExpiresAt ?? "")}.</p>`,
    );
  }

  if (task.submittedBy) {
    const artifacts = task.submittedArtifacts ?? [];
    const rows = artifacts
      .map((path) => {
        // The whole reason `submittedAtSeq` is recorded at all (see
        // task.submitted in types.ts): a reviewer does not want the default
        // diff (whatever the last two versions happen to be), it wants
        // exactly what changed between what this submission was based on and
        // what the path holds right now. Falling back to the default-diff
        // link only when there is no such sequence to anchor to.
        const link =
          task.submittedAtSeq !== undefined
            ? `<a href="/diff?path=${q(path)}&from=${task.submittedAtSeq}&to=${room.log.head()}">diff since submission</a>`
            : listVersions(room, path).filter((v) => v.kind === "written").length >= 2
              ? `<a href="/diff?path=${q(path)}">view diff</a>`
              : `<span class="empty">one version</span>`;
        return `<tr><td class="mono">${escapeHtml(path)}</td><td>${link}</td></tr>`;
      })
      .join("");

    parts.push(`
      <p>Submitted by <strong>${escapeHtml(nameOf(task.submittedBy))}</strong> at ${escapeHtml(
        task.submittedAt ?? "",
      )}${task.submittedAtSeq !== undefined ? ` (based on log #${task.submittedAtSeq})` : ""}:</p>
      <div class="note" style="margin-bottom:12px">${escapeHtml(task.submissionSummary ?? "")}</div>
      ${rows ? `<div class="card"><table><tr><th>artifact</th><th></th></tr>${rows}</table></div>` : ""}
    `);
  }

  if (parts.length === 0) {
    return `<p class="empty">Nobody has claimed this task yet.</p>`;
  }
  return parts.join("");
}

/**
 * Everything the room knows about one task: `atrium task show`'s content,
 * built for a page instead of a terminal. The one thing worth doing here that
 * a terminal does not — see the module doc and the task this was built
 * against — is the rejection history as an actual sequence (`taskRejections`)
 * instead of the bare attempt count `cmdTaskShow` prints, because "3
 * attempts" and "rejected for X, then for X again, then for Y" are different
 * facts and only the log holds the second one.
 *
 * `getTask` throws `NotFoundError` for an id that does not exist, and that is
 * left to propagate: `route`'s caller already turns an `AtriumError` into a
 * readable page with the room's own message, and re-catching it here would
 * only be a second copy of that same handling.
 *
 * This page does not join the live SSE region system the room page uses
 * (`REGION_EVENTS` and friends, below). It was a real option, not an
 * afterthought: a reader staring at one task while it gets claimed or rejected
 * out from under them is exactly the moment liveness earns its keep. It loses
 * to a plainer argument — everything this page shows (a rejection history, a
 * dependency's state, a claim's expiry) is read once and re-read on refresh
 * just fine, unlike the room page's log, which would be actively misleading
 * frozen. Wiring a second live surface would mean either widening
 * `regionsTouchedBy` to know about a specific task id (every event handler
 * gaining a "does this event mention *this* task" branch) or running a whole
 * second poll loop per open detail page, and this codebase's stated bias is
 * against machinery a page has not earned. A reader who wants to watch a task
 * change in real time still can: the board page they clicked in from already
 * flashes the moment it changes.
 */
function renderTaskDetailPage(room: Room, taskId: TaskId): string {
  const task = getTask(room, taskId);
  const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
  const nameOf = (id: MemberId): string => names.get(id) ?? id;

  const byId = new Map(listTasks(room).map((t) => [t.id, t] as const));
  const unmet = new Set(blockingDependencies(task, byId));

  const escalatedNote = task.escalated
    ? `<div class="note" style="margin-bottom:22px">This task escalated after ${task.attempts} rejection${
        task.attempts === 1 ? "" : "s"
      } and is frozen until a human restarts it (see "atrium task restart").</div>`
    : "";

  const description =
    task.description.trim() === ""
      ? `<p class="empty">No description.</p>`
      : `<pre class="brief">${escapeHtml(task.description)}</pre>`;
  const expectedOutput = task.expectedOutput
    ? `<section><h2>Expected output</h2>
        <pre class="brief">${escapeHtml(task.expectedOutput.description)}</pre>
        ${
          task.expectedOutput.schema !== undefined
            ? `<pre>${escapeHtml(JSON.stringify(task.expectedOutput.schema, null, 2))}</pre>`
            : ""
        }
      </section>`
    : "";

  const dependencies =
    task.dependsOn.length === 0
      ? `<p class="empty">This task has no dependencies.</p>`
      : `<div class="card"><table>
          <tr><th>task</th><th>state</th><th></th></tr>
          ${task.dependsOn.map((id) => renderDependencyRow(byId.get(id), id, unmet)).join("")}
        </table></div>`;

  const rejections = taskRejections(room, task.id);
  const rejectionsBody =
    rejections.length === 0
      ? `<p class="empty">This task has not been rejected.</p>`
      : `<div class="card"><table>
          <tr><th>when</th><th>by</th><th>reason</th></tr>
          ${rejections
            .map(
              (r) => `<tr>
                <td class="mono">#${r.seq} · ${escapeHtml(shortTime(r.at))}</td>
                <td>${escapeHtml(nameOf(r.by))}</td>
                <td>${escapeHtml(r.reason)}</td>
              </tr>`,
            )
            .join("")}
        </table></div>`;

  const body = `
<div class="crumb"><a href="/">← room</a></div>
<header class="masthead">
  <h1>${escapeHtml(task.title)}</h1>
  <div class="meta">
    <span class="pill ${task.state}">${escapeHtml(task.state)}</span>
    <span class="mono">${escapeHtml(task.id)}</span>
    <span>${escapeHtml(describeAcceptance(task.acceptance))}</span>
  </div>
</header>
${escalatedNote}
<section><h2>Description</h2>${description}</section>
${expectedOutput}
<section><h2>Dependencies</h2>${dependencies}</section>
<section><h2>Claim &amp; submission</h2>${renderClaimAndSubmission(room, task, nameOf)}</section>
<section><h2>Rejection history${
    task.attempts > 0 ? ` · ${task.attempts} attempt${task.attempts === 1 ? "" : "s"}` : ""
  }</h2>${rejectionsBody}</section>
`;

  return page(`${task.title} — atrium watch`, body);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Starts the watch UI and resolves once it is listening.
 *
 * Nothing reachable from here mutates the room: non-GET methods are refused
 * before routing, and every handler below only reads. That is the property
 * that makes serving this without a token defensible at all, so it is enforced
 * structurally rather than left as a convention for future routes to remember.
 */
export function serveWatch(
  room: Room,
  options: ServeWatchOptions = {},
): Promise<WatchServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const streams = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    try {
      route(room, pollMs, streams, req, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // An AtriumError is the room refusing something for a reason its own
      // message explains — a path that tries to escape the room, say. Anything
      // else is a bug here, and saying so is more use than a blank 500.
      const message = isAtriumError(err)
        ? err.message
        : "Something went wrong rendering this page.";
      sendHtml(
        res,
        isAtriumError(err) ? 400 : 500,
        page(
          "atrium watch",
          `<div class="crumb"><a href="/">← room</a></div><div class="note">${escapeHtml(
            message,
          )}</div>`,
        ),
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        host,
        port: address.port,
        url: `http://${host}:${address.port}/`,
        close: () =>
          new Promise<void>((done, fail) => {
            // An open SSE response keeps the socket alive, so close() would
            // hang forever waiting on streams that are never going to end on
            // their own. They are ended here first.
            for (const stream of streams) stream.end();
            streams.clear();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function route(
  room: Room,
  pollMs: number,
  streams: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // Read-only, enforced here rather than per-route so that adding a route
  // later cannot accidentally open a writable one.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    sendHtml(
      res,
      405,
      page(
        "atrium watch",
        `<div class="note">This is a read-only view of the room. Only GET is supported. To act on a room, use the CLI or the MCP endpoint.</div>`,
      ),
    );
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/") {
    sendHtml(res, 200, renderRoomPage(room));
    return;
  }

  if (url.pathname === "/events") {
    streamEvents(room, pollMs, streams, req, res, Number(url.searchParams.get("from") ?? "0"));
    return;
  }

  if (url.pathname === "/task") {
    const id = url.searchParams.get("id");
    if (!id) {
      sendHtml(
        res,
        400,
        page(
          "atrium watch",
          `<div class="crumb"><a href="/">← room</a></div><div class="note">A task page needs an id: /task?id=task_abc123</div>`,
        ),
      );
      return;
    }
    // A bogus id throws NotFoundError out of getTask, which the caller of
    // `route` already turns into a readable 400 page carrying the room's own
    // message — see the doc comment on renderTaskDetailPage.
    sendHtml(res, 200, renderTaskDetailPage(room, id));
    return;
  }

  if (url.pathname === "/diff") {
    const path = url.searchParams.get("path");
    if (!path) {
      sendHtml(
        res,
        400,
        page(
          "atrium watch",
          `<div class="crumb"><a href="/">← room</a></div><div class="note">A diff needs a path: /diff?path=draft.md</div>`,
        ),
      );
      return;
    }
    const from = numberParam(url.searchParams.get("from"));
    const to = numberParam(url.searchParams.get("to"));
    sendHtml(res, 200, renderDiffPage(room, path, from, to));
    return;
  }

  sendHtml(
    res,
    404,
    page(
      "atrium watch",
      `<div class="note">No page at ${escapeHtml(url.pathname)}. <a href="/">Back to the room.</a></div>`,
    ),
  );
}

function numberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Live board: keeping folded regions in step with the log
// ---------------------------------------------------------------------------

/**
 * Which on-page region a given event type can change, folded the same way
 * `board.ts` folds tasks: not every event is board-shaped. A `cost.reported`
 * changes a number nobody is watching live; a `task.claimed` changes exactly
 * one card on the board. Listing the few event types that matter per region,
 * rather than re-rendering everything whenever anything happens, is the
 * difference between "live" and "a heartbeat that happens to redraw the page
 * every second."
 *
 * This is deliberately a second, smaller classification than `describeEvent`
 * in context.ts: that function answers "what happened, in words" for every
 * event type because the log has to explain itself completely; this one only
 * answers "does anything folded on screen need to be redrawn," which most
 * event types — leases, notes, cost reports — answer "no."
 */
const REGION_EVENTS = {
  agents: new Set<EventType>([
    "member.joined",
    "member.left",
    "task.created",
    "task.claimed",
    "task.claim_renewed",
    "task.released",
    "task.blocked",
    "task.unblocked",
    "task.submitted",
    "task.accepted",
    "task.rejected",
    "task.escalated",
    "task.unescalated",
  ]),
  board: new Set<EventType>([
    "task.created",
    "task.claimed",
    "task.released",
    "task.blocked",
    "task.unblocked",
    "task.submitted",
    "task.accepted",
    "task.rejected",
    "task.escalated",
    "task.unescalated",
  ]),
  roster: new Set<EventType>(["member.joined", "member.left"]),
  artifacts: new Set<EventType>(["artifact.written", "artifact.deleted", "artifact.pruned"]),
  // A pinned artifact's content is shown inline in the brief (see
  // renderPinnedArtifact), so writing or deleting one can change what the
  // brief displays and how many tokens it costs, not just the artifact list.
  brief: new Set<EventType>([
    "context.pinned",
    "context.unpinned",
    "artifact.written",
    "artifact.deleted",
  ]),
  halted: new Set<EventType>(["room.halted"]),
} as const satisfies Record<string, ReadonlySet<EventType>>;

type Region = keyof typeof REGION_EVENTS;

function regionsTouchedBy(types: EventType[]): Set<Region> {
  const touched = new Set<Region>();
  for (const type of types) {
    for (const region of Object.keys(REGION_EVENTS) as Region[]) {
      if (REGION_EVENTS[region].has(type)) touched.add(region);
    }
  }
  return touched;
}

function renderBoardFragment(room: Room): string {
  const names = new Map(room.roster().map((m) => [m.id, m.name] as const));
  return renderBoard(listTasks(room), names);
}

function renderBriefFragment(
  room: Room,
): { budget: string; body: string; tokens: number; ceiling: number } {
  const context = getContext(room);
  return {
    budget: renderContextBudget(context),
    body: renderBrief(room, context),
    tokens: context.tokens,
    ceiling: context.ceiling,
  };
}

const HALTED_NOTE = `<div class="note" style="margin-bottom:22px">This room has halted. It is still readable, but it will not accept further work.</div>`;

/**
 * Server-Sent Events over a poll of the log.
 *
 * Polling rather than watching: the log is SQLite on disk and may be appended
 * to by an entirely different process (a stdio MCP server, the CLI), so there
 * is no in-process event to subscribe to and a poll is the honest mechanism
 * rather than a lazy one. Each tick asks only for entries after the last one
 * sent, so a quiet room costs one indexed query per second and sends nothing.
 *
 * This is also the one mechanism the whole live board is built on, chosen
 * over the alternatives ARCHITECTURE.md's brief for this feature raised:
 * a client-side poll of its own would be a second polling loop next to a
 * stream that already exists, and a plain client-side re-fetch-on-event would
 * mean every browser tab re-runs the full page render whenever anything
 * happens, including the events (a cost report, a lease renewal) that leave
 * every folded region unchanged. Instead this single tick — the one already
 * running for the log — also asks which regions the events it just fetched
 * would change (`regionsTouchedBy`), and pushes *only those* down the same
 * SSE connection as small, pre-rendered, pre-escaped HTML fragments tagged
 * with a named event per region. The client's job stays exactly as dumb as
 * it was for the log: take a string, put it in an element, do not parse or
 * decide anything.
 */
function streamEvents(
  room: Room,
  pollMs: number,
  streams: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
  fromSeq: number,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  streams.add(res);

  let last = Number.isInteger(fromSeq) && fromSeq >= 0 ? fromSeq : 0;

  const tick = (): void => {
    let fresh: HistoryLine[];
    try {
      fresh = describeHistory(room, { from: last + 1 });
    } catch {
      // The room went away underneath us — closed, or its directory removed.
      // Ending the stream lets the browser show "disconnected" rather than a
      // log that has silently stopped moving.
      clearInterval(timer);
      streams.delete(res);
      res.end();
      return;
    }

    if (fresh.length === 0) {
      // A comment frame, which SSE ignores, but which keeps intermediaries
      // from deciding an idle connection is a dead one.
      res.write(": still here\n\n");
      return;
    }
    for (const line of fresh) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
      last = line.seq;
    }

    // The log lines above are the whole story for the log itself. Everything
    // from here down is the board catching up to what those lines just said,
    // and only the regions those specific event types can affect — a room
    // that only ever sees lease renewals and cost reports sends log lines
    // and this one small counter, never a single agents/board/roster/artifacts/brief
    // re-render.
    const meta: Record<string, string> = { head: `log at #${last}` };
    const touched = regionsTouchedBy(fresh.map((line) => line.type));
    if (touched.has("agents")) {
      res.write(`event: agents\ndata: ${JSON.stringify(renderAgentFloor(room))}\n\n`);
    }
    if (touched.has("roster")) {
      const n = room.roster().length;
      meta.members = `${n} member${n === 1 ? "" : "s"}`;
    }
    if (touched.has("board")) {
      const n = listTasks(room).length;
      meta.tasks = `${n} task${n === 1 ? "" : "s"}`;
      res.write(`event: board\ndata: ${JSON.stringify(renderBoardFragment(room))}\n\n`);
    }
    if (touched.has("roster")) {
      res.write(`event: roster\ndata: ${JSON.stringify(renderRoster(room))}\n\n`);
    }
    if (touched.has("artifacts")) {
      res.write(`event: artifacts\ndata: ${JSON.stringify(renderArtifacts(room))}\n\n`);
    }
    if (touched.has("brief")) {
      const fragment = renderBriefFragment(room);
      meta.tokens = `${fragment.tokens}/${fragment.ceiling} context tokens`;
      res.write(`event: brief\ndata: ${JSON.stringify(fragment)}\n\n`);
    }
    if (touched.has("halted") && room.isHalted()) {
      res.write(`event: halted\ndata: ${JSON.stringify(HALTED_NOTE)}\n\n`);
    }
    res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
  };

  const timer = setInterval(tick, pollMs);
  // Node keeps the process alive for a pending timer; a watch stream should
  // not be the reason a CLI refuses to exit.
  timer.unref?.();

  const stop = (): void => {
    clearInterval(timer);
    streams.delete(res);
  };
  req.on("close", stop);
  res.on("close", stop);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // Nothing here is a stable representation: the board moves under you.
    "cache-control": "no-store",
    // The page loads no external assets. Keep every network source closed so
    // injected remote scripts or images fail even if escaping ever regresses.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
  });
  res.end(html);
}
