import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { sep } from "node:path";

/**
 * Test runner for the standalone simulation repository.
 *
 * Discovery happens here, in Node, rather than in a shell glob. An npm script
 * like `--test "test/**\/*.test.ts"` behaves differently depending on who
 * expands the pattern: bash expands it before Node sees it, cmd.exe does not
 * expand it at all, and Node's own glob handling differs again by version. On
 * Windows that combination produced a runner that spawned eleven child
 * processes and hung indefinitely without reporting a single test.
 *
 * Passing explicit paths removes the shell from the question entirely, so the
 * same command means the same thing on Kaggle's Linux image and on Windows.
 *
 *   node scripts/test.mjs            all tests
 *   node scripts/test.mjs search     only files matching "search"
 *   node scripts/test.mjs --list     print the file list and exit
 */

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const filters = args.filter((a) => !a.startsWith("--"));

const files = globSync("test/**/*.test.ts")
  .map((f) => f.split(sep).join("/"))
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .sort();

if (files.length === 0) {
  console.error(
    filters.length > 0
      ? `no test files match: ${filters.join(", ")}`
      : "no test files found — is the working directory the repository root?",
  );
  process.exit(1);
}

if (listOnly) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} test files`);
  process.exit(0);
}

console.log(`running ${files.length} test files\n`);

// `--import tsx` rather than running through the tsx binary: the loader must be
// inherited by the child process the test runner spawns per file, and only the
// --import form propagates.
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  // Windows needs no shell here; passing paths directly avoids quoting entirely.
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`\ntest runner terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
