import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import type {
  DuelResults,
  EvaluationResult,
  FfaResults,
} from "../evaluation/evaluator.js";
import { placementStats, rate } from "../evaluation/stats.js";
import { EVALUATION_FORMAT_VERSION } from "../evaluation/provenance.js";

/**
 * Synthetic evaluation readings, for validating the fitness function.
 *
 * These describe hypothetical games, not measurements of Elementals. They exist
 * because proving "fitness rises when the game gets fairer" needs a game whose
 * fairness we control exactly — running real evaluations would take a quarter
 * of an hour per point and still leave the true fairness unknown.
 *
 * Nothing here may be used to measure the actual game.
 */

export interface SyntheticSpec {
  id: string;
  /**
   * Imbalance strength in [0, 1]. 0 is a perfectly fair game; 1 is maximal
   * spread, with kingdoms fanned out evenly from dominant to hopeless.
   */
  duelImbalance: number;
  ffa4Imbalance: number;
  ffa7Imbalance: number;
  /** Matches per kingdom, which drives the confidence intervals. */
  samplesPerKingdom?: number;
  /** Force one kingdom to a catastrophic 1v1 win rate. */
  duelOutlier?: { kingdom: KingdomId; winRate: number };
  /** Force one kingdom to a catastrophic FFA first-place rate. */
  ffaOutlier?: { format: "ffa4" | "ffa7"; kingdom: KingdomId; firstRate: number };
}

/** Spreads kingdoms evenly around a fair value, scaled by imbalance. */
function fan(index: number, count: number, fair: number, imbalance: number, room: number): number {
  if (count < 2) return fair;
  const t = index / (count - 1); // 0..1
  const offset = (t - 0.5) * 2 * imbalance * room;
  return Math.max(0, Math.min(1, fair + offset));
}

function makeDuel(spec: SyntheticSpec, n: number): DuelResults {
  const kingdoms: Record<string, ReturnType<typeof rate>> = {};
  KINGDOM_IDS.forEach((k, i) => {
    let winRate = fan(i, KINGDOM_IDS.length, 0.5, spec.duelImbalance, 0.5);
    if (spec.duelOutlier?.kingdom === k) winRate = spec.duelOutlier.winRate;
    kingdoms[k] = rate(Math.round(winRate * n), n);
  });

  // Matchups consistent with the kingdom rates: A vs B reflects their gap.
  const matchups: DuelResults["matchups"] = [];
  for (let i = 0; i < KINGDOM_IDS.length; i++) {
    for (let j = i + 1; j < KINGDOM_IDS.length; j++) {
      const a = KINGDOM_IDS[i]!;
      const b = KINGDOM_IDS[j]!;
      const gap = (kingdoms[a]!.rate - kingdoms[b]!.rate) / 2;
      const r = Math.max(0, Math.min(1, 0.5 + gap));
      const per = Math.max(1, Math.round(n / KINGDOM_IDS.length));
      matchups.push({
        a, b,
        aggregate: rate(Math.round(r * per), per),
        byPairing: {},
        profileSpread: { min: r, max: r, mean: r, variance: 0, spread: 0, samples: 1 },
        timeouts: 0,
        meanTicks: 12000,
      });
    }
  }
  return {
    pairings: matchups.length,
    matches: n * KINGDOM_IDS.length,
    matchups,
    kingdoms,
    profiles: { balanced: rate(n / 2, n) },
    mirrors: { balanced: rate(n / 2, n) },
  };
}

function makeFfa(
  seats: number,
  imbalance: number,
  n: number,
  outlier?: { kingdom: KingdomId; firstRate: number },
): FfaResults {
  const fair = 1 / seats;
  const kingdoms: FfaResults["kingdoms"] = {};
  const seats_: FfaResults["seats_"] = {};

  KINGDOM_IDS.forEach((k, i) => {
    let firstRate = fan(i, KINGDOM_IDS.length, fair, imbalance, fair);
    if (outlier?.kingdom === k) firstRate = outlier.firstRate;
    // Build a placement distribution whose first-place share matches, with the
    // remainder tilted linearly so mean placement moves consistently.
    const counts = new Array<number>(seats).fill(0);
    const firsts = Math.round(firstRate * n);
    counts[0] = firsts;
    const remaining = n - firsts;
    // Weight later places more when the kingdom is weak, less when strong.
    const tilt = (firstRate - fair) / Math.max(fair, 1e-9);
    let weightSum = 0;
    const weights: number[] = [];
    for (let s = 1; s < seats; s++) {
      const w = Math.max(0.05, 1 - tilt * ((s - 1) / (seats - 1) - 0.5) * 2);
      weights.push(w);
      weightSum += w;
    }
    for (let s = 1; s < seats; s++) {
      counts[s] = Math.round((weights[s - 1]! / weightSum) * remaining);
    }
    const placements: number[] = [];
    counts.forEach((c, idx) => { for (let x = 0; x < c; x++) placements.push(idx + 1); });

    kingdoms[k] = { kingdom: k, placement: placementStats(placements, seats) };
    const per = Math.round(placements.length / seats);
    seats_[k] = {
      appearances: new Array<number>(seats).fill(per),
      meanPlacement: new Array<number>(seats).fill((seats + 1) / 2),
    };
  });

  const compositions = [KINGDOM_IDS.slice(0, seats) as KingdomId[]];
  return {
    seats,
    sampler: "synthetic",
    samplerVersion: 0,
    compositions,
    coverage: Object.fromEntries(KINGDOM_IDS.map((k) => [k, 1])),
    coverageQuality: {
      compositions: 1, space: 1, spaceFraction: 1, unique: 1,
      min: 1, max: 1, mean: 1, stdDev: 0, pairsSeen: 1, pairsPossible: 120,
    },
    matches: n * KINGDOM_IDS.length,
    timeouts: 0,
    meanTicks: 13000,
    kingdoms,
    profiles: { balanced: rate(Math.round(n * fair), n) },
    seats_,
  };
}

/** Builds a complete synthetic reading from a spec. */
export function syntheticEvaluation(spec: SyntheticSpec): EvaluationResult {
  const n = spec.samplesPerKingdom ?? 1000;
  const duel = makeDuel(spec, n);
  const ffa4 = makeFfa(4, spec.ffa4Imbalance, n, spec.ffaOutlier?.format === "ffa4" ? spec.ffaOutlier : undefined);
  const ffa7 = makeFfa(7, spec.ffa7Imbalance, n, spec.ffaOutlier?.format === "ffa7" ? spec.ffaOutlier : undefined);
  const matches = duel.matches + ffa4.matches + ffa7.matches;

  return {
    provenance: {
      formatVersion: EVALUATION_FORMAT_VERSION,
      engineSha: "synthetic",
      engineDirty: false,
      balanceBaselineHash: "synthetic",
      balanceConfigId: spec.id,
      balanceConfigHash: spec.id,
      strategyPopulationVersion: "v1",
      kingdomCount: KINGDOM_IDS.length,
      createdAt: "1970-01-01T00:00:00.000Z",
    },
    pool: "validation",
    population: { version: "v1", profiles: ["balanced"] },
    totals: { matches, ticks: matches * 12000, timeouts: 0, durationMs: 0 },
    execution: { workers: 1, failures: [] },
    duel,
    ffa4,
    ffa7,
  };
}
