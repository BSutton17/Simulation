import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Recursive file discovery, using only APIs that exist in Node 20.
 *
 * `fs.globSync` landed in Node 22. Kaggle runs Node 20.19.0, so importing it
 * throws `SyntaxError: The requested module 'node:fs' does not provide an
 * export named 'globSync'` at module load — before a single test runs, and with
 * an error that says nothing about test content. A local Node 24 will never
 * reproduce it.
 *
 * `readdirSync(dir, { withFileTypes: true })` has been available since Node 10.
 * `readdirSync(dir, { recursive: true })` would also work on 20.19, but it
 * arrived in 20.1 and would quietly reintroduce a floor inside the major
 * version this repository claims to support. Walking by hand has no floor at
 * all, and costs about ten lines.
 */

/** Directories never worth descending into. */
const SKIP = new Set(["node_modules", ".git", "dist", "runs", "coverage", ".vscode"]);

const toPosix = (p) => p.split(sep).join("/");

/**
 * Every file under `dir` for which `matches(relativePosixPath)` is true.
 *
 * Paths are returned POSIX-style and sorted, so a run on Windows and a run on
 * Linux produce the same list in the same order. Test discovery that depended
 * on platform ordering would make a failure reproducible on one machine and not
 * the other.
 */
export function findFiles(dir, matches) {
  const out = [];
  walk(dir, out, matches);
  return out.sort();
}

function walk(dir, out, matches) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a directory that does not exist contributes nothing
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (isDirectory(entry, full)) walk(full, out, matches);
    else if (matches(toPosix(full))) out.push(toPosix(full));
  }
}

/**
 * Whether to descend into this entry.
 *
 * ⚠️ NOT `entry.isDirectory()` ALONE, BECAUSE THIS TREE LIVES UNDER OneDrive. Files On-Demand
 * dehydrates anything untouched for a while, and a dehydrated entry keeps a reparse tag on its
 * directory entry — so `readdirSync(..., { withFileTypes: true })` reports it as a SYMLINK, even once
 * the content is back, and even though `statSync` on the same path says "directory". Anything keyed on
 * the dirent type then silently skips the subtree.
 *
 * That exact bug cost real time in the sibling E-Football-Two/Server repo, where Jest's crawler skips
 * non-files for the same reason: `npm test` reported "70 suites, 1280 tests, all passed" for an unknown
 * length of time while the repo held 104 files and 1682 tests, hiding six genuine failures. Discovery
 * here is currently correct by accident — the file branch never asks `isFile()` — but the directory
 * branch does ask, and `test/support/` would vanish without a word if it were ever dehydrated.
 *
 * `statSync` follows the reparse point and answers correctly. It costs one syscall per entry.
 */
function isDirectory(entry, full) {
  if (entry.isDirectory()) return true;
  if (entry.isFile()) return false;          // the common case, settled without a syscall
  try { return statSync(full).isDirectory(); } catch { return false; }
}

/** Convenience: files under `dir` whose name ends with any of `extensions`. */
export function findByExtension(dir, ...extensions) {
  return findFiles(dir, (f) => extensions.some((ext) => f.endsWith(ext)));
}
