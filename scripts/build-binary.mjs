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

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BUILD = "build";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const isWindows = process.platform === "win32";
const exeName = isWindows ? "atrium.exe" : "atrium";
const exePath = join(BUILD, exeName);

/**
 * Nothing here runs through a shell, and nothing is fetched at build time.
 *
 * The obvious way to reach these tools is `npx`, which on Windows means
 * `npx.cmd`, which means `shell: true`. That works, and then quietly poisons
 * every argument: a Windows shell strips the quotes out of
 * `--define:X="1.0"`, so the quotes have to be escaped — and the escaped form
 * is passed through literally on Linux and macOS, where there is no shell to
 * remove them, and esbuild rejects a define value of `\"0.2.0\"`. That is not
 * hypothetical: it shipped, passed on Windows, and failed on both other
 * platforms the first time the release matrix ran.
 *
 * Dropping the shell is not enough either, because Node refuses to spawn a
 * `.cmd` without one (the fix for CVE-2024-27980), so `npx.cmd` fails with
 * EINVAL.
 *
 * So the tools are ordinary devDependencies, invoked as the JavaScript files
 * they are. No shell, so every argument arrives exactly as written on every
 * platform; and no `npx --yes`, so a release build resolves the same versions
 * the lockfile pins rather than whatever the registry serves that morning.
 */
function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function runNode(script, args) {
  run(process.execPath, [script, ...args]);
}

const ESBUILD = join("node_modules", "esbuild", "bin", "esbuild");
const POSTJECT = join("node_modules", "postject", "dist", "cli.js");

mkdirSync(BUILD, { recursive: true });

console.log(`> bundling (version ${pkg.version})`);
runNode(ESBUILD, [
  "src/sea.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  // Plain JSON quoting, which is what esbuild wants. No shell escaping,
  // because there is no shell — see `run` above for why that matters.
  `--define:__ATRIUM_VERSION__="${pkg.version}"`,
  `--outfile=${join(BUILD, "atrium.cjs")}`,
]);

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
runNode(POSTJECT, [
  exePath,
  "NODE_SEA_BLOB",
  join(BUILD, "sea-prep.blob"),
  "--sentinel-fuse",
  FUSE,
]);

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
