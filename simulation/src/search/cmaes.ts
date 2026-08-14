

/**
 * CMA-ES — Covariance Matrix Adaptation Evolution Strategy.
 *
 * Implemented here rather than taken from a package for one decisive reason:
 * every published JavaScript CMA-ES draws from `Math.random` internally, and
 * this project requires that an optimizer run be reproducible from its recorded
 * seed. A library that cannot be seeded cannot be used, however well tested.
 *
 * This is the standard (mu/mu_w, lambda) algorithm with rank-mu update and
 * step-size control, following Hansen's reference formulation. Full covariance
 * rather than the separable variant, because balance parameters are correlated
 * — damage and cooldown pull against each other — and learning that structure
 * is the main reason to prefer CMA-ES over a genetic algorithm here.
 *
 * Search happens in normalised [0, 1] coordinates (see schema.ts); bounds are
 * enforced by the caller on decode, so the strategy itself stays unconstrained
 * and its internal geometry is not distorted by clipping.
 */

export interface CmaOptions {
  /** Problem dimension. */
  dimension: number;
  /** Starting point, in normalised coordinates. */
  mean: number[];
  /** Initial step size. */
  sigma: number;
  /** Population size (lambda). Defaults to the standard 4 + 3 ln n. */
  populationSize?: number;
  seed: number;
}

export interface CmaState {
  generation: number;
  mean: number[];
  sigma: number;
  populationSize: number;
}

/** A deterministic, seeded CMA-ES. */
export class Cmaes {
  readonly dimension: number;
  readonly lambda: number;
  readonly mu: number;

  private readonly weights: number[];
  private readonly muEff: number;
  private readonly cc: number;
  private readonly cs: number;
  private readonly c1: number;
  private readonly cmu: number;
  private readonly damps: number;
  private readonly chiN: number;
  /** mulberry32 position, so the stream can be checkpointed and resumed. */
  private rngState: number;

  private mean: number[];
  private sigma: number;
  private C: number[][];
  private pc: number[];
  private ps: number[];
  private generation = 0;
  /** Cached eigen-decomposition of C, refreshed lazily. */
  private B: number[][];
  private D: number[];
  private eigenAge = 0;
  /** Standard normal spare from the Box-Muller pair. */
  private spare: number | null = null;

  constructor(options: CmaOptions) {
    const n = options.dimension;
    this.dimension = n;
    this.lambda = options.populationSize ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    this.rngState = options.seed >>> 0;
    this.mean = [...options.mean];
    this.sigma = options.sigma;

    // Recombination weights: log-decreasing over the better half.
    const raw: number[] = [];
    for (let i = 0; i < this.mu; i++) {
      raw.push(Math.log((this.lambda + 1) / 2) - Math.log(i + 1));
    }
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((w) => w / sum);
    this.muEff = 1 / this.weights.reduce((a, w) => a + w * w, 0);

    // Standard adaptation constants.
    this.cc = (4 + this.muEff / n) / (n + 4 + (2 * this.muEff) / n);
    this.cs = (this.muEff + 2) / (n + this.muEff + 5);
    this.c1 = 2 / ((n + 1.3) * (n + 1.3) + this.muEff);
    this.cmu = Math.min(
      1 - this.c1,
      (2 * (this.muEff - 2 + 1 / this.muEff)) / ((n + 2) * (n + 2) + this.muEff),
    );
    this.damps =
      1 + 2 * Math.max(0, Math.sqrt((this.muEff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

    this.C = identity(n);
    this.B = identity(n);
    this.D = new Array<number>(n).fill(1);
    this.pc = new Array<number>(n).fill(0);
    this.ps = new Array<number>(n).fill(0);
  }

  /**
   * Complete internal state, for checkpointing.
   *
   * Includes the covariance matrix, both evolution paths, the generation
   * counter and the RNG position — everything the next `ask()` depends on. A
   * checkpoint missing any of these would resume into a different search than
   * the one that was interrupted, which is worse than not resuming at all
   * because the run would look continuous.
   */
  snapshot(): CmaSnapshot {
    return {
      dimension: this.dimension,
      lambda: this.lambda,
      mean: [...this.mean],
      sigma: this.sigma,
      C: this.C.map((row) => [...row]),
      pc: [...this.pc],
      ps: [...this.ps],
      generation: this.generation,
      rngState: this.rngState,
      spare: this.spare,
    };
  }

  /** Restores a checkpointed search. */
  static restore(snapshot: CmaSnapshot): Cmaes {
    const cma = new Cmaes({
      dimension: snapshot.dimension,
      mean: snapshot.mean,
      sigma: snapshot.sigma,
      populationSize: snapshot.lambda,
      seed: 0,
    });
    cma.mean = [...snapshot.mean];
    cma.sigma = snapshot.sigma;
    cma.C = snapshot.C.map((row) => [...row]);
    cma.pc = [...snapshot.pc];
    cma.ps = [...snapshot.ps];
    cma.generation = snapshot.generation;
    cma.rngState = snapshot.rngState;
    cma.spare = snapshot.spare;
    // Force a fresh decomposition: B and D must match the restored C.
    cma.eigenAge = 1;
    cma.refreshEigen();
    return cma;
  }

  get state(): CmaState {
    return {
      generation: this.generation,
      mean: [...this.mean],
      sigma: this.sigma,
      populationSize: this.lambda,
    };
  }

  /** Draws one generation of candidate vectors. */
  ask(): number[][] {
    this.refreshEigen();
    const population: number[][] = [];
    for (let k = 0; k < this.lambda; k++) {
      const z = Array.from({ length: this.dimension }, () => this.gaussian());
      // y = B * (D .* z) — a sample from N(0, C).
      const dz = z.map((v, i) => v * this.D[i]!);
      const y = matVec(this.B, dz);
      population.push(this.mean.map((m, i) => m + this.sigma * y[i]!));
    }
    return population;
  }

  /**
   * Updates the distribution from the generation's fitness values.
   * Fitness is MAXIMISED, so the caller passes scores directly.
   */
  tell(population: readonly number[][], fitness: readonly number[]): void {
    const n = this.dimension;
    const order = fitness
      .map((f, i) => ({ f, i }))
      // Descending: best first. Ties break by index so a plateau cannot make
      // the run depend on sort stability.
      .sort((a, b) => b.f - a.f || a.i - b.i)
      .map((x) => x.i);

    const oldMean = [...this.mean];
    const newMean = new Array<number>(n).fill(0);
    for (let i = 0; i < this.mu; i++) {
      const individual = population[order[i]!]!;
      for (let d = 0; d < n; d++) newMean[d]! += this.weights[i]! * individual[d]!;
    }
    this.mean = newMean;

    // Evolution paths.
    const meanShift = newMean.map((m, d) => (m - oldMean[d]!) / this.sigma);
    const invSqrtC = this.invSqrtC();
    const zMean = matVec(invSqrtC, meanShift);

    for (let d = 0; d < n; d++) {
      this.ps[d] =
        (1 - this.cs) * this.ps[d]! +
        Math.sqrt(this.cs * (2 - this.cs) * this.muEff) * zMean[d]!;
    }
    const psNorm = Math.hypot(...this.ps);
    const hsig =
      psNorm /
        Math.sqrt(1 - Math.pow(1 - this.cs, 2 * (this.generation + 1))) /
        this.chiN <
      1.4 + 2 / (n + 1)
        ? 1
        : 0;

    for (let d = 0; d < n; d++) {
      this.pc[d] =
        (1 - this.cc) * this.pc[d]! +
        hsig * Math.sqrt(this.cc * (2 - this.cc) * this.muEff) * meanShift[d]!;
    }

    // Covariance update: rank-one plus rank-mu.
    const c1a = this.c1 * (1 - (1 - hsig * hsig) * this.cc * (2 - this.cc));
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let rankMu = 0;
        for (let i = 0; i < this.mu; i++) {
          const individual = population[order[i]!]!;
          const ya = (individual[a]! - oldMean[a]!) / this.sigma;
          const yb = (individual[b]! - oldMean[b]!) / this.sigma;
          rankMu += this.weights[i]! * ya * yb;
        }
        this.C[a]![b] =
          (1 - c1a - this.cmu) * this.C[a]![b]! +
          this.c1 * this.pc[a]! * this.pc[b]! +
          this.cmu * rankMu;
      }
    }
    // Keep C exactly symmetric; drift breaks the eigen solver.
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const avg = (this.C[a]![b]! + this.C[b]![a]!) / 2;
        this.C[a]![b] = avg;
        this.C[b]![a] = avg;
      }
    }

    // Step-size control.
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    // Guard rails: an exploded or collapsed sigma makes the run meaningless,
    // and silently continuing would waste the whole compute budget.
    this.sigma = Math.min(1e3, Math.max(1e-9, this.sigma));

    this.generation += 1;
    this.eigenAge += 1;
  }

  private refreshEigen(): void {
    // Re-decomposing every generation is wasteful at this dimensionality and
    // evaluation cost, but correctness beats micro-optimisation here: the
    // sampling distribution is only right if B and D match C.
    if (this.eigenAge === 0 && this.generation > 0) return;
    const { vectors, values } = jacobiEigen(this.C);
    this.B = vectors;
    this.D = values.map((v) => Math.sqrt(Math.max(1e-20, v)));
    this.eigenAge = 0;
  }

  /** C^(-1/2), used to normalise the mean shift. */
  private invSqrtC(): number[][] {
    this.refreshEigen();
    const n = this.dimension;
    const scaled: number[][] = [];
    for (let a = 0; a < n; a++) {
      scaled.push(new Array<number>(n).fill(0));
      for (let b = 0; b < n; b++) {
        scaled[a]![b] = this.B[a]![b]! / this.D[b]!;
      }
    }
    // B * D^-1 * B^T
    const out: number[][] = [];
    for (let a = 0; a < n; a++) {
      out.push(new Array<number>(n).fill(0));
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += scaled[a]![k]! * this.B[b]![k]!;
        out[a]![b] = s;
      }
    }
    return out;
  }

  /** One draw from the resumable mulberry32 stream. */
  private next(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(this.rngState ^ (this.rngState >>> 15), 1 | this.rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal from the seeded stream (Box-Muller, cached pair). */
  private gaussian(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    // Guard against log(0).
    while (u <= 1e-12) u = this.next();
    v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
}

/** Snapshot of a search in progress. */
export interface CmaSnapshot {
  dimension: number;
  lambda: number;
  mean: number[];
  sigma: number;
  C: number[][];
  pc: number[];
  ps: number[];
  generation: number;
  rngState: number;
  spare: number | null;
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

function matVec(m: readonly number[][], v: readonly number[]): number[] {
  return m.map((row) => row.reduce((s, x, i) => s + x * v[i]!, 0));
}

/**
 * Symmetric eigen-decomposition by cyclic Jacobi rotation.
 *
 * Chosen over anything fancier because the matrices here are small (tens of
 * dimensions), symmetric by construction, and Jacobi is short enough to read
 * and verify — which matters more than speed when the result feeds a search
 * that must be reproducible.
 */
export function jacobiEigen(
  matrix: readonly number[][],
  sweeps = 100,
): { vectors: number[][]; values: number[] } {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  let v = identity(n);

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    }
    if (off < 1e-24) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-18) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { vectors: v, values: a.map((row, i) => row[i]!) };
}
