import type { EvaluationTier } from "./candidate.js";
import type { TierConfig } from "./run.js";
import { SCREEN_TIER, FULL_TIER, VALIDATION_TIER } from "./run.js";

/**
 * How the match budget is split across formats, versioned.
 *
 * v1 is what the first two experiments ran. It is kept byte-identical so those
 * runs stay reproducible — the tier configuration is fingerprinted into every
 * checkpoint identity, so changing it in place would make old checkpoints
 * unresumable and old results unverifiable.
 *
 * v2 is Balance V3's allocation. The problem it fixes:
 *
 *   v1 SCREEN gave duels 69.6% of the matches for 15% of the fitness weight,
 *   and 7-FFA 13.0% for 35%. Measured against the movement a real candidate
 *   produced, that put 7-FFA at a signal-to-noise ratio of 0.35 — its entire
 *   contribution was below its own sampling error, so CMA-ES could not see it.
 *   Duels sat at 1.46 and were the only format the search could actually
 *   follow, which is why duels were the only format that improved.
 *
 * Two things had to change together. Re-splitting the SCREEN budget alone drops
 * every format below SNR 1.0 (duel 0.68, 4-FFA 0.83, 7-FFA 0.72): 1,656 matches
 * is simply not enough to measure three formats when two of them use a
 * high-variance placement statistic. So SCREEN is both re-split AND doubled.
 *
 * SCREEN is the tier that matters. `cma.tell` runs on screening scores only
 * (run.ts) — full-tier scores never reach the optimizer, they gate promotion.
 * Fixing FULL alone would have produced better-looking reports and an
 * identically-biased search.
 */

/** A named split, so an experiment records which one produced its numbers. */
export type AllocationVersion = "v1" | "v2";

export interface Allocation {
  screen: TierConfig;
  full: TierConfig;
  validation: TierConfig;
}

/**
 * Every count is a multiple of 36, because a format's match count is
 * (pairings or compositions) × 36 ordered strategy pairings × seeds. Six
 * personalities give 6² = 36; that is fixed by the population, not by us.
 */

/** 504 duel / 1,008 4-FFA / 1,800 7-FFA = 3,312. Double v1's total, re-split. */
const SCREEN_V2: TierConfig = {
  duelPairings: 14,
  duelSeeds: 1,
  ffa4Compositions: 28,
  ffa7Compositions: 50,
  ffaSeeds: 1,
  sampler: "coverage",
};

/** 1,008 duel / 2,016 4-FFA / 3,600 7-FFA = 6,624. */
const FULL_V2: TierConfig = {
  duelPairings: 28,
  duelSeeds: 1,
  ffa4Compositions: 56,
  ffa7Compositions: 100,
  ffaSeeds: 1,
  sampler: "stratified",
};

/**
 * 3,312 duel / 6,588 4-FFA / 12,096 7-FFA = 21,996 — the same order of cost as
 * v1's 21,816, redistributed.
 *
 * Seeds drop to 1 and compositions rise. For estimating a kingdom's mean
 * placement those are equivalent per match, but more compositions sample more
 * distinct opponent sets, which is the thing 7-FFA was short of.
 */
const VALIDATION_V2: TierConfig = {
  duelPairings: 92,
  duelSeeds: 1,
  ffa4Compositions: 183,
  ffa7Compositions: 336,
  ffaSeeds: 1,
  sampler: "stratified",
};

export const ALLOCATION_V1: Allocation = {
  screen: SCREEN_TIER,
  full: FULL_TIER,
  validation: VALIDATION_TIER,
};

export const ALLOCATION_V2: Allocation = {
  screen: SCREEN_V2,
  full: FULL_V2,
  validation: VALIDATION_V2,
};

export const ALLOCATIONS: Record<AllocationVersion, Allocation> = {
  v1: ALLOCATION_V1,
  v2: ALLOCATION_V2,
};

/**
 * v1 stays the default so nothing that does not ask for the new split changes
 * behaviour. Balance V3 opts in explicitly.
 */
export const DEFAULT_ALLOCATION: AllocationVersion = "v1";

export function isAllocationVersion(value: string): value is AllocationVersion {
  return value === "v1" || value === "v2";
}

/** Resolves a name to its tier set, refusing anything unknown rather than
 *  silently falling back — a typo in a notebook must not quietly run v1. */
export function allocationFor(version: string): Allocation {
  if (!isAllocationVersion(version)) {
    throw new Error(
      `unknown allocation "${version}" (known: ${Object.keys(ALLOCATIONS).join(", ")})`,
    );
  }
  return ALLOCATIONS[version];
}

export function tierFor(version: string, tier: EvaluationTier): TierConfig {
  return allocationFor(version)[tier];
}
