/**
 * Getting context, tier 2 (see ARCHITECTURE.md §4): on-demand full-text search
 * over the room's working directory.
 *
 * No embeddings, no vector store, by design: most rooms hold a few hundred
 * files, and at that size FTS beats semantic search on both precision and
 * setup cost. Add embeddings later if a real room proves this wrong, not
 * before.
 *
 * The index is built fresh, in memory, on every call rather than kept on disk
 * between calls. Rooms are small enough that walking the directory is cheap,
 * and a stale index quietly giving a wrong answer is a worse failure than
 * spending a few milliseconds rebuilding one. This also means there is no
 * on-disk index to keep in sync with writes, leases, or deletes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Db, openDb } from "./db.js";
import { InvalidError } from "./errors.js";
import { toArtifactPath } from "./paths.js";
import type { Room } from "./room.js";

export interface SearchHit {
  path: string;
  /** Higher is a better match. Derived from SQLite's bm25(), sign-flipped so
   * "higher is better" holds without callers needing to know FTS5 internals. */
  score: number;
  excerpt: string;
  bytes: number;
}

export interface SearchOptions {
  limit?: number;
  maxBytes?: number;
}

export interface IndexOptions {
  maxBytes?: number;
}

export interface IndexStats {
  files: number;
  skipped: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Directory names never walked into, wherever they appear in the tree. */
const SKIPPED_DIRS = new Set([".atrium", "node_modules", ".git", "dist"]);

/** How many leading bytes to check for a null byte when guessing binary. */
const BINARY_SNIFF_BYTES = 8000;

export function searchArtifacts(
  room: Room,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new InvalidError("limit must be a whole number, zero or more.");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  // Extracting only word-ish tokens, rather than trying to escape whatever the
  // caller sent, is what makes this safe against arbitrary input. Queries come
  // from language models: quotes, parens, `AND`/`OR`/`NOT`, bare `*`, anything.
  // None of those characters ever reach the FTS5 MATCH string because none of
  // them are word characters, so there is no escaping function to get subtly
  // wrong. A query with no word characters in it (empty, or only punctuation)
  // has nothing to search for, so it is answered with no results up front
  // rather than by asking FTS5 to parse something that isn't a query.
  const matchQuery = buildMatchQuery(query);
  if (!matchQuery || limit === 0) return [];

  const { db, files } = buildIndex(room, maxBytes);
  try {
    if (files === 0) return [];

    const rows = db
      .prepare(
        `SELECT path, bytes, bm25(docs) as rank,
                snippet(docs, 1, '', '', ' … ', 12) as excerpt
         FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?`,
      )
      .all<{ path: string; bytes: number; rank: number; excerpt: string }>(
        matchQuery,
        limit,
      );

    return rows.map((row) => ({
      path: row.path,
      score: -row.rank,
      excerpt: row.excerpt,
      bytes: row.bytes,
    }));
  } finally {
    db.close();
  }
}

/**
 * Walks the room and reports how much of it is searchable, without running a
 * query. Exposed mainly so a caller can tell "no results" apart from "nothing
 * was indexed" (e.g. an empty room, or everything over maxBytes).
 */
export function indexRoom(room: Room, options: IndexOptions = {}): IndexStats {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { db, files, skipped } = buildIndex(room, maxBytes);
  db.close();
  return { files, skipped };
}

function buildIndex(
  room: Room,
  maxBytes: number,
): { db: Db; files: number; skipped: number } {
  const db = openDb(":memory:");
  // `bytes` is UNINDEXED: it rides along for the SearchHit shape but has no
  // business being tokenized and searched.
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(path, body, bytes UNINDEXED)");
  const insert = db.prepare(
    "INSERT INTO docs (path, body, bytes) VALUES (?, ?, ?)",
  );

  let files = 0;
  let skipped = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, etc: not artifacts

      const bytes = statSync(abs).size;
      if (bytes > maxBytes) {
        skipped++;
        continue;
      }

      const buf = readFileSync(abs);
      if (looksBinary(buf)) {
        skipped++;
        continue;
      }

      insert.run(toArtifactPath(room.dir, abs), buf.toString("utf8"), bytes);
      files++;
    }
  };

  walk(room.dir);
  return { db, files, skipped };
}

function looksBinary(buf: Buffer): boolean {
  const scanLength = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < scanLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** A run of letters or digits, allowing internal `-`/`_`/`'` (e.g. "test-case"). */
const WORD_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

/**
 * Turns free text into an FTS5 MATCH string, or null if there is nothing in it
 * worth searching for.
 *
 * Every extracted token is individually double-quoted, which makes it a
 * phrase to FTS5 rather than an operator or a syntax character, and OR'd
 * together so a multi-word query is forgiving about which of its words a
 * document actually contains.
 */
function buildMatchQuery(raw: string): string | null {
  const tokens = raw.match(WORD_TOKEN);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
