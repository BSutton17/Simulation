/**
 * Seeded pseudo-random number generation for deterministic simulations.
 *
 * The production engine already accepts an injectable `rng: () => number` at
 * every point where chance matters (crits, proc chances, redirections — see
 * ActivateOptions). The simulation supplies streams built here so that two
 * runs with the same seed replay identically, while the live game keeps using
 * Math.random.
 */

/** A drop-in replacement for Math.random: returns floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Quality is more
 * than sufficient for gameplay dice; speed matters because simulations roll
 * millions of times.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash: turns a human-friendly string seed into a 32-bit integer. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalizes a user-supplied seed (number or string) to a 32-bit integer. */
export function normalizeSeed(seed: number | string): number {
  return typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
}

/**
 * Derives an independent child seed from a base seed and a stream index —
 * match #7 or player #2 each get their own reproducible stream, so adding a
 * player or reordering matches never perturbs unrelated streams.
 */
export function deriveSeed(baseSeed: number, stream: number): number {
  // One mulberry32 scramble keeps derived seeds decorrelated from neighbors.
  const scramble = mulberry32((baseSeed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0);
  return Math.floor(scramble() * 4294967296) >>> 0;
}
