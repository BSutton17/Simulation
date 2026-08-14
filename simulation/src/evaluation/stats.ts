/**
 * Statistics for balance evaluation.
 *
 * Every rate the evaluator reports carries its sample size and an interval, so
 * a consumer can tell 45% from 100 matches apart from 45% from 10,000. Reading
 * a bare percentage was how earlier diagnostics in this project made confident
 * claims from 20-match samples.
 */

/** A proportion with the evidence behind it. */
export interface Rate {
  /** Successes (wins, firsts, …). */
  count: number;
  /** Trials. */
  total: number;
  /** count / total, or 0 when there are no trials. */
  rate: number;
  /** 95% Wilson score interval [low, high]. */
  ci95: [number, number];
}

/** z for a two-sided 95% interval. */
const Z = 1.959963984540054;

/**
 * Wilson score interval.
 *
 * Chosen over the textbook normal approximation because balance evaluation
 * routinely produces proportions at the extremes — a 0/108 matchup is exactly
 * the case we most need to describe, and the normal approximation returns a
 * degenerate zero-width interval there.
 */
export function wilson(count: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const p = count / total;
  const z2 = Z * Z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin =
    (Z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return [clamp01(centre - margin), clamp01(centre + margin)];
}

export function rate(count: number, total: number): Rate {
  return {
    count,
    total,
    rate: total > 0 ? count / total : 0,
    ci95: wilson(count, total),
  };
}

/** Sums a set of rates into one (pooled counts, recomputed interval). */
export function pool(rates: readonly Rate[]): Rate {
  let count = 0;
  let total = 0;
  for (const r of rates) {
    count += r.count;
    total += r.total;
  }
  return rate(count, total);
}

/** Width of a rate's confidence interval — a direct "how sure are we?" number. */
export function uncertainty(r: Rate): number {
  return r.ci95[1] - r.ci95[0];
}

/** Spread of a set of observations, for profile-disagreement telemetry. */
export interface Spread {
  min: number;
  max: number;
  mean: number;
  variance: number;
  /** max − min, in the same units as the observations. */
  spread: number;
  /** How many observations went into this. */
  samples: number;
}

export function spreadOf(values: readonly number[]): Spread {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, variance: 0, spread: 0, samples: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return {
    min,
    max,
    mean,
    variance: sq / values.length,
    spread: max - min,
    samples: values.length,
  };
}

/** Mean placement (1 = winner) plus the full distribution. */
export interface PlacementStats {
  matches: number;
  average: number;
  /** distribution[i] = times finished in place i+1. */
  distribution: number[];
  first: Rate;
  last: Rate;
}

export function placementStats(
  placements: readonly number[],
  seats: number,
): PlacementStats {
  const distribution = new Array<number>(seats).fill(0);
  let sum = 0;
  let firsts = 0;
  let lasts = 0;
  for (const p of placements) {
    sum += p;
    if (p >= 1 && p <= seats) distribution[p - 1]! += 1;
    if (p === 1) firsts += 1;
    if (p === seats) lasts += 1;
  }
  const matches = placements.length;
  return {
    matches,
    average: matches > 0 ? sum / matches : 0,
    distribution,
    first: rate(firsts, matches),
    last: rate(lasts, matches),
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
