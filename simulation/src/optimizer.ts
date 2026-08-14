import { listParameters } from "../../src/engine/parameterCatalog.js";
import type { ParameterSet } from "../../src/engine/parameters.js";
import type { KingdomId } from "../../src/data/kingdoms.js";
import { AnalyticsCollector, type BatchAnalytics } from "./analytics.js";
import { runSimulation } from "./runner.js";
import { runMatchupMatrix, type MatchupMatrix } from "./report.js";
import { mulberry32, normalizeSeed, deriveSeed, type Rng } from "./rng.js";
import { describeParameter } from "./paramLabels.js";
import type { PlayerSpec, SimulationObserver } from "./types.js";

/**
 * Automated balance optimizer (tickets #208–#209).
 *
 * Three interchangeable algorithms search the balance-parameter space:
 *  - hillClimb  — (1+1) greedy: accept only improvements.
 *  - annealing  — simulated annealing: sometimes accepts regressions early
 *                 (temperature-scaled) to escape local optima; the BEST
 *                 candidate seen is always preserved.
 *  - genetic    — a small population evolves via elitism, uniform crossover,
 *                 and mutation; generations map onto `iterations`.
 *
 * All algorithms share one constrained mutation core (#209): per-parameter
 * min/max limits, locked parameters, and selection priorities. Every
 * candidate — mutated, crossed-over, or user-supplied — is clamped before
 * evaluation, so constraints hold unconditionally.
 *
 * Fairness: every candidate is evaluated on the SAME derived batch seed
 * ("common random numbers"), so score differences come from the parameters,
 * not from luckier matches. The whole process is deterministic per seed.
 *
 * The optimizer knows nothing about kingdoms or abilities: it sees opaque
 * numeric parameter ids from the catalog and a numeric objective. Its output
 * is a CANDIDATE ParameterSet for human review — it never writes production
 * balance files.
 */

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export interface OptimizationObjective {
  /** Human-readable label for reports. */
  name: string;
  /** Scores a batch; LOWER is better. */
  evaluate(analytics: BatchAnalytics): number;
}

/**
 * The canonical balance objective: every kingdom in the matchup should win
 * equally often, matches should land inside a target duration band, and
 * timeouts are heavily penalized.
 */
export function balanceObjective(options?: {
  /** Preferred match-length band, in ticks (default 2400–18000 = 2–15 min). */
  durationBand?: { min: number; max: number };
  /** Weight of the duration penalty relative to win-rate spread (default 0.5). */
  durationWeight?: number;
}): OptimizationObjective {
  const band = options?.durationBand ?? { min: 2_400, max: 18_000 };
  const durationWeight = options?.durationWeight ?? 0.5;
  return {
    name: "win-rate parity + duration band",
    evaluate(analytics) {
      const kingdoms = Object.values(analytics.kingdoms);
      if (kingdoms.length === 0 || analytics.matches === 0) return Number.POSITIVE_INFINITY;

      // Win-rate spread: mean squared distance from perfect parity.
      const fair = 1 / kingdoms.length;
      const parity =
        kingdoms.reduce((sum, k) => sum + (k.winRate - fair) ** 2, 0) /
        kingdoms.length;

      // Duration: normalized distance outside the band.
      const avg = analytics.averageDurationTicks;
      const duration =
        avg < band.min
          ? (band.min - avg) / band.min
          : avg > band.max
            ? (avg - band.max) / band.max
            : 0;

      const timeoutPenalty = analytics.timeouts / analytics.matches;
      return parity + durationWeight * duration + timeoutPenalty;
    },
  };
}

/**
 * Matrix-mode score: how far the field is from balanced across every 1v1.
 * Each kingdom's average duel win rate should sit at 0.5; the score is the mean
 * squared deviation from that (0 = perfectly balanced), plus a timeout penalty.
 * Lower is better, matching the other objectives.
 */
export function matrixParityScore(matchup: MatchupMatrix): number {
  const ks = matchup.kingdoms;
  if (ks.length < 2) return Number.POSITIVE_INFINITY;
  let sq = 0;
  for (const row of ks) {
    // Average win rate vs every OTHER kingdom (exclude the mirror diagonal).
    let sum = 0;
    let count = 0;
    for (const col of ks) {
      if (col === row) continue;
      sum += matchup.winRates[row]?.[col] ?? 0;
      count += 1;
    }
    const avg = count > 0 ? sum / count : 0;
    sq += (avg - 0.5) ** 2;
  }
  const parity = sq / ks.length;
  const duels = ks.length * (ks.length - 1) * matchup.matchesPerPair;
  const timeoutPenalty = duels > 0 ? matchup.timeouts / duels : 0;
  return parity + timeoutPenalty;
}

/** A minimal objective: drive the average match duration toward a target. */
export function matchDurationObjective(targetTicks: number): OptimizationObjective {
  return {
    name: `average duration → ${targetTicks} ticks`,
    evaluate(analytics) {
      if (analytics.matches === 0) return Number.POSITIVE_INFINITY;
      return Math.abs(analytics.averageDurationTicks - targetTicks) / targetTicks;
    },
  };
}

// ---------------------------------------------------------------------------
// Constraints (#209)
// ---------------------------------------------------------------------------

export interface ParameterConstraint {
  /** Hard lower bound for this parameter's value. */
  min?: number;
  /** Hard upper bound for this parameter's value. */
  max?: number;
  /** Locked parameters are never mutated (their base/baseline value holds). */
  locked?: boolean;
  /**
   * Relative mutation weight (default 1). Higher values are tuned more
   * often; 0 removes the parameter from the search entirely.
   */
  priority?: number;
}

export interface OptimizationConstraints {
  /** Per-parameter-id constraints. */
  parameters?: Record<string, ParameterConstraint>;
  /**
   * Fallback bounds when a parameter has no explicit min/max: values stay in
   * [base × defaultMinFactor, base × defaultMaxFactor]. Defaults 0.25 / 4.
   */
  defaultMinFactor?: number;
  defaultMaxFactor?: number;
}

/** One tunable dimension of the search space, with resolved bounds. */
interface Dimension {
  id: string;
  base: number;
  min: number;
  max: number;
  weight: number;
}

function buildSpace(
  ids: string[],
  baseById: Map<string, number>,
  constraints: OptimizationConstraints,
): Dimension[] {
  const minFactor = constraints.defaultMinFactor ?? 0.25;
  const maxFactor = constraints.defaultMaxFactor ?? 4;
  const dimensions: Dimension[] = [];
  for (const id of ids) {
    const base = baseById.get(id);
    if (base === undefined) throw new Error(`Unknown parameter id: ${id}`);
    const c = constraints.parameters?.[id] ?? {};
    if (c.locked) continue;
    const weight = c.priority ?? 1;
    if (weight <= 0) continue;
    // Factor bounds ordered by value, not by factor — negative bases (e.g.
    // a weakness expressed as a negative pct) invert the multiplication.
    const lo = base * minFactor;
    const hi = base * maxFactor;
    dimensions.push({
      id,
      base,
      min: c.min ?? Math.min(lo, hi),
      max: c.max ?? Math.max(lo, hi),
      weight,
    });
  }
  return dimensions;
}

/** Clamps into the dimension's bounds, preserving integer-ness of the base
 *  so tick counts and gold prices stay whole. */
function clampValue(dim: Dimension, value: number): number {
  let v = Math.min(dim.max, Math.max(dim.min, value));
  if (Number.isInteger(dim.base)) v = Math.round(v);
  // Rounding may nudge past a non-integer bound; clamp once more.
  return Math.min(dim.max, Math.max(dim.min, v));
}

/** Weighted random pick over dimensions (priorities). */
function pickDimension(dimensions: Dimension[], rng: Rng): Dimension {
  const total = dimensions.reduce((s, d) => s + d.weight, 0);
  let roll = rng() * total;
  for (const d of dimensions) {
    roll -= d.weight;
    if (roll <= 0) return d;
  }
  return dimensions[dimensions.length - 1]!;
}

/** Multiplicative mutation within constraints. */
function mutateValue(dim: Dimension, current: number, scale: number, rng: Rng): number {
  const factor = 1 + scale * (rng() * 2 - 1);
  return clampValue(dim, current * factor);
}

/** Enforce constraints on an arbitrary candidate (crossover output, user
 *  baselines): every tunable id is clamped; locked ids pass through as-is. */
function sanitize(
  candidate: Record<string, number>,
  dimensions: Map<string, Dimension>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(candidate)) {
    const dim = dimensions.get(id);
    out[id] = dim ? clampValue(dim, value) : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

export type OptimizationAlgorithm = "hillClimb" | "annealing" | "genetic";

/** One parameter the iteration moved, with its before/after values and a
 *  human-readable label (for progress output and reports). */
export interface ParameterChange {
  id: string;
  label: string;
  from: number;
  to: number;
}

/** The headline results of one evaluated candidate — enough to show a
 *  before/after in the progress console without recomputing anything. */
export interface IterationMetrics {
  score: number;
  averageDurationTicks: number;
  /** kingdomId → win rate (0–1) in this candidate's evaluation batch. */
  winRates: Record<string, number>;
}

export interface OptimizerIteration {
  iteration: number;
  /** Parameter ids mutated in this candidate/generation. */
  changedIds: string[];
  /** The mutated parameters with before/after values and friendly labels. */
  changes: ParameterChange[];
  score: number;
  accepted: boolean;
  bestScore: number;
  /** This candidate's results. */
  metrics: IterationMetrics;
  /** The results of the state this candidate was derived from (the "before"). */
  previous: IterationMetrics;
}

export interface OptimizerConfig {
  /** Master seed: identical seeds reproduce the whole optimization. */
  seed: number | string;
  /** Candidate iterations (hillClimb/annealing) or generations (genetic). */
  iterations: number;
  /** Matches per evaluation batch. */
  matchesPerBatch: number;
  /** The matchup every batch simulates (single-match evaluation). */
  players: PlayerSpec[];
  /**
   * Matrix evaluation (recommended for balancing a field-dominant kingdom):
   * each candidate is scored on the full round-robin, so a kingdom that wins
   * across many matchups is optimized against the same data the matrix and
   * diagnostics use — not a single brawl. When set, `players` is ignored.
   */
  matrix?: { kingdoms: KingdomId[]; matchesPerPair: number };
  /**
   * FFA evaluation: rotate the seat order each match so a candidate is judged
   * on kingdom strength, not seat luck (see SimulationConfig.rotateSeats).
   * Ignored in matrix mode (duels tabulate both orderings already). The `ffa`
   * workflow turns this on.
   */
  rotateSeats?: boolean;
  algorithm?: OptimizationAlgorithm;
  objective?: OptimizationObjective;
  /**
   * Parameter ids the optimizer may tune. Defaults to the full catalog
   * (hundreds of parameters) — a focused subset converges faster.
   */
  parameterIds?: string[];
  constraints?: OptimizationConstraints;
  /** Parameters mutated per candidate (default 2). */
  mutationsPerIteration?: number;
  /** Mutation magnitude: value scaled by (1 ± scale·u) (default 0.3). */
  mutationScale?: number;
  /** Overrides the starting candidate (clamped to constraints). */
  baseline?: ParameterSet;
  maxTicks?: number;
  /** Simulated annealing knobs. */
  annealing?: { initialTemperature?: number; coolingRate?: number };
  /** Genetic algorithm knobs. */
  genetic?: { populationSize?: number; elites?: number; crossoverRate?: number };
  /** Extra observers forwarded into every evaluation batch. */
  observers?: SimulationObserver[];
  /** Live progress: one call per iteration/generation. */
  onIteration?(report: OptimizerIteration): void;
  /** Live progress: every candidate evaluation (dashboards, constraint audits). */
  onEvaluate?(candidate: ParameterSet, score: number): void;
}

export interface OptimizationResult {
  algorithm: OptimizationAlgorithm;
  /** The best CANDIDATE configuration — for human review, never auto-applied. */
  best: ParameterSet;
  bestScore: number;
  baselineScore: number;
  history: OptimizerIteration[];
  /** Analytics of the best candidate's evaluation batch. */
  analytics: BatchAnalytics;
}

export function optimize(config: OptimizerConfig): OptimizationResult {
  const algorithm = config.algorithm ?? "hillClimb";
  const objective = config.objective ?? balanceObjective();
  const mutations = config.mutationsPerIteration ?? 2;
  const scale = config.mutationScale ?? 0.3;
  const constraints = config.constraints ?? {};

  const catalog = listParameters();
  const baseById = new Map(catalog.map((p) => [p.id, p.base]));
  const ids = config.parameterIds ?? catalog.map((p) => p.id);
  const dimensions = buildSpace(ids, baseById, constraints);
  if (dimensions.length === 0) {
    throw new Error("No tunable parameters (all locked or zero-priority)");
  }
  const dimById = new Map(dimensions.map((d) => [d.id, d]));

  const masterSeed = normalizeSeed(config.seed);
  const rng = mulberry32(deriveSeed(masterSeed, 1));
  // Common random numbers: every candidate is judged on the same matches.
  const evaluationSeed = deriveSeed(masterSeed, 2);

  const evaluate = (candidate: ParameterSet) => {
    const collector = new AnalyticsCollector();
    let score: number;
    if (config.matrix) {
      // Score every candidate on the full round-robin — the same duels that
      // produce the matrix — so field dominance (a kingdom that beats many
      // opponents) is actually visible to the objective.
      const matchup = runMatchupMatrix({
        kingdoms: config.matrix.kingdoms,
        matchesPerPair: config.matrix.matchesPerPair,
        seed: evaluationSeed,
        maxTicks: config.maxTicks,
        parameters: candidate,
        observers: [collector, ...(config.observers ?? [])],
        telemetry: false, // win rates + analytics only — keep it throughput-bound
      });
      score = matrixParityScore(matchup);
    } else {
      runSimulation({
        matches: config.matchesPerBatch,
        seed: evaluationSeed,
        players: config.players,
        rotateSeats: config.rotateSeats,
        maxTicks: config.maxTicks,
        parameters: candidate,
        observers: [collector, ...(config.observers ?? [])],
        // The optimizer runs enormous batches and only reads aggregate
        // analytics; skip per-match telemetry so it stays throughput-bound.
        telemetry: false,
      });
      score = objective.evaluate(collector.snapshot());
    }
    const analytics = collector.snapshot();
    config.onEvaluate?.(candidate, score);
    return { score, analytics };
  };

  /** Distills an evaluated batch into the headline before/after numbers. */
  const metricsOf = (score: number, analytics: BatchAnalytics): IterationMetrics => {
    const winRates: Record<string, number> = {};
    for (const [id, k] of Object.entries(analytics.kingdoms)) winRates[id] = k.winRate;
    return { score, averageDurationTicks: analytics.averageDurationTicks, winRates };
  };

  /** Net before→after of the mutated ids between two parameter sets. */
  const diffChanges = (
    from: Record<string, number>,
    to: Record<string, number>,
  ): ParameterChange[] => {
    const out: ParameterChange[] = [];
    for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const a = from[id] ?? baseById.get(id);
      const b = to[id] ?? baseById.get(id);
      if (a !== undefined && b !== undefined && a !== b) {
        out.push({ id, label: describeParameter(id), from: a, to: b });
      }
    }
    return out;
  };

  const mutateCandidate = (
    from: ParameterSet,
    count: number,
  ): { candidate: Record<string, number>; changes: ParameterChange[] } => {
    const candidate: Record<string, number> = { ...from };
    // Collapse repeat mutations of one id into a single net from→to change.
    const moved = new Map<string, { from: number; to: number }>();
    for (let m = 0; m < count; m++) {
      const dim = pickDimension(dimensions, rng);
      const before = candidate[dim.id] ?? dim.base;
      const after = mutateValue(dim, before, scale, rng);
      candidate[dim.id] = after;
      const existing = moved.get(dim.id);
      if (existing) existing.to = after;
      else moved.set(dim.id, { from: from[dim.id] ?? dim.base, to: after });
    }
    const changes: ParameterChange[] = [...moved.entries()]
      .filter(([, v]) => v.from !== v.to)
      .map(([id, v]) => ({ id, label: describeParameter(id), from: v.from, to: v.to }));
    return { candidate, changes };
  };

  // Baselines are user input: clamp them into the constraint envelope too.
  const baseline = sanitize({ ...(config.baseline ?? {}) }, dimById);
  let { score: baselineScore, analytics: baselineAnalytics } = evaluate(baseline);

  let best: ParameterSet = baseline;
  let bestScore = baselineScore;
  let bestAnalytics = baselineAnalytics;
  const history: OptimizerIteration[] = [];

  const record = (
    iteration: number,
    changes: ParameterChange[],
    score: number,
    accepted: boolean,
    metrics: IterationMetrics,
    previous: IterationMetrics,
  ) => {
    const report: OptimizerIteration = {
      iteration,
      changedIds: changes.map((c) => c.id),
      changes,
      score,
      accepted,
      bestScore,
      metrics,
      previous,
    };
    history.push(report);
    config.onIteration?.(report);
  };

  if (algorithm === "hillClimb") {
    for (let i = 1; i <= config.iterations; i++) {
      // The candidate is mutated from — and compared against — the best so far.
      const previous = metricsOf(bestScore, bestAnalytics);
      const { candidate, changes } = mutateCandidate(best, mutations);
      const { score, analytics } = evaluate(candidate);
      const accepted = score < bestScore;
      if (accepted) {
        best = candidate;
        bestScore = score;
        bestAnalytics = analytics;
      }
      record(i, changes, score, accepted, metricsOf(score, analytics), previous);
    }
  } else if (algorithm === "annealing") {
    const initialT = config.annealing?.initialTemperature ?? Math.max(baselineScore, 0.1);
    const cooling = config.annealing?.coolingRate ?? 0.85;
    let currentSet = baseline;
    let currentScore = baselineScore;
    let currentAnalytics = baselineAnalytics;
    let temperature = initialT;

    for (let i = 1; i <= config.iterations; i++) {
      // Compared against the current walk position (which may be a regression).
      const previous = metricsOf(currentScore, currentAnalytics);
      const { candidate, changes } = mutateCandidate(currentSet, mutations);
      const { score, analytics } = evaluate(candidate);
      // Accept improvements always; regressions with temperature-scaled odds.
      const accepted =
        score < currentScore ||
        rng() < Math.exp((currentScore - score) / Math.max(temperature, 1e-9));
      if (accepted) {
        currentSet = candidate;
        currentScore = score;
        currentAnalytics = analytics;
      }
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
        bestAnalytics = analytics;
      }
      temperature *= cooling;
      record(i, changes, score, accepted, metricsOf(score, analytics), previous);
    }
  } else {
    // Genetic: elitist evolution with uniform crossover.
    const populationSize = config.genetic?.populationSize ?? 6;
    const elites = Math.max(1, config.genetic?.elites ?? 2);
    const crossoverRate = config.genetic?.crossoverRate ?? 0.7;

    type Individual = { params: Record<string, number>; score: number; analytics: BatchAnalytics };
    const assess = (params: Record<string, number>): Individual => {
      const clamped = sanitize(params, dimById);
      const { score, analytics } = evaluate(clamped);
      return { params: clamped, score, analytics };
    };

    // Seed the population: the baseline plus mutated variants.
    let population: Individual[] = [
      { params: { ...baseline }, score: baselineScore, analytics: baselineAnalytics },
    ];
    while (population.length < populationSize) {
      population.push(assess(mutateCandidate(baseline, mutations).candidate));
    }

    // Track the previous generation's champion so each row shows how the best
    // solution moved from one generation to the next.
    let prevBestParams: Record<string, number> = { ...baseline };
    let prevBestScore = baselineScore;
    let prevBestAnalytics = baselineAnalytics;

    for (let gen = 1; gen <= config.iterations; gen++) {
      population.sort((a, b) => a.score - b.score);
      const parents = population.slice(0, Math.max(elites, 2));
      const next: Individual[] = population.slice(0, elites);

      while (next.length < populationSize) {
        const a = parents[Math.floor(rng() * parents.length)]!;
        const b = parents[Math.floor(rng() * parents.length)]!;
        // Uniform crossover over the union of tuned ids…
        const child: Record<string, number> = {};
        const idsInPlay = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
        for (const id of idsInPlay) {
          const donor = rng() < crossoverRate ? a : b;
          const value = donor.params[id] ?? baseById.get(id);
          if (value !== undefined) child[id] = value;
        }
        // …plus fresh mutation.
        next.push(assess(mutateCandidate(child, mutations).candidate));
      }

      population = next;
      population.sort((a, b) => a.score - b.score);
      const generationBest = population[0]!;
      const improved = generationBest.score < bestScore;
      if (improved) {
        best = generationBest.params;
        bestScore = generationBest.score;
        bestAnalytics = generationBest.analytics;
      }
      const changes = diffChanges(prevBestParams, generationBest.params);
      const previous = metricsOf(prevBestScore, prevBestAnalytics);
      record(
        gen,
        changes,
        generationBest.score,
        improved,
        metricsOf(generationBest.score, generationBest.analytics),
        previous,
      );
      prevBestParams = generationBest.params;
      prevBestScore = generationBest.score;
      prevBestAnalytics = generationBest.analytics;
    }
  }

  return {
    algorithm,
    best,
    bestScore,
    baselineScore,
    history,
    analytics: bestAnalytics,
  };
}
