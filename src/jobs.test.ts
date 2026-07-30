import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyJob, parseJob } from "./jobs.js";
import { Room } from "./room.js";
import { listTasks } from "./board.js";
import type { MemberId } from "./types.js";

const dirs: string[] = [];
const rooms: Room[] = [];

function tempRoom(config?: Parameters<typeof Room.create>[1]): Room {
  const dir = mkdtempSync(join(tmpdir(), "atrium-jobs-"));
  dirs.push(dir);
  const room = Room.create(join(dir, "room"), config);
  rooms.push(room);
  return room;
}

function human(room: Room): MemberId {
  return room.join({ name: "operator", role: "human" }).member.id;
}

afterEach(() => {
  while (rooms.length) rooms.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MINIMAL = ["tasks:", "  research:", "    title: Gather sources"].join("\n");

describe("parseJob", () => {
  it("reads a job with a name, a brief, and tasks in file order", () => {
    const job = parseJob(
      [
        "name: newsroom",
        "context: |-",
        "  Cover the merger.",
        "  800 words.",
        "tasks:",
        "  research:",
        "    title: Gather sources",
        "    description: At least four, each with a working link.",
        "  draft:",
        "    title: Write the piece",
        "    dependsOn: [research]",
      ].join("\n"),
    );

    expect(job.name).toBe("newsroom");
    expect(job.context).toBe("Cover the merger.\n800 words.");
    expect(job.tasks).toEqual([
      {
        key: "research",
        title: "Gather sources",
        description: "At least four, each with a working link.",
        dependsOn: [],
      },
      { key: "draft", title: "Write the piece", dependsOn: ["research"] },
    ]);
  });

  it("defaults to no name and no brief when the file omits them", () => {
    const job = parseJob(MINIMAL);
    expect(job.name).toBeUndefined();
    expect(job.context).toBeUndefined();
  });

  it("accepts a single dependency written without brackets", () => {
    const job = parseJob(
      ["tasks:", "  a:", "    title: A", "  b:", "    title: B", "    dependsOn: a"].join("\n"),
    );
    expect(job.tasks[1]!.dependsOn).toEqual(["a"]);
  });

  describe("acceptance", () => {
    it("reads the shorthand form", () => {
      const job = parseJob(
        ["tasks:", "  a:", "    title: A", "    acceptance: human"].join("\n"),
      );
      expect(job.tasks[0]!.acceptance).toEqual({ kind: "human" });
    });

    it("reads a command acceptance with a timeout", () => {
      const job = parseJob(
        [
          "tasks:",
          "  a:",
          "    title: A",
          '    acceptance: { kind: command, command: "npm test", timeoutSeconds: 120 }',
        ].join("\n"),
      );
      expect(job.tasks[0]!.acceptance).toEqual({
        kind: "command",
        command: "npm test",
        timeoutSeconds: 120,
      });
    });

    it("leaves acceptance unset when the file does not say, so the room's default applies", () => {
      expect(parseJob(MINIMAL).tasks[0]!.acceptance).toBeUndefined();
    });

    it("refuses the command shorthand, which has no command to run", () => {
      expect(() =>
        parseJob(["tasks:", "  a:", "    title: A", "    acceptance: command"].join("\n")),
      ).toThrow(/needs the command to run/);
    });

    it("refuses a command acceptance with no command", () => {
      expect(() =>
        parseJob(
          ["tasks:", "  a:", "    title: A", "    acceptance: { kind: command }"].join("\n"),
        ),
      ).toThrow(/needs a non-empty "command" to run/);
    });

    it("refuses a timeout that could never fire or would kill the command at once", () => {
      for (const bad of ["0", "-5"]) {
        expect(() =>
          parseJob(
            [
              "tasks:",
              "  a:",
              "    title: A",
              `    acceptance: { kind: command, command: "x", timeoutSeconds: ${bad} }`,
            ].join("\n"),
          ),
        ).toThrow(/timeoutSeconds must be a finite number of seconds greater than 0/);
      }
    });

    it("refuses an unknown kind and lists the ones that work", () => {
      expect(() =>
        parseJob(["tasks:", "  a:", "    title: A", "    acceptance: vibes"].join("\n")),
      ).toThrow(/must be one of "command", "reviewer", "human", "none"/);
    });

    it('points at "kind" when the file says "type"', () => {
      expect(() =>
        parseJob(
          ["tasks:", "  a:", "    title: A", "    acceptance: { type: reviewer }"].join("\n"),
        ),
      ).toThrow(/the field is "kind"/);
    });
  });

  describe("what it refuses", () => {
    it("refuses an empty file", () => {
      expect(() => parseJob("")).toThrow(/is empty/);
    });

    it("refuses a file with no tasks section", () => {
      expect(() => parseJob("name: newsroom")).toThrow(/has no "tasks" section/);
    });

    it("refuses an empty tasks section", () => {
      expect(() => parseJob("tasks: {}")).toThrow(/declares no tasks/);
    });

    it("explains why tasks must be a mapping rather than a list", () => {
      expect(() => parseJob(["tasks:", "  - title: A"].join("\n"))).toThrow(
        /must be a mapping of name to task, not a list/,
      );
    });

    it("refuses a task with no title", () => {
      expect(() => parseJob(["tasks:", "  a:", "    description: x"].join("\n"))).toThrow(
        /task "a" needs a non-empty "title"/,
      );
    });

    it("refuses an unknown key instead of ignoring it", () => {
      expect(() =>
        parseJob(["tasks:", "  a:", "    title: A", "    priority: high"].join("\n")),
      ).toThrow(/task "a" does not understand "priority"/);
    });

    it("suggests the right key when one is misspelled", () => {
      expect(() => parseJob(["tasks:", "  a:", "    titel: A"].join("\n"))).toThrow(
        /did you mean "title"\?/,
      );
    });

    it("refuses an unknown key at the top level", () => {
      expect(() => parseJob(["agents: []", MINIMAL].join("\n"))).toThrow(
        /the top level of the job file does not understand "agents"/,
      );
    });

    it("refuses a dependency on a task that is not in the file, and lists the ones that are", () => {
      expect(() =>
        parseJob(["tasks:", "  a:", "    title: A", "    dependsOn: [ghost]"].join("\n")),
      ).toThrow(/depends on "ghost", which is not a task in this file. Known tasks: "a"/);
    });

    it("refuses a task that depends on itself", () => {
      expect(() =>
        parseJob(["tasks:", "  a:", "    title: A", "    dependsOn: [a]"].join("\n")),
      ).toThrow(/task "a" depends on itself/);
    });

    it("refuses a dependency cycle and shows the loop", () => {
      expect(() =>
        parseJob(
          [
            "tasks:",
            "  a:",
            "    title: A",
            "    dependsOn: [c]",
            "  b:",
            "    title: B",
            "    dependsOn: [a]",
            "  c:",
            "    title: C",
            "    dependsOn: [b]",
          ].join("\n"),
        ),
      ).toThrow(/depend on each other in a loop.*"a" → "c" → "b" → "a"/s);
    });

    it("refuses a purely numeric task name, which would not keep its place in the order", () => {
      expect(() => parseJob(["tasks:", "  1:", "    title: A"].join("\n"))).toThrow(
        /cannot be a plain number/,
      );
    });

    it("names the source file in its errors", () => {
      expect(() => parseJob("tasks: {}", "newsroom.yaml")).toThrow(/^newsroom\.yaml declares no/);
    });
  });
});

describe("applyJob", () => {
  it("puts every task on the board and reports the id each one got", () => {
    const room = tempRoom();
    const job = parseJob(
      [
        "tasks:",
        "  research:",
        "    title: Gather sources",
        "  draft:",
        "    title: Write the piece",
        "    dependsOn: [research]",
      ].join("\n"),
    );

    const applied = applyJob(room, human(room), job);

    expect([...applied.taskIds.keys()]).toEqual(["research", "draft"]);
    const tasks = listTasks(room);
    expect(tasks.map((t) => t.title)).toEqual(["Gather sources", "Write the piece"]);
  });

  it("resolves dependsOn from job keys to the ids the tasks were created under", () => {
    const room = tempRoom();
    const job = parseJob(
      [
        "tasks:",
        "  research:",
        "    title: Gather sources",
        "  draft:",
        "    title: Write the piece",
        "    dependsOn: [research]",
      ].join("\n"),
    );

    const applied = applyJob(room, human(room), job);
    const draft = listTasks(room).find((t) => t.title === "Write the piece")!;

    expect(draft.dependsOn).toEqual([applied.taskIds.get("research")]);
  });

  it("creates a dependency before the task that needs it, whatever order the file used", () => {
    const room = tempRoom();
    const job = parseJob(
      [
        "tasks:",
        "  draft:",
        "    title: Write the piece",
        "    dependsOn: [research]",
        "  research:",
        "    title: Gather sources",
      ].join("\n"),
    );

    const applied = applyJob(room, human(room), job);
    const created = listTasks(room);

    // The board is created dependency-first even though the file is not
    // written that way, because createTask validates dependency ids.
    expect(created.map((t) => t.title)).toEqual(["Gather sources", "Write the piece"]);
    expect(created[1]!.dependsOn).toEqual([applied.taskIds.get("research")]);
  });

  it("carries acceptance through to the board", () => {
    const room = tempRoom();
    const job = parseJob(
      [
        "tasks:",
        "  a:",
        "    title: A",
        '    acceptance: { kind: command, command: "npm test", timeoutSeconds: 30 }',
        "  b:",
        "    title: B",
        "    acceptance: human",
      ].join("\n"),
    );

    applyJob(room, human(room), job);
    const [a, b] = listTasks(room);

    expect(a!.acceptance).toEqual({ kind: "command", command: "npm test", timeoutSeconds: 30 });
    expect(b!.acceptance).toEqual({ kind: "human" });
  });

  it("falls back to the room's default acceptance when the job does not set one", () => {
    const room = tempRoom();
    applyJob(room, human(room), parseJob(MINIMAL));
    expect(listTasks(room)[0]!.acceptance).toEqual({ kind: "reviewer" });
  });

  it("writes the brief to CONTEXT.md and says it did", () => {
    const room = tempRoom();
    const applied = applyJob(
      room,
      human(room),
      parseJob(["context: |-", "  The brief.", MINIMAL].join("\n")),
    );

    expect(applied.wroteContext).toBe(true);
    expect(readFileSync(room.paths.context, "utf8")).toBe("The brief.\n");
  });

  it("leaves the starter CONTEXT.md alone when the job carries no brief", () => {
    const room = tempRoom();
    const before = readFileSync(room.paths.context, "utf8");

    const applied = applyJob(room, human(room), parseJob(MINIMAL));

    expect(applied.wroteContext).toBe(false);
    expect(readFileSync(room.paths.context, "utf8")).toBe(before);
  });

  it("is refused by a room that does not allow unchecked acceptance", () => {
    const room = tempRoom();
    const job = parseJob(
      ["tasks:", "  a:", "    title: A", "    acceptance: none"].join("\n"),
    );

    expect(() => applyJob(room, human(room), job)).toThrow(/does not allow "none" acceptance/);
  });

  it("lets a room that allows it seed a task with none acceptance", () => {
    const room = tempRoom({ config: { allowUncheckedAcceptance: true } });
    const job = parseJob(
      ["tasks:", "  a:", "    title: A", "    acceptance: none"].join("\n"),
    );

    applyJob(room, human(room), job);
    expect(listTasks(room)[0]!.acceptance).toEqual({ kind: "none" });
  });
});
