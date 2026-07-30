import { describe, expect, it } from "vitest";

import { parseYaml } from "./yaml.js";

describe("parseYaml", () => {
  describe("mappings", () => {
    it("reads a flat mapping of scalars", () => {
      expect(
        parseYaml(["name: newsroom", "count: 3", "ready: true", "note:"].join("\n")),
      ).toEqual({ name: "newsroom", count: 3, ready: true, note: null });
    });

    it("nests by indentation", () => {
      const doc = parseYaml(
        ["tasks:", "  research:", "    title: Gather sources", "  draft:", "    title: Write it"].join(
          "\n",
        ),
      );
      expect(doc).toEqual({
        tasks: {
          research: { title: "Gather sources" },
          draft: { title: "Write it" },
        },
      });
    });

    it("keeps the order keys were written in", () => {
      const doc = parseYaml(["c: 1", "a: 2", "b: 3"].join("\n")) as Record<string, unknown>;
      expect(Object.keys(doc)).toEqual(["c", "a", "b"]);
    });

    it("refuses a duplicate key rather than keeping the last one", () => {
      expect(() => parseYaml(["a: 1", "a: 2"].join("\n"))).toThrow(/line 2: duplicate key "a"/);
    });

    it("does not split a value containing a colon without a following space", () => {
      expect(parseYaml("url: https://example.com/x")).toEqual({
        url: "https://example.com/x",
      });
    });

    it("allows a quoted key that contains a colon and a space", () => {
      expect(parseYaml('"a: b": yes please')).toEqual({ "a: b": "yes please" });
    });
  });

  describe("sequences", () => {
    it("reads a block sequence of scalars", () => {
      expect(parseYaml(["items:", "  - one", "  - two"].join("\n"))).toEqual({
        items: ["one", "two"],
      });
    });

    it("reads a block sequence of mappings", () => {
      expect(
        parseYaml(
          ["workers:", "  - name: codex", "    command: codex exec", "  - name: claude"].join("\n"),
        ),
      ).toEqual({
        workers: [
          { name: "codex", command: "codex exec" },
          { name: "claude" },
        ],
      });
    });

    it("reads a bare dash with the item indented beneath it", () => {
      expect(parseYaml(["items:", "  -", "    name: a", "  -", "    name: b"].join("\n"))).toEqual({
        items: [{ name: "a" }, { name: "b" }],
      });
    });

    it("reads a document that is a sequence at the top level", () => {
      expect(parseYaml(["- a", "- b"].join("\n"))).toEqual(["a", "b"]);
    });
  });

  describe("flow collections", () => {
    it("reads a flow list", () => {
      expect(parseYaml("dependsOn: [research, draft]")).toEqual({
        dependsOn: ["research", "draft"],
      });
    });

    it("reads an empty flow list and mapping", () => {
      expect(parseYaml(["a: []", "b: {}"].join("\n"))).toEqual({ a: [], b: {} });
    });

    it("reads a flow mapping with a quoted value containing a comma", () => {
      expect(parseYaml('acceptance: { kind: command, command: "npm test, please" }')).toEqual({
        acceptance: { kind: "command", command: "npm test, please" },
      });
    });

    it("nests flow collections", () => {
      expect(parseYaml("a: [{ b: 1 }, [2, 3]]")).toEqual({ a: [{ b: 1 }, [2, 3]] });
    });

    it("tolerates a trailing comma", () => {
      expect(parseYaml("a: [1, 2,]")).toEqual({ a: [1, 2] });
    });

    it("refuses a flow list that is never closed", () => {
      expect(() => parseYaml("a: [1, 2")).toThrow(/line 1: expected "," or "\]"/);
    });

    it("refuses a flow mapping key with no colon after it", () => {
      expect(() => parseYaml("a: { b }")).toThrow(/line 1: expected ":" after the key "b"/);
    });

    it("refuses a duplicate key inside a flow mapping", () => {
      expect(() => parseYaml("a: { b: 1, b: 2 }")).toThrow(/duplicate key "b"/);
    });
  });

  describe("block scalars", () => {
    it("keeps the line breaks of a literal block and ends with one newline", () => {
      expect(parseYaml(["context: |", "  first", "  second"].join("\n"))).toEqual({
        context: "first\nsecond\n",
      });
    });

    it("strips the final newline with |-", () => {
      expect(parseYaml(["context: |-", "  first", "  second"].join("\n"))).toEqual({
        context: "first\nsecond",
      });
    });

    it("folds line breaks into spaces with >", () => {
      expect(parseYaml(["context: >", "  first", "  second"].join("\n"))).toEqual({
        context: "first second\n",
      });
    });

    it("turns a blank line into a break when folding", () => {
      expect(parseYaml(["context: >-", "  one", "", "  two"].join("\n"))).toEqual({
        context: "one\ntwo",
      });
    });

    it("treats # inside a block scalar as content, not a comment", () => {
      expect(parseYaml(["context: |-", "  # a heading", "  body"].join("\n"))).toEqual({
        context: "# a heading\nbody",
      });
    });

    it("keeps relative indentation inside a block scalar", () => {
      expect(parseYaml(["context: |-", "  outer", "    inner"].join("\n"))).toEqual({
        context: "outer\n  inner",
      });
    });

    it("ends a block scalar where the indentation drops back", () => {
      expect(parseYaml(["context: |-", "  body", "name: after"].join("\n"))).toEqual({
        context: "body",
        name: "after",
      });
    });

    it("refuses the + chomping indicator rather than guessing", () => {
      expect(() => parseYaml(["a: |+", "  b"].join("\n"))).toThrow(
        /"\+" \(keep all trailing newlines\) is not supported/,
      );
    });
  });

  describe("scalars", () => {
    it("reads booleans, nulls, integers and floats", () => {
      expect(
        parseYaml(["a: true", "b: false", "c: null", "d: ~", "e: 42", "f: -1.5", "g: 1e3"].join("\n")),
      ).toEqual({ a: true, b: false, c: null, d: null, e: 42, f: -1.5, g: 1000 });
    });

    it("leaves YAML 1.1 booleans as text, the way YAML 1.2 does", () => {
      expect(parseYaml(["a: yes", "b: no", "c: on"].join("\n"))).toEqual({
        a: "yes",
        b: "no",
        c: "on",
      });
    });

    it("keeps a quoted number as text", () => {
      expect(parseYaml('a: "42"')).toEqual({ a: "42" });
    });

    it("unescapes a double-quoted string", () => {
      expect(parseYaml('a: "one\\ntwo\\u0021"')).toEqual({ a: "one\ntwo!" });
    });

    it("treats a doubled quote inside a single-quoted string as one quote", () => {
      expect(parseYaml("a: 'it''s here'")).toEqual({ a: "it's here" });
    });

    it("refuses an unterminated quoted string", () => {
      expect(() => parseYaml('a: "unclosed')).toThrow(/line 1: unterminated double-quoted string/);
    });
  });

  describe("comments and blank lines", () => {
    it("ignores whole-line comments and blank lines", () => {
      expect(parseYaml(["# leading", "", "a: 1", "", "# trailing", "b: 2"].join("\n"))).toEqual({
        a: 1,
        b: 2,
      });
    });

    it("strips a trailing comment from a value", () => {
      expect(parseYaml("a: hello  # a note")).toEqual({ a: "hello" });
    });

    it("keeps a # that is not preceded by whitespace", () => {
      expect(parseYaml("a: draft#2")).toEqual({ a: "draft#2" });
    });

    it("keeps a # inside a quoted string", () => {
      expect(parseYaml('a: "not # a comment"')).toEqual({ a: "not # a comment" });
    });
  });

  describe("what it refuses", () => {
    it("names the file and line in its errors", () => {
      expect(() => parseYaml(["a: 1", "a: 2"].join("\n"), { source: "job.yaml" })).toThrow(
        /^job\.yaml, line 2:/,
      );
    });

    it("refuses tabs used for indentation", () => {
      expect(() => parseYaml(["a:", "\tb: 1"].join("\n"))).toThrow(/indented with a tab/);
    });

    it("refuses anchors and aliases by name", () => {
      expect(() => parseYaml("a: &anchor 1")).toThrow(/an anchor is not supported/);
      expect(() => parseYaml("a: *anchor")).toThrow(/an alias is not supported/);
    });

    it("refuses tags and directives by name", () => {
      expect(() => parseYaml("a: !!str 1")).toThrow(/a tag is not supported/);
      expect(() => parseYaml(["%YAML 1.2", "a: 1"].join("\n"))).toThrow(
        /a directive is not supported/,
      );
    });

    it("refuses a multi-document file rather than reading only the first", () => {
      expect(() => parseYaml(["a: 1", "---", "b: 2"].join("\n"))).toThrow(
        /a document separator is not supported/,
      );
    });

    it("refuses a line that is neither a mapping entry nor a list item", () => {
      expect(() => parseYaml(["a: 1", "just some words"].join("\n"))).toThrow(
        /line 2: expected "key: value"/,
      );
    });

    it("refuses indentation that does not belong to anything", () => {
      expect(() => parseYaml(["a: 1", "  b: 2"].join("\n"))).toThrow(/line 2: unexpected indentation/);
    });

    it("reads an empty document as null rather than failing", () => {
      expect(parseYaml("")).toBeNull();
      expect(parseYaml("# only a comment\n")).toBeNull();
    });

    it("reads a file written with CRLF line endings the same as one without", () => {
      expect(parseYaml("a: 1\r\nb: |-\r\n  x\r\n")).toEqual({ a: 1, b: "x" });
    });
  });
});
