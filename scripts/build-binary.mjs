/**
 * Builds the single-file executable.
 *
 * Node's SEA support is the reason this is a script rather than three lines in
 * a workflow: it takes four steps, two of them platform-dependent, and each
 * one fails in a way that is quiet rather than loud. The bundle step compiles
 * `import.meta` away to an empty object instead of erroring; the inject step
 * happily produces a binary that starts and exits without doing anything. Both
 * of those cost a debugging session before this script existed, which is why
 * it verifies the result at the end rather than trusting that four successful
 * commands add up to a working program.
 *
 * The four steps:
 *
 *  1. Bundle to CommonJS. Node SEA cannot take an ES module entry, and this
 *     package is ESM throughout, so the source is bundled rather than shipped.
 *     The version is injected here because a packaged binary has no
 *     package.json next to it to read one from.
 *  2. Turn the bundle into a SEA blob.
 *  3. Copy the running Node binary — that is what the executable *is*, with
 *     the program appended to it, which is why these come out around 80 MB.
 *  4. Inject the blob into the copy.
 *
 * Cross-compiling is not possible: step 3 copies *this* platform's Node, so a
 * macOS binary has to be built on macOS. That is why the release workflow uses
 * the same three-OS matrix the tests do.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildSync } from "esbuild";
import { inject } from "postject";

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BUILD = "build";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const isWindows = process.platform === "win32";
const exeName = isWindows ? "atrium.exe" : "atrium";
const exePath = join(BUILD, exeName);

/**
 * Both build tools are used through their JavaScript APIs rather than their
 * command lines, and that is not a style preference — it is the third attempt
 * at this, after the first two broke on platforms they were not written on.
 *
 * Going through `npx` needs a shell on Windows (`npx.cmd`), and a Windows
 * shell eats the quotes in `--define:X="1.0"`. Escaping them to survive it
 * then passes the escaped form through literally on Linux and macOS, where
 * there is no shell, and esbuild rejects it. Dropping the shell does not help:
 * Node refuses to spawn a `.cmd` at all since the fix for CVE-2024-27980.
 *
 * Invoking the installed binary directly fails differently. On Windows
 * `node_modules/esbuild/bin/esbuild` is a JavaScript shim, so `node` can run
 * it; on Linux and macOS that same path *is* the native executable, and `node`
 * reports a syntax error trying to parse it.
 *
 * There is no argument to quote and no path to guess when the tool is just a
 * function. `run` remains only for Node's own SEA step, which has no API.
 */
function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

mkdirSync(BUILD, { recursive: true });

console.log(`> bundling (version ${pkg.version})`);
buildSync({
  entryPoints: ["src/sea.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(BUILD, "atrium.cjs"),
  // The value is JSON, so a string needs its quotes. Passed as data rather
  // than as text on a command line, nothing can strip them.
  define: { __ATRIUM_VERSION__: JSON.stringify(pkg.version) },
});

console.log("> preparing the SEA blob");
writeFileSync(
  join(BUILD, "sea-config.json"),
  JSON.stringify(
    {
      main: join(BUILD, "atrium.cjs"),
      output: join(BUILD, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", join(BUILD, "sea-config.json")]);

console.log("> copying the node binary");
copyFileSync(process.execPath, exePath);
if (!isWindows) chmodSync(exePath, 0o755);

console.log("> injecting");
await inject(exePath, "NODE_SEA_BLOB", readFileSync(join(BUILD, "sea-prep.blob")), {
  sentinelFuse: FUSE,
  // Only meaningful on macOS, ignored elsewhere; without it the injected
  // binary fails its own signature check and refuses to start.
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
});

// The step that makes the rest trustworthy. A SEA that was assembled wrongly
// still produces a large, plausible-looking file; the only way to know it is a
// program is to run it. `--version` also proves the injected version arrived,
// which is the one thing about this build that silently degrades rather than
// failing.
console.log("> checking the result runs");
const reported = execFileSync(exePath, ["--version"], { encoding: "utf8" }).trim();
if (reported !== pkg.version) {
  throw new Error(
    `The built binary reports version "${reported}" but package.json says "${pkg.version}". ` +
      `That usually means the bundler did not receive the version define, and it would ship as a ` +
      `binary that cannot tell anyone what it is.`,
  );
}

console.log(`\n${exePath} — ${reported} — ok`);
