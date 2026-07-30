import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const room = resolve(process.argv[2] ?? process.env.ATRIUM_DEV_ROOM ?? join(repo, "demo-room"));
const host = "127.0.0.1";
const requestedPort = Number(process.env.PORT ?? 3000);
const node = process.execPath;
const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function portIsFree(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host, port }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function availablePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free local port found between ${start} and ${start + 19}.`);
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error(`PORT must be a whole number between 1 and 65535 (got ${process.env.PORT}).`);
}

console.log("Building Atrium...");
run(node, [tsc, "-p", join(repo, "tsconfig.json")]);

if (!existsSync(join(room, ".atrium", "room.json"))) {
  console.log(`Creating demo room at ${room}...`);
  run(node, [join(repo, "dist", "cli.js"), "init", room]);
}

const port = await availablePort(requestedPort);
const url = `http://localhost:${port}`;
console.log("");
console.log(`Atrium is ready: ${url}`);
console.log(`Room: ${room}`);
if (port !== requestedPort) {
  console.log(`Port ${requestedPort} was busy, so Atrium used ${port}.`);
}
console.log("Press Ctrl-C to stop.");
console.log("");

const child = spawn(
  node,
  [join(repo, "dist", "cli.js"), "watch", room, "--host", host, "--port", String(port)],
  {
    cwd: repo,
    stdio: "inherit",
    windowsHide: true,
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
