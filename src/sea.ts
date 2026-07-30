/**
 * Entry point for the single-executable build, and nothing else.
 *
 * `cli.ts` decides whether to run by comparing its own module URL against
 * `process.argv[1]`, so that importing it from a test never launches a
 * command. That check cannot work inside a packaged binary: there is no
 * module URL, and the bundler compiles `import.meta` away to an empty object
 * rather than complaining. The result would be an executable that starts,
 * finds it is apparently not the entry point, and exits silently having done
 * nothing at all.
 *
 * So the binary gets its own entry that simply calls `main`. One line, and it
 * exists so that the ordinary import-safety check does not have to be weakened
 * to accommodate packaging.
 */
import { main } from "./cli.js";

main();
