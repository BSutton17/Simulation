import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import { mulberry32, hashSeed } from "../rng.js";

/**
 * Free-for-all composition sampling.
 *
 * 1v1 needs none of this — all 120 pairings enumerate cheaply. The FFA spaces
 * do: C(16,4) = 1,820 and C(16,7) = 11,440, and evaluating either exhaustively
 * for every candidate is not affordable.
 *
 * The question a sampler answers is not "how much of the space did we cover?"
 * but "how much reliable balance information did we buy per minute?". A sampler
 * that touches more of the space while leaving some kingdom under-observed is
 * worse than one that touches less and measures every kingdom well.
 */

/** Context a sampler may use to bias its choices. Always optional: a sampler
 *  must produce a valid sample without it. */
export interface SamplerContext {
  /**
   * Per-kingdom weighting, typically derived from a prior reading — higher
   * means "spend more budget observing this kingdom".
   *
   * Supplied dynamically and never baked in: which kingdoms look extreme is a
   * property of the balance configuration under test, and a candidate the
   * Balance AI proposes may make an entirely different set extreme.
   */
  priority?: Readonly<Partial<Record<KingdomId, number>>>;
}

export interface CompositionSampler {
  /** Stable name, recorded in the reading so a sample can be reproduced. */
  readonly name: string;
  /** Bump when the algorithm changes; samples across versions are not
   *  comparable even at the same name and seed. */
  readonly version: number;
  /** One-line description for reports. */
  readonly description: string;
  /** Deterministic in (seats, count, seed, context). */
  sample(
    seats: number,
    count: number,
    seed: number,
    context?: SamplerContext,
  ): KingdomId[][];
}

/** Every C(n, k) combination, in a stable order. */
export function allCombinations(seats: number): KingdomId[][] {
  const out: KingdomId[][] = [];
  const current: KingdomId[] = [];
  const walk = (start: number): void => {
    if (current.length === seats) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < KINGDOM_IDS.length; i++) {
      current.push(KINGDOM_IDS[i]!);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/** Total compositions available at a seat count — C(16, seats). */
export function compositionSpace(seats: number): number {
  let n = 1;
  for (let i = 0; i < seats; i++) n = (n * (KINGDOM_IDS.length - i)) / (i + 1);
  return Math.round(n);
}

/** Fisher-Yates using a seeded stream. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const key = (composition: readonly KingdomId[]): string => composition.join(",");

/** Enumerates the whole space. Affordable at 4 seats for validation; not for
 *  per-candidate evaluation at 7. */
export const exhaustiveSampler: CompositionSampler = {
  name: "exhaustive",
  version: 1,
  description: "Every combination, in canonical order",
  sample(seats, count) {
    const all = allCombinations(seats);
    return count >= all.length ? all : all.slice(0, count);
  },
};

/**
 * Uniform random compositions — the control against which the others are
 * judged. Cheap and unbiased in expectation, but at realistic sample sizes it
 * routinely leaves some kingdoms materially under-observed, which shows up
 * downstream as a kingdom whose FFA numbers are noise.
 */
export const randomSampler: CompositionSampler = {
  name: "random",
  version: 1,
  description: "Uniform random compositions (control)",
  sample(seats, count, seed) {
    const rng = mulberry32(seed >>> 0);
    const chosen: KingdomId[][] = [];
    const seen = new Set<string>();
    const space = compositionSpace(seats);
    let guard = 0;
    while (chosen.length < count && guard < count * 40) {
      guard++;
      const composition = shuffle([...KINGDOM_IDS], rng).slice(0, seats).sort();
      const k = key(composition);
      // Only deduplicate while the space is much larger than the sample;
      // otherwise a small space would spin.
      if (space > count * 2 && seen.has(k)) continue;
      seen.add(k);
      chosen.push(composition);
    }
    return chosen;
  },
};

/**
 * Coverage-balanced: repeatedly builds a composition from the kingdoms sampled
 * least so far, breaking ties with the seeded stream. Appearances stay within
 * one of each other, so every kingdom is measured to comparable precision.
 */
export const coverageSampler: CompositionSampler = {
  name: "coverage",
  version: 1,
  description: "Equal kingdom representation (appearances differ by ≤1)",
  sample(seats, count, seed) {
    const rng = mulberry32(seed >>> 0);
    const appearances = new Map<KingdomId, number>(KINGDOM_IDS.map((k) => [k, 0]));
    const chosen: KingdomId[][] = [];
    const seen = new Set<string>();

    for (let n = 0; n < count; n++) {
      const pool = [...KINGDOM_IDS].sort((a, b) => {
        const d = appearances.get(a)! - appearances.get(b)!;
        return d !== 0 ? d : rng() - 0.5;
      });
      let composition = pool.slice(0, seats).sort();
      let guard = 0;
      while (seen.has(key(composition)) && guard < 8) {
        composition = shuffle(pool, rng).slice(0, seats).sort();
        guard++;
      }
      seen.add(key(composition));
      for (const k of composition) appearances.set(k, appearances.get(k)! + 1);
      chosen.push(composition);
    }
    return chosen;
  },
};

/**
 * Stratified: coverage-balanced on kingdoms, and additionally spreads
 * PAIRINGS.
 *
 * Equal kingdom appearances still permit a lopsided sample — a kingdom can
 * appear the right number of times while always sharing the field with the same
 * neighbours, so its numbers describe those matchups rather than the format. On
 * top of the appearance count this tracks how often each unordered pair has
 * co-occurred and prefers compositions that introduce fresh pairings.
 */
export const stratifiedSampler: CompositionSampler = {
  name: "stratified",
  version: 1,
  description: "Balanced kingdom appearances AND spread co-occurrence",
  sample(seats, count, seed) {
    const rng = mulberry32(seed >>> 0);
    const appearances = new Map<KingdomId, number>(KINGDOM_IDS.map((k) => [k, 0]));
    const pairCount = new Map<string, number>();
    const chosen: KingdomId[][] = [];
    const seen = new Set<string>();

    const pairKey = (a: KingdomId, b: KingdomId) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const cost = (composition: readonly KingdomId[]): number => {
      let c = 0;
      for (const k of composition) c += appearances.get(k)! * 10;
      for (let i = 0; i < composition.length; i++) {
        for (let j = i + 1; j < composition.length; j++) {
          c += pairCount.get(pairKey(composition[i]!, composition[j]!)) ?? 0;
        }
      }
      return c;
    };

    for (let n = 0; n < count; n++) {
      // Propose a handful of candidates from the least-used kingdoms and take
      // the one that adds the most unseen structure. Cheap, and far better
      // spread than greedy selection alone.
      let best: KingdomId[] | null = null;
      let bestCost = Infinity;
      for (let attempt = 0; attempt < 12; attempt++) {
        const pool = [...KINGDOM_IDS].sort((a, b) => {
          const d = appearances.get(a)! - appearances.get(b)!;
          return d !== 0 ? d : rng() - 0.5;
        });
        // Widen the draw slightly so proposals differ from each other.
        const window = Math.min(KINGDOM_IDS.length, seats + 4);
        const composition = shuffle(pool.slice(0, window), rng).slice(0, seats).sort();
        if (seen.has(key(composition))) continue;
        const c = cost(composition);
        if (c < bestCost) {
          bestCost = c;
          best = composition;
        }
      }
      if (!best) {
        best = shuffle([...KINGDOM_IDS], rng).slice(0, seats).sort();
      }
      seen.add(key(best));
      for (const k of best) appearances.set(k, appearances.get(k)! + 1);
      for (let i = 0; i < best.length; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const pk = pairKey(best[i]!, best[j]!);
          pairCount.set(pk, (pairCount.get(pk) ?? 0) + 1);
        }
      }
      chosen.push(best);
    }
    return chosen;
  },
};

/**
 * Diagnostic: coverage-balanced, then tilted toward kingdoms the caller flags
 * as interesting via `context.priority`.
 *
 * The priorities come from a prior reading at run time — nothing about which
 * kingdoms matter is encoded here. Without a context it degrades exactly to
 * coverage sampling, which is the correct default for a sampler that has been
 * told nothing.
 */
export const diagnosticSampler: CompositionSampler = {
  name: "diagnostic",
  version: 1,
  description: "Coverage-balanced, weighted toward caller-flagged kingdoms",
  sample(seats, count, seed, context) {
    const priority = context?.priority;
    if (!priority || Object.keys(priority).length === 0) {
      return coverageSampler.sample(seats, count, seed);
    }
    const rng = mulberry32(seed >>> 0);
    const weight = (k: KingdomId) => Math.max(0.01, priority[k] ?? 1);
    const appearances = new Map<KingdomId, number>(KINGDOM_IDS.map((k) => [k, 0]));
    const chosen: KingdomId[][] = [];
    const seen = new Set<string>();

    for (let n = 0; n < count; n++) {
      // Effective appearances are discounted by weight, so a high-priority
      // kingdom must be seen proportionally more often before it stops being
      // "under-sampled" — coverage logic, re-weighted.
      const pool = [...KINGDOM_IDS].sort((a, b) => {
        const d = appearances.get(a)! / weight(a) - appearances.get(b)! / weight(b);
        return d !== 0 ? d : rng() - 0.5;
      });
      let composition = pool.slice(0, seats).sort();
      let guard = 0;
      while (seen.has(key(composition)) && guard < 8) {
        composition = shuffle(pool.slice(0, Math.min(KINGDOM_IDS.length, seats + 4)), rng)
          .slice(0, seats)
          .sort();
        guard++;
      }
      seen.add(key(composition));
      for (const k of composition) appearances.set(k, appearances.get(k)! + 1);
      chosen.push(composition);
    }
    return chosen;
  },
};

export const SAMPLERS: Record<string, CompositionSampler> = {
  exhaustive: exhaustiveSampler,
  random: randomSampler,
  coverage: coverageSampler,
  stratified: stratifiedSampler,
  diagnostic: diagnosticSampler,
};

/** Per-kingdom appearance counts — reported so coverage is visible, not assumed. */
export function coverageOf(
  compositions: readonly KingdomId[][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of KINGDOM_IDS) counts[k] = 0;
  for (const c of compositions) for (const k of c) counts[k] = (counts[k] ?? 0) + 1;
  return counts;
}

/** Summary of how evenly a sample spreads across kingdoms and pairings. */
export interface CoverageQuality {
  compositions: number;
  space: number;
  /** Fraction of the composition space touched. */
  spaceFraction: number;
  /** Distinct compositions — lower than `compositions` means repeats. */
  unique: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  /** Distinct unordered kingdom pairs that co-occurred at least once. */
  pairsSeen: number;
  /** Total possible unordered pairs, C(16,2) = 120. */
  pairsPossible: number;
}

export function coverageQuality(
  compositions: readonly KingdomId[][],
  seats: number,
): CoverageQuality {
  const counts = Object.values(coverageOf(compositions));
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.reduce((s, c) => s + (c - mean) * (c - mean), 0) / counts.length;
  const pairs = new Set<string>();
  for (const c of compositions) {
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        pairs.add(c[i]! < c[j]! ? `${c[i]}|${c[j]}` : `${c[j]}|${c[i]}`);
      }
    }
  }
  const space = compositionSpace(seats);
  return {
    compositions: compositions.length,
    space,
    spaceFraction: compositions.length / space,
    unique: new Set(compositions.map(key)).size,
    min: Math.min(...counts),
    max: Math.max(...counts),
    mean,
    stdDev: Math.sqrt(variance),
    pairsSeen: pairs.size,
    pairsPossible: (KINGDOM_IDS.length * (KINGDOM_IDS.length - 1)) / 2,
  };
}

/** Deterministic seed for a sampler from the pool and format. */
export function samplerSeed(pool: string, seats: number): number {
  return hashSeed(`sampler:${pool}:${seats}`);
}
