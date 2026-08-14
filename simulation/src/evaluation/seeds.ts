import { deriveSeed, hashSeed } from "../rng.js";

/**
 * Seed pools.
 *
 * Training and validation seeds must never overlap: an optimizer that searches
 * against the same dice it is later judged on will report an improvement that
 * does not survive contact with fresh seeds. Keeping the pools disjoint *by
 * construction* — rather than by remembering to pass different numbers — is the
 * only version of this rule that holds up once a search loop is running
 * unattended.
 */

export type SeedPoolName = "training" | "validation" | "final";

/**
 * Each pool occupies its own region of the seed space. Derived seeds are
 * scrambled per pool, so no seed can appear in two pools and adding matches to
 * one pool never perturbs another.
 */
const POOL_SALT: Record<SeedPoolName, number> = {
  training: 0x7a1c_0001,
  validation: 0x7a1c_0002,
  final: 0x7a1c_0003,
};

export const SEED_POOLS: readonly SeedPoolName[] = [
  "training",
  "validation",
  "final",
];

/**
 * The seed for one unit of work.
 *
 * Deterministic in every input and nothing else: the same engine, balance,
 * population, pool, matchup, pairing and index always produce the same match.
 * `label` identifies the matchup or composition, `pairing` the ordered strategy
 * pair, `index` the repetition.
 */
export function seedFor(
  pool: SeedPoolName,
  label: string,
  pairing: string,
  index: number,
): number {
  const base = hashSeed(`${pool}:${label}:${pairing}`) ^ POOL_SALT[pool];
  return deriveSeed(base >>> 0, index);
}

/** Every seed for one unit of work, in order. */
export function seedsFor(
  pool: SeedPoolName,
  label: string,
  pairing: string,
  count: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(seedFor(pool, label, pairing, i));
  return out;
}

/**
 * Proof that two pools never collide, for the given shape of work. Used by the
 * test suite; cheap enough to call in an assertion.
 */
export function poolsDisjoint(
  labels: readonly string[],
  pairings: readonly string[],
  count: number,
): boolean {
  const seen = new Map<number, SeedPoolName>();
  for (const pool of SEED_POOLS) {
    for (const label of labels) {
      for (const pairing of pairings) {
        for (const seed of seedsFor(pool, label, pairing, count)) {
          const owner = seen.get(seed);
          if (owner !== undefined && owner !== pool) return false;
          seen.set(seed, pool);
        }
      }
    }
  }
  return true;
}
