import { availableParallelism, cpus, totalmem, freemem } from "node:os";
import { executeJobs, defaultWorkerCount } from "../evaluation/index.js";
import { buildWorkload, fingerprintOf } from "./workload.js";
import type { MatchJob, MatchOutcome } from "../evaluation/index.js";

/**
 * How throughput responds to worker count, on the machine you actually run it on.
 *
 * This exists because the production runner picks `cpu_count() - 1` workers and
 * nobody has checked whether that is right. On a 4-core Kaggle box that gives 3,
 * leaving a core for the main thread — a reasonable guess, and only a guess. The
 * main thread mostly waits on messages, so 4 might win; equally, 4 CPU-heavy
 * workers on 4 cores might just contend. Oversubscribed counts are included not
 * because they are expected to help but because "does it hurt, and how much" is
 * worth knowing before a multi-hour run.
 *
 *   node dist/simulation/src/perf/workerBench.js
 *   node dist/simulation/src/perf/workerBench.js --counts 1,2,3,4 --repeats 3
 *
 * Results are machine-specific. Numbers measured on a 12-core development box
 * say nothing about a 4-core Kaggle session — run it there.
 */

interface Row {
  workers: number;
  wallMs: number;
  matchesPerSecond: number;
  fingerprint: string;
  peakRssMb: number;
}

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};

const cores = availableParallelism();
const counts = arg("counts", defaultCounts(cores))
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 1);
const repeats = Number(arg("repeats", "2"));

/** Around the core count, plus enough oversubscription to see the penalty. */
function defaultCounts(n: number): string {
  const set = new Set<number>([1, 2, Math.max(1, n - 1), n, n + 1, n * 2]);
  return [...set].filter((x) => x >= 1 && x <= 32).sort((a, b) => a - b).join(",");
}

/**
 * Deliberately duel-heavy and small.
 *
 * The benchmark has to be cheap enough to run before a real experiment rather
 * than instead of one. Scaling behaviour is a property of the pool, not of the
 * match mix, so a shorter workload measures the same thing.
 */
const jobs: MatchJob[] = buildWorkload({
  duelPairings: 8,
  ffa4Compositions: 2,
  ffa7Compositions: 1,
});

function fingerprintOutcomes(outcomes: Map<string, MatchOutcome>): string {
  // Walk the PLAN, not the map: iteration order of a Map follows insertion,
  // which under a worker pool follows completion. Fingerprinting that would
  // report a difference every run and prove nothing.
  return fingerprintOf(
    jobs.map((job) => {
      const o = outcomes.get(job.id);
      return o
        ? `${o.id}|${o.winnerKingdom ?? "-"}|${o.endedAtTick}|${o.placements.join(",")}`
        : `${job.id}|MISSING`;
    }),
  );
}

async function measure(workers: number): Promise<Row> {
  const started = performance.now();
  const result = await executeJobs(jobs, { workers });
  const wallMs = performance.now() - started;
  if (result.failures.length > 0) {
    console.error(`  ${result.failures.length} job failures at ${workers} workers`);
  }
  return {
    workers,
    wallMs,
    matchesPerSecond: jobs.length / (wallMs / 1000),
    fingerprint: fingerprintOutcomes(result.outcomes),
    peakRssMb: process.memoryUsage().rss / 1024 / 1024,
  };
}

console.log("=".repeat(72));
console.log("WORKER SCALING BENCHMARK");
console.log("=".repeat(72));
console.log(`  host              ${cpus()[0]?.model?.trim() ?? "unknown"}`);
console.log(`  logical cores     ${cores}`);
console.log(`  memory            ${(totalmem() / 1024 ** 3).toFixed(1)} GB total, ${(freemem() / 1024 ** 3).toFixed(1)} GB free`);
console.log(`  runner default    ${defaultWorkerCount()} workers`);
console.log(`  workload          ${jobs.length} matches`);
console.log(`  counts            ${counts.join(", ")}`);
console.log(`  repeats           ${repeats}  (best of, to reduce the effect of a noisy sample)`);
console.log("");

// One untimed pass so JIT warm-up does not land entirely on the first count.
process.stdout.write("  warming up... ");
await executeJobs(jobs, { workers: Math.min(2, cores) });
console.log("done\n");

const best = new Map<number, Row>();
for (let repeat = 1; repeat <= repeats; repeat++) {
  // Interleaved by repeat rather than all repeats of one count together, so a
  // gradual change in machine load spreads across every count instead of
  // penalising whichever happened to run while something else was busy.
  for (const workers of counts) {
    const row = await measure(workers);
    const incumbent = best.get(workers);
    if (!incumbent || row.matchesPerSecond > incumbent.matchesPerSecond) best.set(workers, row);
    process.stdout.write(
      `  repeat ${repeat}  workers ${String(workers).padStart(2)}  ` +
        `${row.matchesPerSecond.toFixed(2)} match/s  ${(row.wallMs / 1000).toFixed(1)}s\n`,
    );
  }
}

const rows = [...best.values()].sort((a, b) => a.workers - b.workers);
const serial = rows.find((r) => r.workers === 1);
const fastest = rows.reduce((a, b) => (b.matchesPerSecond > a.matchesPerSecond ? b : a));

console.log("");
console.log("RESULTS (best of each)");
console.log("=".repeat(72));
console.log("  workers   match/s     wall     speedup   efficiency   RSS");
for (const row of rows) {
  const speedup = serial ? row.matchesPerSecond / serial.matchesPerSecond : NaN;
  const efficiency = speedup / row.workers;
  const mark = row.workers === fastest.workers ? "  <- fastest" : "";
  console.log(
    `  ${String(row.workers).padStart(7)}   ${row.matchesPerSecond.toFixed(2).padStart(7)}   ` +
      `${(row.wallMs / 1000).toFixed(1).padStart(6)}s   ${speedup.toFixed(2).padStart(6)}x   ` +
      `${(efficiency * 100).toFixed(0).padStart(9)}%   ${row.peakRssMb.toFixed(0).padStart(4)}MB${mark}`,
  );
}

// Determinism is the property that makes any of this usable: a worker count
// that were faster but changed outcomes would be worthless.
const fingerprints = new Set(rows.map((r) => r.fingerprint));
console.log("");
console.log(`  outcomes identical across every worker count: ${fingerprints.size === 1 ? "YES" : "NO"}`);
if (fingerprints.size !== 1) {
  console.log("  *** DETERMINISM BROKEN — worker count changed the results ***");
  for (const row of rows) console.log(`    workers ${row.workers}: ${row.fingerprint}`);
}

const current = defaultWorkerCount();
const currentRow = rows.find((r) => r.workers === current);
console.log("");
console.log("VERDICT");
console.log("=".repeat(72));
console.log(`  fastest here      ${fastest.workers} workers (${fastest.matchesPerSecond.toFixed(2)} match/s)`);
if (currentRow) {
  const delta = (fastest.matchesPerSecond / currentRow.matchesPerSecond - 1) * 100;
  console.log(`  runner default    ${current} workers (${currentRow.matchesPerSecond.toFixed(2)} match/s)`);
  console.log(
    delta < 2
      ? `  the default is within ${delta.toFixed(1)}% of the best — leave it alone`
      : `  ${fastest.workers} workers is ${delta.toFixed(1)}% faster than the default of ${current}`,
  );
}
console.log("");
console.log("  These numbers describe THIS machine. Run it on Kaggle before");
console.log("  changing the production worker count.");

process.exit(fingerprints.size === 1 ? 0 : 1);
