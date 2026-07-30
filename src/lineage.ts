/**
 * Which task produced which version of which file.
 *
 * ARCHITECTURE.md §13.6, from Dagster's software-defined assets. Dagster
 * inverts the usual model: you declare the asset that should exist and what
 * produces it, and get lineage of actual artifacts rather than lineage of
 * task runs. §13.6 recorded this as the most plausible shape of a v1 and also
 * as a large change to the core model — the combination that should sit in a
 * document before anyone writes code.
 *
 * It turns out to split in two, and only one half is a change to the model.
 *
 * **The fact needs nothing new.** An `artifact.written` event records who
 * wrote a path and when. A `task.claimed` event records who was holding what.
 * Both are already in the log, in order — so "which task produced this
 * version" is a *derivation*, not a field somebody has to remember to fill
 * in. That is this file. It works on every room that already exists,
 * including ones written before the idea, because it reads history rather
 * than requiring it to have been annotated.
 *
 * **The declaration is the model change**, and it is `Task.produces` (§13.6
 * in the queue). It says what a task is *supposed* to produce. Having both
 * makes the interesting question askable: a task that declared `draft.md` and
 * submitted without writing it has a gap between intent and fact, and neither
 * half alone can see it.
 *
 * ## Why this is derived rather than recorded
 *
 * Recording the task id on `artifact.written` would be easier to read and
 * would be a second copy of something the log already implies — exactly the
 * drift §3.5 exists to avoid. A member can also write a file while holding no
 * claim at all, which is legitimate; that reads as lineage with no task, and
 * a recorded field would have had to invent something to put there.
 */

import { listArtifacts, listDeletedArtifacts } from "./artifacts.js";
import type { Room } from "./room.js";
import { listVersions } from "./snapshots.js";
import type { MemberId, TaskId } from "./types.js";

/** One version of a path, and the work that was in flight when it was written. */
export interface LineageEntry {
  /** Log position of the write or delete. */
  seq: number;
  ts: string;
  /** "written" or "deleted", matching `listVersions`. */
  kind: string;
  author: MemberId;
  hash?: string;
  bytes?: number;
  /** The task its author was holding at that moment, if any. */
  taskId?: TaskId;
  taskTitle?: string;
  /**
   * Which attempt at that task this write belongs to: 0 for the first go, 1
   * after one rejection, and so on. This is the part that makes lineage worth
   * having over a plain history — it distinguishes the draft that was turned
   * down from the one that replaced it.
   */
  attempt?: number;
}

interface ClaimState {
  taskId: TaskId;
  title: string;
  attempt: number;
}

/**
 * Every version of `path`, each attributed to the task its author was working
 * on at the time.
 *
 * A write by somebody holding no claim comes back with no task, which is a
 * real and legitimate case — a human dropping a file into the room, or an
 * agent writing something incidental — not a gap to paper over.
 */
export function artifactLineage(room: Room, path: string): LineageEntry[] {
  const versions = listVersions(room, path);
  if (versions.length === 0) return [];

  // One pass over task history, remembering who holds what and how many times
  // each task has come back. Walking forward is what makes `attempt` correct:
  // it is the count as of the write, not the count now.
  const events = room.log.read({
    types: [
      "task.created",
      "task.claimed",
      "task.released",
      "task.submitted",
      "task.accepted",
      "task.rejected",
    ],
  });

  const titles = new Map<TaskId, string>();
  const attempts = new Map<TaskId, number>();
  const holding = new Map<MemberId, ClaimState>();
  const byWrite = new Map<number, ClaimState>();

  let next = 0;
  const writeSeqs = versions.map((version) => version.seq).sort((a, b) => a - b);

  const snapshotUpTo = (seq: number): void => {
    while (next < writeSeqs.length && writeSeqs[next]! <= seq) {
      // Snapshot happens before the event at `seq` is applied, so a write and
      // a release at the same position attribute to the claim that was live.
      next++;
    }
  };

  for (const event of events) {
    // Attribute any writes that happened before this event.
    while (next < writeSeqs.length && writeSeqs[next]! < event.seq) {
      const writeSeq = writeSeqs[next]!;
      const author = versions.find((v) => v.seq === writeSeq)?.author;
      const held = author === undefined ? undefined : holding.get(author);
      if (held) byWrite.set(writeSeq, { ...held });
      next++;
    }

    switch (event.type) {
      case "task.created":
        titles.set(event.data.taskId, event.data.title);
        attempts.set(event.data.taskId, 0);
        break;
      case "task.claimed":
        holding.set(event.data.memberId, {
          taskId: event.data.taskId,
          title: titles.get(event.data.taskId) ?? event.data.taskId,
          attempt: attempts.get(event.data.taskId) ?? 0,
        });
        break;
      case "task.released":
      case "task.submitted":
      case "task.accepted":
        // Submitting ends the writing phase: anything after it belongs to the
        // next attempt, not this one.
        for (const [member, state] of holding) {
          if (state.taskId === event.data.taskId) holding.delete(member);
        }
        break;
      case "task.rejected":
        attempts.set(event.data.taskId, (attempts.get(event.data.taskId) ?? 0) + 1);
        for (const [member, state] of holding) {
          if (state.taskId === event.data.taskId) holding.delete(member);
        }
        break;
      default:
        break;
    }
  }

  // Anything written after the last task event.
  while (next < writeSeqs.length) {
    const writeSeq = writeSeqs[next]!;
    const author = versions.find((v) => v.seq === writeSeq)?.author;
    const held = author === undefined ? undefined : holding.get(author);
    if (held) byWrite.set(writeSeq, { ...held });
    next++;
  }
  snapshotUpTo(Infinity);

  return versions.map((version) => {
    const held = byWrite.get(version.seq);
    return {
      seq: version.seq,
      ts: version.ts,
      kind: version.kind,
      author: version.author,
      ...(version.hash !== undefined ? { hash: version.hash } : {}),
      ...(version.bytes !== undefined ? { bytes: version.bytes } : {}),
      ...(held
        ? { taskId: held.taskId, taskTitle: held.title, attempt: held.attempt }
        : {}),
    };
  });
}

export interface ProducedGap {
  taskId: TaskId;
  title: string;
  /** Declared in `produces` and never written by the time it was submitted. */
  missing: string[];
}

/**
 * Tasks that declared what they would produce and did not produce it.
 *
 * This is the question neither half could answer alone: `produces` is intent,
 * lineage is fact, and the gap between them is a thing worth showing a
 * reviewer before they accept.
 *
 * Deliberately a *report*, not a gate. §5 is careful about who gets to decide
 * a task is finished, and "the file it promised is missing" is evidence for
 * whoever is deciding rather than a verdict of its own — a task can be
 * legitimately submitted having changed its mind about what it needed to
 * write, and that is a conversation, not an error.
 */
export function producedGaps(room: Room, tasks: Array<{ id: TaskId; title: string; produces?: string[]; state: string }>): ProducedGap[] {
  const written = new Set<string>();
  for (const artifact of listArtifacts(room)) written.add(artifact.path);
  for (const deleted of listDeletedArtifacts(room)) written.add(deleted.path);

  const gaps: ProducedGap[] = [];
  for (const task of tasks) {
    if (!task.produces || task.produces.length === 0) continue;
    // Only worth asking once work has been handed in. Before that, "not
    // written yet" is just where the task is up to.
    if (task.state !== "submitted" && task.state !== "accepted") continue;

    const missing = task.produces.filter((path) => !written.has(path));
    if (missing.length > 0) gaps.push({ taskId: task.id, title: task.title, missing });
  }
  return gaps;
}
