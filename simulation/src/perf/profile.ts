import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildWorkload, runWorkload } from "./workload.js";

/**
 * Where simulation time actually goes, measured rather than assumed.
 *
 * Run under V8's own sampling profiler so the measurement costs nothing in the
 * code being measured:
 *
 *   node --cpu-prof --cpu-prof-dir=runs/prof --import tsx simulation/src/perf/profile.ts
 *
 * Hand-placed timers were the obvious alternative and are the wrong tool here:
 * the AI decision path is called hundreds of thousands of times per match, so
 * instrumentation would dominate the thing it is trying to observe. The V8
 * profiler samples the stack instead, and attributes self-time to functions
 * without touching them.
 *
 * The script prints the workload result; the profile lands in the directory and
 * is summarised by `analyseProfile.ts`.
 */

const jobs = buildWorkload();
console.log(`workload: ${jobs.length} matches`);

const result = runWorkload(jobs);
console.log(`  matches       ${result.matches}`);
console.log(`  ticks         ${result.ticks}`);
console.log(`  wall          ${(result.wallMs / 1000).toFixed(1)}s`);
console.log(`  matches/sec   ${result.matchesPerSecond.toFixed(2)}`);
console.log(`  ticks/sec     ${Math.round(result.ticksPerSecond)}`);
console.log(`  fingerprint   ${result.fingerprint}`);
