/**
 * A deliberately small YAML reader.
 *
 * ARCHITECTURE.md §8 sets a dependency budget and §12.1 spends part of the
 * reasoning behind this file: the subset a job file needs is narrow — nested
 * mappings, lists, scalars, and block strings — and the zero-runtime-dependency
 * property is worth more to this project than full YAML conformance. So this
 * parses that subset and refuses the rest loudly, by line number, rather than
 * guessing.
 *
 * The refusing is the point. A half-parser that silently misreads a document
 * is worse than no parser at all, because the failure surfaces later as a
 * board that does not match the file somebody wrote. Everything outside the
 * subset throws with the line it happened on.
 *
 * What is supported:
 *   - block mappings (`key: value`), nested by indentation
 *   - block sequences (`- item`), including `- key: value` maps in a list
 *   - flow collections on one line (`[a, b]`, `{k: v}`)
 *   - block scalars: `|` and `|-` (literal), `>` and `>-` (folded)
 *   - quoted strings, single and double, and plain scalars
 *   - `true` / `false`, `null` / `~`, integers, floats
 *   - `#` comments, on their own line or after a value
 *
 * What is not, and throws:
 *   - anchors, aliases, merge keys (`&`, `*`, `<<`)
 *   - tags (`!!str`), directives (`%YAML`), multiple documents in one file
 *   - flow collections spanning more than one line
 *   - tabs used for indentation
 *   - YAML 1.1 booleans (`yes`, `no`, `on`, `off`) — these stay strings, which
 *     is what YAML 1.2 does and what anyone writing `no` in a title wants
 *
 * If the subset ever has to grow to meet real files, take a real YAML
 * dependency instead. Growing a half-parser toward conformance is how this
 * file turns into the worst thing in the repository.
 */

import { InvalidError } from "./errors.js";

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export interface YamlParseOptions {
  /** Shown in error messages so a failure names the file it came from. */
  source?: string;
}

/** Constructs that mean something in real YAML and nothing here. Refusing
 * these by name gives a better error than letting them parse as plain text
 * and produce a document that quietly says something else. */
const UNSUPPORTED_LINE_PREFIXES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /^%/, what: "a directive" },
  { pattern: /^---\s*$/, what: "a document separator" },
  { pattern: /^\.\.\.\s*$/, what: "a document end marker" },
];

/** Same idea, for things that appear where a value does. */
const UNSUPPORTED_VALUE_PREFIXES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /^&\S/, what: "an anchor" },
  { pattern: /^\*\S/, what: "an alias" },
  { pattern: /^!/, what: "a tag" },
];

interface Cursor {
  /** Every line of the document, including blanks and comments, because a
   * block scalar has to read them back exactly as written. */
  lines: string[];
  /** Index of the next line to look at. */
  at: number;
  source: string;
}

export function parseYaml(text: string, options: YamlParseOptions = {}): YamlValue {
  const cursor: Cursor = {
    // Normalising line endings up front means a file written on Windows and a
    // file written anywhere else parse to the same document, and block
    // scalars do not end up with stray carriage returns inside their strings.
    lines: text.replace(/\r\n?/g, "\n").split("\n"),
    at: 0,
    source: options.source ?? "the job file",
  };

  for (const [index, line] of cursor.lines.entries()) {
    for (const { pattern, what } of UNSUPPORTED_LINE_PREFIXES) {
      if (pattern.test(line.trim())) {
        throw fail(cursor, index + 1, `${what} is not supported by Atrium's YAML subset`);
      }
    }
  }

  const first = nextSignificant(cursor);
  if (first === undefined) return null;

  const value = parseBlock(cursor, indentOf(cursor, first));

  const trailing = nextSignificant(cursor);
  if (trailing !== undefined) {
    throw fail(
      cursor,
      trailing + 1,
      "unexpected content after the end of the document — check the indentation here",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// lines
// ---------------------------------------------------------------------------

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/**
 * Index of the next line that carries structure, without consuming it.
 * Blank lines and whole-line comments are skipped everywhere except inside a
 * block scalar, which reads `cursor.lines` directly for exactly that reason.
 */
function nextSignificant(cursor: Cursor): number | undefined {
  let i = cursor.at;
  while (i < cursor.lines.length) {
    const line = cursor.lines[i]!;
    if (!isBlank(line) && !isComment(line)) {
      cursor.at = i;
      return i;
    }
    i++;
  }
  cursor.at = cursor.lines.length;
  return undefined;
}

function indentOf(cursor: Cursor, index: number): number {
  const line = cursor.lines[index]!;
  const width = line.length - line.trimStart().length;
  if (line.slice(0, width).includes("\t")) {
    throw fail(
      cursor,
      index + 1,
      "indented with a tab — YAML does not allow tabs for indentation, use spaces",
    );
  }
  return width;
}

function fail(cursor: Cursor, lineNumber: number, message: string): InvalidError {
  return new InvalidError(`${cursor.source}, line ${lineNumber}: ${message}`, {
    source: cursor.source,
    line: lineNumber,
  });
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

/** A mapping or a sequence, whichever the first line at this indent looks like. */
function parseBlock(cursor: Cursor, indent: number): YamlValue {
  const index = nextSignificant(cursor);
  if (index === undefined) return null;

  const body = cursor.lines[index]!.trim();
  return body.startsWith("- ") || body === "-"
    ? parseSequence(cursor, indent)
    : parseMapping(cursor, indent);
}

function parseMapping(cursor: Cursor, indent: number): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};

  for (;;) {
    const index = nextSignificant(cursor);
    if (index === undefined) break;

    const lineIndent = indentOf(cursor, index);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw fail(
        cursor,
        index + 1,
        "unexpected indentation — this line is indented further than the entry above it " +
          "but the entry above it is already a complete value",
      );
    }

    const line = cursor.lines[index]!;
    const split = splitKey(line.slice(indent));
    if (split === null) {
      throw fail(
        cursor,
        index + 1,
        `expected "key: value" here, got ${JSON.stringify(line.trim())}`,
      );
    }

    if (Object.hasOwn(result, split.key)) {
      // Real YAML leaves duplicate keys implementation-defined and most
      // readers keep the last. Refusing is better for a job file: a repeated
      // task name is a mistake somebody wants told about, not a silent
      // overwrite of work they thought they had declared.
      throw fail(cursor, index + 1, `duplicate key ${JSON.stringify(split.key)}`);
    }

    cursor.at = index + 1;
    result[split.key] = parseValueAfterKey(cursor, index, indent, split.rest);
  }

  return result;
}

function parseSequence(cursor: Cursor, indent: number): YamlValue[] {
  const result: YamlValue[] = [];

  for (;;) {
    const index = nextSignificant(cursor);
    if (index === undefined) break;

    const lineIndent = indentOf(cursor, index);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw fail(
        cursor,
        index + 1,
        "unexpected indentation inside a list — every item needs the same indentation as the first",
      );
    }

    const line = cursor.lines[index]!;
    const body = line.slice(indent);
    if (!body.startsWith("- ") && body !== "-") break;

    if (body === "-") {
      // A bare dash: the item is the indented block underneath it.
      cursor.at = index + 1;
      const nested = nextSignificant(cursor);
      if (nested === undefined || indentOf(cursor, nested) <= indent) {
        result.push(null);
        continue;
      }
      result.push(parseBlock(cursor, indentOf(cursor, nested)));
      continue;
    }

    const contentColumn = indent + 2 + countLeadingSpaces(body.slice(2));
    const rest = body.slice(2).trimStart();

    // `- key: value` starts a mapping that lives at the column the content
    // starts on. Blanking out the dash lets the ordinary mapping parser read
    // it — including any further keys indented to that same column — without
    // needing a second code path that would drift from this one.
    if (splitKey(rest) !== null) {
      cursor.lines[index] = " ".repeat(contentColumn) + rest;
      cursor.at = index;
      result.push(parseMapping(cursor, contentColumn));
      continue;
    }

    cursor.at = index + 1;
    result.push(parseValueAfterKey(cursor, index, indent, rest));
  }

  return result;
}

/**
 * The value half of `key:` — inline on the same line, or the block indented
 * beneath it. `keyIndent` is the indentation of the key, which is what a
 * nested block has to beat to belong to it.
 */
function parseValueAfterKey(
  cursor: Cursor,
  keyLineIndex: number,
  keyIndent: number,
  inline: string,
): YamlValue {
  const trimmed = stripComment(inline).trim();

  if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return parseBlockScalar(cursor, keyLineIndex, keyIndent, trimmed);
  }

  if (trimmed !== "") {
    for (const { pattern, what } of UNSUPPORTED_VALUE_PREFIXES) {
      if (pattern.test(trimmed)) {
        throw fail(
          cursor,
          keyLineIndex + 1,
          `${what} is not supported by Atrium's YAML subset`,
        );
      }
    }
    return parseInlineValue(cursor, keyLineIndex, trimmed);
  }

  // Nothing on the line: look for a block underneath.
  const nested = nextSignificant(cursor);
  if (nested === undefined) return null;

  const nestedIndent = indentOf(cursor, nested);
  if (nestedIndent <= keyIndent) return null;

  return parseBlock(cursor, nestedIndent);
}

/**
 * `|` and `|-` keep the line breaks; `>` and `>-` fold them into spaces. The
 * trailing `-` strips the final newline. `+` (keep every trailing newline) is
 * not supported, because nothing in a job file wants it and supporting it
 * means reproducing YAML's chomping rules exactly.
 */
function parseBlockScalar(
  cursor: Cursor,
  keyLineIndex: number,
  keyIndent: number,
  header: string,
): string {
  const match = /^([|>])([-+]?)$/.exec(header);
  if (match === null) {
    throw fail(
      cursor,
      keyLineIndex + 1,
      `unsupported block scalar header ${JSON.stringify(header)} — Atrium's YAML subset ` +
        'understands "|", "|-", ">", and ">-"',
    );
  }
  const folded = match[1] === ">";
  const chomp = match[2];
  if (chomp === "+") {
    throw fail(
      cursor,
      keyLineIndex + 1,
      '"+" (keep all trailing newlines) is not supported by Atrium\'s YAML subset',
    );
  }

  // Raw lines, comments and blanks included: inside a block scalar a `#` is
  // just a character and a blank line is content.
  const raw: string[] = [];
  let i = keyLineIndex + 1;
  let contentIndent: number | undefined;

  while (i < cursor.lines.length) {
    const line = cursor.lines[i]!;
    if (isBlank(line)) {
      raw.push("");
      i++;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= keyIndent) break;
    contentIndent ??= lineIndent;
    if (lineIndent < contentIndent) break;
    raw.push(line.slice(contentIndent));
    i++;
  }

  cursor.at = i;

  // Blank lines after the last real content belong to the document, not to
  // the scalar.
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  if (raw.length === 0) return "";

  if (!folded) {
    return chomp === "-" ? raw.join("\n") : raw.join("\n") + "\n";
  }

  // Folding: a run of blank lines becomes that many newlines minus one, and
  // every other break becomes a space. This is the common case of YAML's
  // folding rules — enough for prose in a brief, which is the only thing `>`
  // is used for here.
  let out = "";
  for (const [index, line] of raw.entries()) {
    if (index === 0) {
      out = line;
      continue;
    }
    if (line === "") {
      out += "\n";
      continue;
    }
    out += out.endsWith("\n") ? line : " " + line;
  }
  return chomp === "-" ? out : out + "\n";
}

function parseInlineValue(cursor: Cursor, lineIndex: number, text: string): YamlValue {
  if (text.startsWith("[") || text.startsWith("{")) {
    return parseFlow(cursor, lineIndex, text);
  }
  return interpretScalar(cursor, lineIndex, text);
}

// ---------------------------------------------------------------------------
// scalars and flow collections
// ---------------------------------------------------------------------------

function countLeadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * Removes a trailing `# comment` from a line, leaving `#` alone when it is
 * inside quotes or not preceded by whitespace (so `draft#2` stays intact).
 */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Splits `key: value` at the colon that separates them, respecting quotes so
 * a quoted key containing a colon still works. Returns null when the line is
 * not a mapping entry at all, which is how the block parser tells a mapping
 * from a sequence or a bare scalar.
 */
function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A colon only ends a key when a space or the end of the line follows it,
    // which is what keeps `http://example.com` from splitting.
    if (ch === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]!))) {
      const rawKey = text.slice(0, i).trim();
      if (rawKey === "") return null;
      if (rawKey.startsWith("[") || rawKey.startsWith("{")) return null;
      return { key: unquote(rawKey), rest: text.slice(i + 1) };
    }
    // A flow collection opening before any colon means this is a value, not a key.
    if (ch === "[" || ch === "{") return null;
  }
  return null;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return unescapeDouble(text.slice(1, -1));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    switch (escape) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return escape;
    }
  });
}

const INTEGER = /^-?\d+$/;
const FLOAT = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

function interpretScalar(cursor: Cursor, lineIndex: number, text: string): YamlValue {
  const trimmed = text.trim();

  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw fail(cursor, lineIndex + 1, "unterminated double-quoted string");
    }
    return unescapeDouble(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      throw fail(cursor, lineIndex + 1, "unterminated single-quoted string");
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (INTEGER.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (FLOAT.test(trimmed)) return Number.parseFloat(trimmed);
  return trimmed;
}

/**
 * `[a, b]` and `{k: v}`, on a single line. Multi-line flow collections are
 * legal YAML and are refused here: they interact with block indentation in
 * ways this parser does not model, and nothing in a job file needs them.
 */
function parseFlow(cursor: Cursor, lineIndex: number, text: string): YamlValue {
  let i = 0;

  const stop = (message: string): never => {
    throw fail(cursor, lineIndex + 1, message);
  };

  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };

  const readQuoted = (quote: string): string => {
    const start = i;
    i++; // opening quote
    let out = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (quote === '"' && ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        i++;
        return quote === '"' ? unescapeDouble(out) : out.replace(/''/g, "'");
      }
      out += ch;
      i++;
    }
    void start;
    return stop("unterminated quoted string inside a flow collection");
  };

  const readPlain = (): YamlValue => {
    const start = i;
    while (i < text.length && !",]}:".includes(text[i]!)) i++;
    const raw = text.slice(start, i).trim();
    if (raw === "") return stop("empty value inside a flow collection");
    for (const { pattern, what } of UNSUPPORTED_VALUE_PREFIXES) {
      if (pattern.test(raw)) {
        stop(`${what} is not supported by Atrium's YAML subset`);
      }
    }
    return interpretScalar(cursor, lineIndex, raw);
  };

  const readValue = (): YamlValue => {
    skipSpace();
    if (i >= text.length) return stop("a flow collection ended before its value");
    const ch = text[i]!;
    if (ch === "[") return readSequence();
    if (ch === "{") return readMapping();
    if (ch === '"' || ch === "'") return readQuoted(ch);
    return readPlain();
  };

  const readSequence = (): YamlValue[] => {
    i++; // "["
    const out: YamlValue[] = [];
    skipSpace();
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(readValue());
      skipSpace();
      const ch = text[i];
      if (ch === ",") {
        i++;
        skipSpace();
        // A trailing comma before the bracket is a typo worth allowing.
        if (text[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (ch === "]") {
        i++;
        return out;
      }
      return stop(`expected "," or "]" in a flow list, got ${describeAt(text, i)}`);
    }
  };

  const readMapping = (): Record<string, YamlValue> => {
    i++; // "{"
    const out: Record<string, YamlValue> = {};
    skipSpace();
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      skipSpace();
      const ch = text[i];
      const key =
        ch === '"' || ch === "'"
          ? readQuoted(ch)
          : String(
              (() => {
                const start = i;
                while (i < text.length && !":,]}".includes(text[i]!)) i++;
                const raw = text.slice(start, i).trim();
                if (raw === "") return stop("a flow mapping key cannot be empty");
                return raw;
              })(),
            );
      skipSpace();
      if (text[i] !== ":") {
        return stop(`expected ":" after the key ${JSON.stringify(key)} in a flow mapping`);
      }
      i++;
      if (Object.hasOwn(out, key)) {
        return stop(`duplicate key ${JSON.stringify(key)} in a flow mapping`);
      }
      out[key] = readValue();
      skipSpace();
      const next = text[i];
      if (next === ",") {
        i++;
        skipSpace();
        if (text[i] === "}") {
          i++;
          return out;
        }
        continue;
      }
      if (next === "}") {
        i++;
        return out;
      }
      return stop(`expected "," or "}" in a flow mapping, got ${describeAt(text, i)}`);
    }
  };

  const value = readValue();
  skipSpace();
  if (i < text.length) {
    stop(`unexpected ${describeAt(text, i)} after the end of a flow collection`);
  }
  return value;
}

function describeAt(text: string, index: number): string {
  return index >= text.length ? "the end of the line" : JSON.stringify(text[index]);
}
