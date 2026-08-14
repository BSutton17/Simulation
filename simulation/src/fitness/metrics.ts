/**
 * Normalisation primitives for balance fitness.
 *
 * Every raw measurement the evaluator produces — win rates, placement averages,
 * placement distributions — lives on a different scale and has a different
 * notion of "fair". These turn each of them into a comparable fairness score in
 * [0, 1], where 1 is perfectly fair and 0 is maximally imbalanced.
 *
 * Two ideas run through all of it:
 *
 *   1. A DEAD BAND. Elementals is not supposed to be sixteen identical
 *      kingdoms; a kingdom sitting somewhat above or below even is design, not
 *      a defect. Deviation inside the band costs nothing at all, so the fitness
 *      function never pushes the game toward mathematical sameness.
 *
 *   2. QUADRATIC growth beyond the band, aggregated by root-mean-square. Both
 *      choices exist to stop one catastrophic kingdom being averaged away by
 *      fifteen healthy ones — the failure mode the brief specifically calls out.
 */

/** A fairness score with the raw numbers that produced it. */
export interface Fairness {
  /** 1 = perfectly fair, 0 = maximally imbalanced. */
  score: number;
  /** Per-subject normalised deviation after the dead band, worst first. */
  worst: { subject: string; observed: number; deviation: number }[];
  /** Subjects considered. */
  count: number;
}

export interface DeadBandOptions {
  /**
   * Normalised deviation tolerated for free (0–1). 0.1 means "a tenth of the
   * way to the worst possible imbalance costs nothing".
   */
  deadBand: number;
  /** Report this many worst offenders. */
  worstCount?: number;
}

/**
 * Normalised, signed-agnostic distance from a fair value.
 *
 * Deviation is scaled separately above and below `fair`, because the room in
 * each direction is usually different: a kingdom's first-place rate can fall at
 * most `fair` below fair, but can rise `1 - fair` above it. Scaling by the
 * wrong side would make "never wins" and "always wins" look like different
 * magnitudes of the same problem when they are both total.
 */
export function normalisedDeviation(
  observed: number,
  fair: number,
  worstBelow = fair,
  worstAbove = 1 - fair,
): number {
  if (observed < fair) {
    return worstBelow <= 0 ? 0 : clamp01((fair - observed) / worstBelow);
  }
  return worstAbove <= 0 ? 0 : clamp01((observed - fair) / worstAbove);
}

/**
 * Applies the dead band to a normalised deviation.
 *
 * Growth beyond the band is LINEAR, not quadratic. Quadratic was the first
 * attempt and measurably wrong: it made mid-range imbalance so cheap that a
 * game with kingdoms spread 25–75% still scored 0.964, leaving an optimizer
 * almost no gradient to climb. Protection against a single catastrophic
 * kingdom comes from RMS aggregation and the explicit constraint system, which
 * target outliers directly rather than by bending the whole curve.
 */
export function penalise(deviation: number, deadBand: number): number {
  const excess = Math.max(0, deviation - deadBand);
  const span = Math.max(1e-9, 1 - deadBand);
  return clamp01(excess / span);
}

/**
 * Combines per-subject deviations into one fairness score.
 *
 * Root-mean-square rather than the mean: RMS is dominated by the largest
 * terms, so a single kingdom at 95% cannot be hidden by fifteen kingdoms at
 * 50%. That property is the whole reason the aggregation is not an average.
 */
export function fairnessFrom(
  subjects: readonly { subject: string; observed: number; deviation: number }[],
  options: DeadBandOptions,
): Fairness {
  if (subjects.length === 0) {
    return { score: 1, worst: [], count: 0 };
  }
  let sumSquares = 0;
  for (const s of subjects) {
    const p = penalise(s.deviation, options.deadBand);
    sumSquares += p * p;
  }
  const rms = Math.sqrt(sumSquares / subjects.length);
  const worst = [...subjects]
    .sort((a, b) => b.deviation - a.deviation)
    .slice(0, options.worstCount ?? 5);
  return { score: clamp01(1 - rms), worst, count: subjects.length };
}

/**
 * How far a placement distribution departs from uniform, as total variation
 * distance normalised to [0, 1].
 *
 * This exists because mean placement is genuinely ambiguous. In the current
 * baseline Joker and Light both average close to the fair 4.0 at seven seats,
 * yet Joker takes first 18% of the time and Light only 9.5% — Light is
 * consistently mid-table and rarely wins, Joker swings. Mean placement alone
 * calls them equivalent; the shape of the distribution does not.
 */
export function distributionDivergence(distribution: readonly number[]): number {
  const seats = distribution.length;
  if (seats < 2) return 0;
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const uniform = 1 / seats;
  let tv = 0;
  for (const n of distribution) tv += Math.abs(n / total - uniform);
  // Total variation distance is half the L1 distance; its maximum is 1 - 1/n.
  const maxTv = 1 - uniform;
  return maxTv <= 0 ? 0 : clamp01(tv / 2 / maxTv);
}

/** Weighted mean of named components, ignoring any with zero weight. */
export function weightedMean(
  parts: readonly { score: number; weight: number }[],
): number {
  let sum = 0;
  let total = 0;
  for (const p of parts) {
    if (p.weight <= 0) continue;
    sum += p.score * p.weight;
    total += p.weight;
  }
  return total <= 0 ? 0 : sum / total;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0;
}
