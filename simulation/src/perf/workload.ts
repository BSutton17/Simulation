import { planJobs, runJob, POPULATION_V1, balancedDuelPairings } from "../evaluation/index.js";

// Pinned to POPULATION_V1 is deliberate. This workload exists to detect
// PERFORMANCE and determinism drift, and its fingerprint is only meaningful if
// the work itself never changes. Following the active balance population would
// invalidate every recorded timing the moment the measuring instrument moved.
import type { MatchJob } from "../evaluation/index.js";

/**
 * A fixed, representative slice of simulation work.
 *
 * Every performance measurement in this directory runs THIS, so profiles,
 * benchmarks and worker-scaling numbers are all describing the same thing. A
 * benchmark whose workload drifts between runs measures the workload, not the
 * change under test.
 *
 * The mix matters: duels, 4-FFA and 7-FFA cost very different amounts per match
 * (roughly 1x, 1.9x and 2.9x), so a duel-only workload would understate how
 * much time the AI spends in the multi-seat games the search actually weights
 * most heavily.
 */

export interface WorkloadOptions {
  /** Duel pairings to include. Kept balanced, never a prefix. */
  duelPairings?: number;
  ffa4Compositions?: number;
  ffa7Compositions?: number;
  maxTicks?: number;
}

/** The standard profiling workload — small enough to iterate on, mixed enough
 *  to be representative. */
export const STANDARD: Required<WorkloadOptions> = {
  duelPairings: 6,
  ffa4Compositions: 3,
  ffa7Compositions: 2,
  maxTicks: 12000,
};

export function buildWorkload(options: WorkloadOptions = {}): MatchJob[] {
  const o = { ...STANDARD, ...options };
  return planJobs({
    pool: "training",
    population: POPULATION_V1,
    maxTicks: o.maxTicks,
    duel: { enabled: true, seedsPerPairing: 1, pairings: balancedDuelPairings(o.duelPairings) },
    ffa4: { enabled: true, seedsPerPairing: 1, compositions: o.ffa4Compositions, sampler: "coverage" },
    ffa7: { enabled: true, seedsPerPairing: 1, compositions: o.ffa7Compositions, sampler: "coverage" },
  });
}

export interface WorkloadResult {
  matches: number;
  ticks: number;
  wallMs: number;
  matchesPerSecond: number;
  ticksPerSecond: number;
  /** Fingerprint of every outcome, in plan order. Two runs that agree here made
   *  the same decisions; two that do not, did not. */
  fingerprint: string;
}

/** Runs the workload serially in this process and fingerprints the outcomes. */
export function runWorkload(jobs: MatchJob[]): WorkloadResult {
  const started = performance.now();
  let ticks = 0;
  const parts: string[] = [];
  for (const job of jobs) {
    const outcome = runJob(job, POPULATION_V1);
    ticks += outcome.endedAtTick;
    parts.push(`${outcome.id}|${outcome.winnerKingdom ?? "-"}|${outcome.endedAtTick}|${outcome.placements.join(",")}`);
  }
  const wallMs = performance.now() - started;
  return {
    matches: jobs.length,
    ticks,
    wallMs,
    matchesPerSecond: jobs.length / (wallMs / 1000),
    ticksPerSecond: ticks / (wallMs / 1000),
    fingerprint: fingerprintOf(parts),
  };
}

/** Order-sensitive digest of the outcome list. */
export function fingerprintOf(parts: readonly string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h1 = Math.imul(h1 ^ part.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + part.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
    }
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}
