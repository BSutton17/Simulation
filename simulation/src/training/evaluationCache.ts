import type { TrainingResult } from "./fitness.js";

/**
 * Memoized slate evaluations.
 *
 * Measured on the 50-generation run: 12,600 matches were played, of which at
 * least 4,176 recomputed an answer already known. The benchmark alone re-scored
 * the four heuristic baselines against the SAME frozen slate twenty-five times
 * and got 0.583 / 0.457 / 0.332 / 0.219 every single time, and re-scored an
 * unchanged champion for nine consecutive checks.
 *
 * That waste is safe to remove because slate evaluation is DETERMINISTIC:
 * scenario seeds live in the slate, the network is a pure function of the
 * genome, and the controller draws from the seat's seeded stream. Verified to
 * ten decimal places before this existed. A hit therefore returns the identical
 * number a recomputation would have produced — this changes what the run COSTS,
 * never what it CONCLUDES, which is the only reason a cache belongs anywhere
 * near an experiment.
 *
 * Keys must name everything an evaluation depends on. A key that omits the
 * slate would serve a validation score in answer to a benchmark question, and
 * the run would report a confident wrong number rather than fail — so the
 * helpers below construct keys rather than leaving callers to remember.
 */

export interface CacheStats {
  hits: number;
  misses: number;
  /** Matches NOT played because a hit served the answer. */
  matchesSaved: number;
}

export class EvaluationCache {
  private readonly entries = new Map<string, TrainingResult>();
  readonly stats: CacheStats = { hits: 0, misses: 0, matchesSaved: 0 };

  /**
   * Bounded because a `TrainingResult` carries every scenario it scored, and a
   * long run would otherwise accumulate one per genome ever validated. Oldest
   * out first: the working set is the current generation's candidates plus a
   * handful of long-lived champions, so recency is the right eviction order.
   */
  constructor(private readonly capacity = 512) {}

  /**
   * A hit, or null. Counts the hit.
   *
   * Split from `put` because evaluation became asynchronous when it moved to a
   * worker pool, and a `get(key, compute)` taking a synchronous callback can no
   * longer express "await the computation on a miss". Callers do
   * `peek(key) ?? put(key, await compute())`.
   */
  peek(key: string): TrainingResult | null {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    this.stats.matchesSaved += hit.matches;
    // Refresh recency so a standing champion is never evicted by the churn of
    // one-off candidates around it.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** Stores a freshly computed value. The miss was already counted by `peek`. */
  put(key: string, value: TrainingResult): TrainingResult {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return value;
  }

  /** Synchronous convenience, for callers that are not awaiting anything. */
  get(key: string, compute: () => TrainingResult): TrainingResult {
    return this.peek(key) ?? this.put(key, compute());
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A genome scored on one slate. `identity` must be a CONTENT hash, not an id. */
export function genomeKey(purpose: string, identity: string, slateHash: string): string {
  return `${purpose}|genome:${identity}|${slateHash}`;
}

/** A heuristic baseline on one slate. Stateless, so the name identifies it. */
export function baselineKey(purpose: string, name: string, seed: number, slateHash: string): string {
  return `${purpose}|baseline:${name}:${seed}|${slateHash}`;
}
