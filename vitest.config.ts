import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Rooms are backed by real SQLite files and real directories on disk, so
    // tests get a process each rather than sharing one sqlite connection.
    pool: "forks",
    testTimeout: 20_000,
  },
});
