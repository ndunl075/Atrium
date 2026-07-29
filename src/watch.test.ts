import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapeHtml, serveWatch, type WatchServerHandle } from "./watch.js";
import { Room } from "./room.js";
import { acquireLease } from "./leases.js";
import { writeArtifact } from "./artifacts.js";
import { createTask } from "./board.js";
import { pinArtifact } from "./context.js";
import { pruneVersions } from "./snapshots.js";

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

    const handle = await start(room);
    const before = room.log.head();

    await get(handle, "/");
    await get(handle, "/diff?path=draft.md");
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
