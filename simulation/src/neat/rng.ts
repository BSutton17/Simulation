/**
 * The evolution RNG.
 *
 * Separate from `simulation/src/rng.ts` for one reason: a checkpoint has to
 * restore the exact stream position, and a bare `() => number` closure cannot
 * be serialized. mulberry32's entire state is a single uint32, so this wraps it
 * in something that can be written to JSON and resumed mid-run.
 *
 * ⚠️ `Math.random` must appear nowhere in `neat/`. Every structural decision —
 * which connection is split, which parent contributes a gene, which species
 * survives — flows through here, so a single unseeded call would make a run
 * unreproducible while still looking healthy. `test/neatDeterminism.test.ts`
 * asserts the absence.
 */
export class NeatRng {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform in [-range, range]. */
  spread(range: number): number {
    return (this.next() * 2 - 1) * range;
  }

  /** Standard normal, via Box–Muller. Used for weight perturbation, where a
   *  bell curve explores small changes far more often than large ones. */
  gaussian(): number {
    const u = Math.max(Number.EPSILON, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("cannot pick from an empty list");
    return items[this.int(items.length)]!;
  }

  /** The whole stream position, for checkpointing. */
  get state(): number {
    return this.a >>> 0;
  }

  static fromState(state: number): NeatRng {
    const rng = new NeatRng(0);
    rng.a = state >>> 0;
    return rng;
  }
}
