import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapeHtml, serveWatch, type WatchServerHandle } from "./watch.js";
import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { writeArtifact } from "./artifacts.js";
import { claimTask, createTask } from "./board.js";
import { reviewTask, submitTask } from "./acceptance.js";
import { pinArtifact } from "./context.js";
import { pruneVersions } from "./snapshots.js";
import { reportCost } from "./cost.js";

const created: Array<{ room: Room; dir: string }> = [];
const servers: WatchServerHandle[] = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-watch-"));
  const room = Room.create(join(dir, "job"), config);
  created.push({ room, dir });
  return room;
}

afterEach(async () => {
  while (servers.length) {
    await servers.pop()!.close();
  }
  while (created.length) {
    const entry = created.pop()!;
    try {
      entry.room.close();
    } catch {
      // already closed
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

async function start(room: Room, pollMs = 25): Promise<WatchServerHandle> {
  const handle = await serveWatch(room, { port: 0, pollMs });
  servers.push(handle);
  return handle;
}

async function get(handle: WatchServerHandle, path = "/"): Promise<{ status: number; body: string }> {
  const res = await fetch(new URL(path, handle.url));
  return { status: res.status, body: await res.text() };
}

/**
 * Reads an open SSE response until `until` is satisfied or a deadline passes,
 * the same "keep reading past the keep-alive comment frames" pattern the
 * existing live-stream tests already use, generalised so the new tests below
 * can wait for a named event (`event: board`, `event: meta`, ...) instead of
 * just a line of text.
 */
async function collectSse(
  res: Response,
  until: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(seen) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return seen;
}

describe("escapeHtml", () => {
  it("neutralises the characters that could close a tag or an attribute", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes the ampersand first, so entities are not double-escaped", () => {
    // "&lt;" written literally by a member must come back as the text they
    // typed, not be decoded into a real "<" by the browser.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("serveWatch", () => {
  it("binds to 127.0.0.1 by default and picks a free port", async () => {
    const handle = await start(tempRoom());
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.port).toBeGreaterThan(0);
  });

  it("renders the room's real content, not a placeholder", async () => {
    const room = tempRoom({ name: "newsroom" });
    const scout = room.join({
      name: "scout",
      role: "worker",
      manifest: "reads sources and takes notes",
      tags: ["research"],
    }).member;
    createTask(room, scout.id, { title: "Draft the opening" });

    const { status, body } = await get(await start(room));

    expect(status).toBe(200);
    expect(body).toContain("newsroom");
    expect(body).toContain("Draft the opening");
    expect(body).toContain("scout");
    expect(body).toContain("reads sources and takes notes");
    expect(body).toContain("research");
    expect(body).toContain('class="notebook-rail"');
    expect(body).toContain('href="#board-section"');
    expect(body).toContain('class="workspace"');
    expect(body).toContain("room notebook");
    expect(body).toContain('id="agent-floor"');
    expect(body).toContain("What every agent is doing right now");
    expect(body).toContain("Ready for work");
  });

  it("shows an animated preview crew when the room has no real members yet", async () => {
    const { body } = await get(await start(tempRoom()));

    expect(body).toContain("Preview crew");
    expect(body).toContain('data-preview="true"');
    expect(body).toContain("Scout");
    expect(body).toContain("Builder");
    expect(body).toContain("Critic");
    expect(body).toContain("Researching");
    expect(body).toContain("Building");
    expect(body).toContain("Reviewing work");
  });

  it("shows a claimed task as a real agent actively working", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "Ada", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "Build the live map" });
    claimTask(room, worker.id, task.id);

    const { body } = await get(await start(room));

    expect(body).toContain('data-status="working"');
    expect(body).toContain("Ada");
    expect(body).toContain("Working now");
    expect(body).toContain("Build the live map");
    expect(body).not.toContain("Preview crew");
  });

  it("escapes member and task text that could otherwise inject markup", async () => {
    const room = tempRoom();
    const m = room.join({ name: `<img src=x onerror=alert(1)>`, role: "worker" }).member;
    createTask(room, m.id, { title: `</h1><script>alert(2)</script>` });

    const { body } = await get(await start(room));

    // The dangerous forms must not survive anywhere in the document.
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("<script>alert(2)</script>");
    // The text itself is still shown, escaped.
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("is self-contained: nothing is fetched from another host", async () => {
    const { body } = await get(await start(tempRoom()));
    expect(body).not.toMatch(/src="https?:\/\//);
    expect(body).not.toMatch(/href="https?:\/\//);
    expect(body).not.toContain("cdn.");
  });
});

describe("the brief (Tier 1 context)", () => {
  it("shows the room's actual CONTEXT.md text", async () => {
    const room = tempRoom();
    writeFileSync(
      room.paths.context,
      "# Welcome\n\nThis room drafts the launch post.\n",
      "utf8",
    );

    const { body } = await get(await start(room));
    expect(body).toContain("This room drafts the launch post.");
  });

  it("escapes HTML in the brief rather than rendering it", async () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, `<img src=x onerror=alert(1)>`, "utf8");

    const { body } = await get(await start(room));
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("says the brief is empty rather than drawing an empty box, for a fresh room", async () => {
    const room = tempRoom();
    writeFileSync(room.paths.context, "", "utf8");

    const { body } = await get(await start(room));
    expect(body).toContain("CONTEXT.md is empty");
  });

  it("shows a pinned artifact with its path and a link to its diff view", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "notes.md");
    writeArtifact(room, w.id, "notes.md", "first draft of the notes\n");
    writeArtifact(room, w.id, "notes.md", "second draft of the notes\n");
    pinArtifact(room, w.id, "notes.md");

    const { body } = await get(await start(room));

    expect(body).toContain("notes.md");
    expect(body).toContain("second draft of the notes");
    expect(body).toContain(`href="/diff?path=notes.md"`);
  });

  it("makes an over-ceiling context total obvious rather than clamping it", async () => {
    // Room.create's own CONTEXT.md is already bigger than a ceiling of 5
    // tokens, the same fixture context.test.ts uses to prove getContext
    // reports the real total instead of hiding it.
    const room = tempRoom({ config: { contextTokenCeiling: 5 } });

    const { body } = await get(await start(room));

    expect(body).toContain(`class="pill rejected"`);
    expect(body).toContain("over ceiling");
  });
});

describe("read-only", () => {
  it("refuses every method that is not a read, and changes nothing", async () => {
    const room = tempRoom();
    const before = room.log.head();
    const handle = await start(room);

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(handle.url, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }

    expect(room.log.head()).toBe(before);
  });

  it("leaves the log untouched after serving every page it has", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "draft.md");
    writeArtifact(room, w.id, "draft.md", "one\n");
    writeArtifact(room, w.id, "draft.md", "two\n");
    const task = createTask(room, w.id, { title: "Draft the opening" });

    const handle = await start(room);
    const before = room.log.head();

    await get(handle, "/");
    await get(handle, "/diff?path=draft.md");
    await get(handle, `/task?id=${task.id}`);
    await get(handle, "/task?id=does-not-exist");
    await get(handle, "/nope");

    expect(room.log.head()).toBe(before);
  });

  it("says plainly that a missing page is missing", async () => {
    const { status, body } = await get(await start(tempRoom()), "/wp-admin");
    expect(status).toBe(404);
    expect(body).toContain("No page at /wp-admin");
  });
});

describe("diff pages", () => {
  it("shows a unified diff between the last two versions by default", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "draft.md");
    writeArtifact(room, w.id, "draft.md", "one\ntwo\n");
    writeArtifact(room, w.id, "draft.md", "one\nTWO\n");

    const { status, body } = await get(await start(room), "/diff?path=draft.md");

    expect(status).toBe(200);
    expect(body).toContain("draft.md");
    expect(body).toContain("class=\"l del\"");
    expect(body).toContain("class=\"l add\"");
    expect(body).toContain("TWO");
  });

  it("reports a pruned version as unavailable rather than drawing it as empty", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "draft.md");
    const v1 = writeArtifact(room, w.id, "draft.md", "the original text\n");
    const v2 = writeArtifact(room, w.id, "draft.md", "the replacement\n");
    pruneVersions(room, { retain: 1 });

    const { body } = await get(
      await start(room),
      `/diff?path=draft.md&from=${v1.seq}&to=${v2.seq}`,
    );

    expect(body).toContain("no longer retained");
    // The lie this guards against: showing the pruned side as an empty file
    // and every one of its lines as an addition.
    expect(body).not.toContain("class=\"l add\"");
  });

  it("says binary files differ instead of attempting a line diff", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "logo.png");
    writeArtifact(room, w.id, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeArtifact(room, w.id, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x02]));

    const { body } = await get(await start(room), "/diff?path=logo.png");

    expect(body).toContain("Binary files");
    expect(body).not.toContain("class=\"l add\"");
  });

  it("explains itself when there is only one version to compare", async () => {
    const room = tempRoom();
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "draft.md");
    writeArtifact(room, w.id, "draft.md", "only one\n");

    const { body } = await get(await start(room), "/diff?path=draft.md");
    expect(body).toContain("only one recorded version");
  });

  it("refuses a path that tries to escape the room, with the room's own message", async () => {
    const { status, body } = await get(
      await start(tempRoom()),
      "/diff?path=" + encodeURIComponent("../../etc/passwd"),
    );
    expect(status).toBe(400);
    expect(body).not.toContain("root:");
  });

  it("needs a path", async () => {
    const { status, body } = await get(await start(tempRoom()), "/diff");
    expect(status).toBe(400);
    expect(body).toContain("A diff needs a path");
  });
});

describe("task detail page", () => {
  it("shows the task's expected-output contract", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, {
      title: "Draft the opening",
      expectedOutput: {
        description: "Two polished paragraphs.",
        schema: { type: "string", minLength: 100 },
      },
    });

    const { body } = await get(await start(room), `/task?id=${task.id}`);

    expect(body).toContain("Expected output");
    expect(body).toContain("Two polished paragraphs.");
    expect(body).toContain("&quot;minLength&quot;: 100");
  });

  it("shows a claimed task's holder and claim expiry", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "scout", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "Draft the opening" });
    const claimed = claimTask(room, worker.id, task.id);

    const { status, body } = await get(await start(room), `/task?id=${task.id}`);

    expect(status).toBe(200);
    expect(body).toContain("Draft the opening");
    expect(body).toContain("Claimed by <strong>scout</strong>");
    expect(body).toContain(claimed.claimExpiresAt);
  });

  it("shows a rejection history with two distinct reasons, in order", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const reviewer = room.join({ name: "reviewer", role: "reviewer" }).member;
    const task = createTask(room, worker.id, { title: "Ship the report" });

    claimTask(room, worker.id, task.id);
    await submitTask(room, worker.id, task.id, { summary: "first pass" });
    reviewTask(room, reviewer.id, task.id, { accept: false, reason: "missing citations" });

    claimTask(room, worker.id, task.id);
    await submitTask(room, worker.id, task.id, { summary: "second pass" });
    reviewTask(room, reviewer.id, task.id, { accept: false, reason: "wrong tone" });

    const { body } = await get(await start(room), `/task?id=${task.id}`);

    expect(body).toContain("missing citations");
    expect(body).toContain("wrong tone");
    expect(body).toContain("2 attempts");
    // The whole point of a history over a count: two different reasons show
    // up in the order they actually happened.
    expect(body.indexOf("missing citations")).toBeLessThan(body.indexOf("wrong tone"));
  });

  it("names a blocked task's specific unmet dependency, linked to its own page", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const research = createTask(room, worker.id, { title: "Research the topic" });
    const draft = createTask(room, worker.id, {
      title: "Draft the opening",
      dependsOn: [research.id],
    });

    const { body } = await get(await start(room), `/task?id=${draft.id}`);

    expect(body).toContain("Research the topic");
    expect(body).toContain(`href="/task?id=${research.id}"`);
    expect(body).toContain(`class="pill blocked"`);
    expect(body).toContain(`class="pill rejected">unmet</span>`);
  });

  it("answers honestly when the task id does not exist", async () => {
    const { status, body } = await get(await start(tempRoom()), "/task?id=task_bogus");

    expect(status).toBe(400);
    expect(body).toContain("No task task_bogus in this room");
  });

  it("needs an id", async () => {
    const { status, body } = await get(await start(tempRoom()), "/task");
    expect(status).toBe(400);
    expect(body).toContain("A task page needs an id");
  });

  it("escapes a task title and a rejection reason, both attacker-influenced", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const reviewer = room.join({ name: "reviewer", role: "reviewer" }).member;
    const task = createTask(room, worker.id, {
      title: `</h1><script>alert(1)</script>`,
    });
    claimTask(room, worker.id, task.id);
    await submitTask(room, worker.id, task.id, { summary: "done" });
    reviewTask(room, reviewer.id, task.id, {
      accept: false,
      reason: `<img src=x onerror=alert(2)>`,
    });

    const { body } = await get(await start(room), `/task?id=${task.id}`);

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("<img src=x onerror");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("is GET-only, like every other page", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "Draft the opening" });
    const handle = await start(room);

    const res = await fetch(new URL(`/task?id=${task.id}`, handle.url), { method: "POST" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("links to it from the board", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "Draft the opening" });

    const { body } = await get(await start(room), "/");

    expect(body).toContain(`href="/task?id=${task.id}"`);
  });

  it("reads as an ordinary fresh task rather than a page of empty sections", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    const task = createTask(room, worker.id, { title: "Draft the opening" });

    const { body } = await get(await start(room), `/task?id=${task.id}`);

    expect(body).toContain("This task has no dependencies.");
    expect(body).toContain("Nobody has claimed this task yet.");
    expect(body).toContain("This task has not been rejected.");
  });
});

describe("live event stream", () => {
  it("sends events appended after the stream opened", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Something happens in the room while the stream is open.
    room.join({ name: "latecomer", role: "worker" });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    // Read until the joined event arrives or the stream gives up. Keep-alive
    // comment frames arrive in between and are simply skipped over.
    while (!seen.includes("latecomer")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(seen).toContain("latecomer");
    expect(seen).toContain("data: ");
  });

  it("closes open streams when the server is asked to stop", async () => {
    const room = tempRoom();
    const handle = await serveWatch(room, { port: 0, pollMs: 20 });

    const res = await fetch(new URL("/events", handle.url));
    const reader = res.body!.getReader();

    // Without ending live streams first, close() would wait on this socket
    // forever, because an SSE response never ends on its own.
    await handle.close();

    const { done } = await reader.read().catch(() => ({ done: true }));
    expect(done === true || done === false).toBe(true);
  });
});

describe("the live board", () => {
  it("includes an accessible task filter and reapplies it after live board updates", async () => {
    const room = tempRoom();
    const worker = room.join({ name: "worker", role: "worker" }).member;
    createTask(room, worker.id, { title: "Draft the opening" });

    const { body } = await get(await start(room));

    expect(body).toContain('<label for="task-filter">Filter tasks</label>');
    expect(body).toContain('id="task-filter" type="search"');
    expect(body).toContain('id="task-filter-status" aria-live="polite"');
    expect(body).toContain('taskFilter.addEventListener("input", applyTaskFilter)');
    expect(body).toContain('if (id === "board") applyTaskFilter()');
  });

  it("still serves the full board, roster, artifacts and brief on first paint, before any script runs", async () => {
    const room = tempRoom();
    const scout = room.join({ name: "scout", role: "worker" }).member;
    createTask(room, scout.id, { title: "Draft the opening" });

    const { body } = await get(await start(room));

    // These are the containers the live stream later swaps into; first paint
    // has to hold real content in every one of them, not an empty shell that
    // JavaScript is trusted to fill in.
    expect(body).toMatch(/<div id="board">[\s\S]*Draft the opening[\s\S]*<\/div>/);
    expect(body).toMatch(/<div id="roster">[\s\S]*scout[\s\S]*<\/div>/);
    expect(body).toContain('<div id="artifacts">');
    expect(body).toContain('<div id="brief">');
    expect(body).toContain('<div id="agent-floor">');
    expect(body).toContain('id="hdr-members"');
    expect(body).toContain('id="hdr-tasks"');
    expect(body).toContain('id="hdr-tokens"');
    expect(body).toContain('id="hdr-head"');
  });

  it("pushes a re-rendered board fragment over the stream when a task event happens", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);
    const worker = room.join({ name: "worker", role: "worker" }).member;

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    createTask(room, worker.id, { title: "Draft the opening" });

    const seen = await collectSse(res, (t) => t.includes("event: board"));

    expect(seen).toContain("event: board");
    expect(seen).toContain("event: agents");
    expect(seen).toContain("Draft the opening");
  });

  it("escapes attacker-controlled content in a fragment pushed live, the same as first paint", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);
    const worker = room.join({ name: "worker", role: "worker" }).member;

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    createTask(room, worker.id, { title: `</h1><script>alert(2)</script>` });

    const seen = await collectSse(res, (t) => t.includes("event: board"));

    // The raw log line (a separate, unnamed SSE message) carries the title
    // verbatim on purpose: the client inserts it with textContent, never
    // innerHTML, exactly like renderLogLine's own escaping is beside the
    // point for that path. The board fragment is different — it is HTML the
    // client drops in with innerHTML — so it is that payload specifically,
    // not the whole SSE transcript, that must never carry the raw tag.
    const boardPayload = seen.match(/event: board\ndata: (.*)\n/)?.[1] ?? "";
    expect(boardPayload).not.toContain("<script>alert(2)</script>");
    expect(boardPayload).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("pushes a roster fragment and updated header counts when a member joins", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    room.join({ name: "newcomer", role: "worker" });

    const seen = await collectSse(res, (t) => t.includes("event: meta"));

    expect(seen).toContain("event: roster");
    expect(seen).toContain("event: agents");
    expect(seen).toContain("newcomer");
    expect(seen).toContain("event: meta");
    expect(seen).toMatch(/"members":"1 member"/);
  });

  it("pushes an artifacts fragment, and the brief along with it, when a pinned artifact changes", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);
    const w = room.join({ name: "w", role: "worker" }).member;
    acquireLease(room, w.id, "notes.md");
    writeArtifact(room, w.id, "notes.md", "first draft\n");
    pinArtifact(room, w.id, "notes.md");

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    writeArtifact(room, w.id, "notes.md", "second draft, now longer\n");

    const seen = await collectSse(res, (t) => t.includes("event: brief"));

    expect(seen).toContain("event: artifacts");
    expect(seen).toContain("event: brief");
    expect(seen).toContain("second draft, now longer");
  });

  it("pushes the halted banner over the stream the moment the room halts", async () => {
    const room = tempRoom({ config: { actionBudget: 2 } });
    const handle = await start(room, 20);

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    room.join({ name: "a", role: "worker" });
    expect(() => room.join({ name: "b", role: "worker" })).toThrow();

    const seen = await collectSse(res, (t) => t.includes("event: halted"));

    expect(seen).toContain("event: halted");
    expect(seen).toContain("This room has halted");
  });

  it("does not re-render the board, roster, artifacts or brief for an event none of them fold", async () => {
    const room = tempRoom();
    const handle = await start(room, 20);
    const w = room.join({ name: "worker", role: "worker" }).member;

    const res = await fetch(new URL(`/events?from=${room.log.head()}`, handle.url));
    reportCost(room, w.id, { amountUsd: 1.5 });

    // The cost report still shows up as a log line...
    const seen = await collectSse(res, (t) => t.includes("reported $1.50"));
    expect(seen).toContain("reported $1.50");

    // ...but a cost report doesn't fold into anything the board shows, so
    // none of the region events should have fired for it.
    expect(seen).not.toContain("event: board");
    expect(seen).not.toContain("event: roster");
    expect(seen).not.toContain("event: agents");
    expect(seen).not.toContain("event: artifacts");
    expect(seen).not.toContain("event: brief");
    expect(seen).not.toContain("event: halted");
  });
});
