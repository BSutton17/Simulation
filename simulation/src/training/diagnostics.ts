import { NeatRng, buildNetwork, cloneGenome, mutate, type Genome } from "../neat/index.js";
import type { TrainingConfig } from "./config.js";
import { buildValidationSlate } from "./slate.js";
import { evaluateGenome, networkCandidate, playScenario } from "./matchEvaluator.js";
import { buildSelfPlayTables, evaluatePopulation } from "./selfPlay.js";

/**
 * Why is validation flat?
 *
 * Three runs — sixty generations of heuristic training and ~120 of self-play —
 * moved validation from 1.26 to 1.29. Rather than buy more generations a fourth
 * time, these measure the things that would each produce exactly that symptom,
 * so the next change is aimed at whichever one is true:
 *
 *   1. SELECTION HAS NO SIGNAL. If a genome's fitness is mostly the luck of who
 *      it was drawn against, the population is being sorted by noise and no
 *      number of generations helps. Measured by scoring the same genomes twice
 *      on independent draws.
 *
 *   2. THE MEASUREMENT CANNOT DISCRIMINATE. If every genome validates to about
 *      the same score, the champion is arbitrary and so is the curve.
 *
 *   3. NOTHING IS INHERITED. If a mutated child's skill is uncorrelated with its
 *      parent's, evolution cannot accumulate anything, however good selection is.
 *
 *   4. THE POLICIES ARE ALL THE SAME. If different genomes produce the same
 *      behaviour, there is nothing to select between in the first place.
 *
 * Each returns numbers rather than a verdict; the report prints them side by
 * side so the answer is read off rather than argued.
 */

/** Pearson correlation. Returns 0 when either series is constant. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const meanA = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const meanB = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - meanA;
    const y = b[i]! - meanB;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  return Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1));
}

export interface ReliabilityReport {
  /** Fitness of each genome on draw A and draw B. */
  drawA: number[];
  drawB: number[];
  /** How well one draw predicts the other. This IS the usable signal. */
  correlation: number;
  /** Spread between genomes — what selection is trying to read. */
  acrossGenomes: number;
  /** Spread of one genome across draws — the noise sitting on top of it. */
  withinGenome: number;
  /** acrossGenomes / withinGenome. Below ~1 means sorting by noise. */
  signalToNoise: number;
  matchesPerGenome: number;
}

/**
 * Scores the same population twice on independent self-play draws.
 *
 * The decisive measurement for the sampling question. If two independent
 * evaluations of the SAME genomes disagree, then a generation's ranking is
 * mostly a record of who played whom, and selection is sorting noise — which
 * looks exactly like a flat validation curve no matter how long the run.
 */
export function fitnessReliability(
  genomes: readonly Genome[],
  config: TrainingConfig,
): ReliabilityReport {
  // Two different generation indices give two independent shuffles, and so two
  // independent sets of opponents for every genome.
  const tablesA = buildSelfPlayTables(0, config.selfPlay, genomes.length, config.kingdoms, 0);
  const tablesB = buildSelfPlayTables(9_991, config.selfPlay, genomes.length, config.kingdoms, 0);

  const a = evaluatePopulation(genomes, [], tablesA, config.fitness);
  const b = evaluatePopulation(genomes, [], tablesB, config.fitness);

  const drawA = a.map((r) => r.fitness);
  const drawB = b.map((r) => r.fitness);
  const across = stdev([...drawA, ...drawB]);
  // Within-genome spread, pooled across genomes: how much one genome's score
  // moves when only the draw changes.
  const within = Math.sqrt(
    drawA.reduce((sum, x, i) => sum + (x - drawB[i]!) ** 2, 0) / (2 * drawA.length),
  );

  return {
    drawA,
    drawB,
    correlation: correlation(drawA, drawB),
    acrossGenomes: across,
    withinGenome: within,
    signalToNoise: within === 0 ? Infinity : across / within,
    matchesPerGenome: a[0]?.matches ?? 0,
  };
}

export interface DiscriminationReport {
  scores: number[];
  min: number;
  median: number;
  max: number;
  spread: number;
  stdev: number;
  scenarios: number;
}

/**
 * Validates several genomes on the frozen slate.
 *
 * If the champion is chosen by validation, validation has to be able to tell
 * genomes apart. A spread near zero means the champion is whichever genome was
 * checked first.
 */
export function validationDiscrimination(
  genomes: readonly Genome[],
  config: TrainingConfig,
): DiscriminationReport {
  const slate = buildValidationSlate(config.kingdoms, config.balanceConfigId, {
    maxTicks: config.slate.maxTicks,
  });
  const scores = genomes.map((g) => evaluateGenome(g, slate, config.fitness).fitness);
  const sorted = [...scores].sort((x, y) => x - y);
  return {
    scores,
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    spread: (sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0),
    stdev: stdev(scores),
    scenarios: slate.scenarios.length,
  };
}

export interface HeritabilityReport {
  parent: number;
  children: number[];
  meanChild: number;
  /** Mean absolute change a single mutation step produces. */
  meanDrift: number;
  /** Fraction of children within 5% of the parent — how gentle a step is. */
  nearParent: number;
}

/**
 * Validates a parent and a batch of its mutated children.
 *
 * If a single mutation step moves skill as much as the whole population spans,
 * then a child is effectively a fresh random genome and nothing accumulates —
 * selection would be re-rolling rather than refining. With 350 connections and
 * a weight-mutation rate of 0.8, that is a live possibility rather than a
 * theoretical one.
 */
export function heritability(
  parent: Genome,
  config: TrainingConfig,
  children = 8,
  seed = 4242,
): HeritabilityReport {
  const slate = buildValidationSlate(config.kingdoms, config.balanceConfigId, {
    maxTicks: config.slate.maxTicks,
  });
  const parentScore = evaluateGenome(parent, slate, config.fitness).fitness;

  const rng = new NeatRng(seed);
  // A throwaway registry: these children are probes, not population members, so
  // their innovation numbers never need to align with a running search.
  const registry = new (class {
    private n = 100_000;
    connection(): number {
      return this.n++;
    }
    splitNode(): number {
      return this.n++;
    }
  })() as never;

  const scores: number[] = [];
  for (let i = 0; i < children; i++) {
    const child = mutate(cloneGenome(parent, `probe-${i}`), config.neat, rng, registry, `probe-${i}`);
    scores.push(evaluateGenome(child, slate, config.fitness).fitness);
  }

  const drift = scores.map((s) => Math.abs(s - parentScore));
  return {
    parent: parentScore,
    children: scores,
    meanChild: scores.reduce((s, x) => s + x, 0) / Math.max(1, scores.length),
    meanDrift: drift.reduce((s, x) => s + x, 0) / Math.max(1, drift.length),
    nearParent:
      drift.filter((d) => d <= Math.abs(parentScore) * 0.05).length / Math.max(1, drift.length),
  };
}

export interface BehaviourReport {
  /** Per genome: the share of decisions spent on each action family. */
  profiles: {
    casts: number;
    invests: number;
    economy: number;
    waits: number;
    /** Of all waits, the share where nothing else was legal. */
    forcedShare: number;
    /** Share of decisions where the choice differed from the previous one. */
    switchRate: number;
    /** Distinct heads used across the match, out of 14 primary actions. */
    distinctActions: number;
    /** Mean legal actions offered per decision. */
    legalPerDecision: number;
  }[];
  /** Mean pairwise distance between behaviour profiles. 0 = identical play. */
  diversity: number;
  meanDecisions: number;
}

/**
 * Do different genomes actually play differently?
 *
 * The quietest possible failure: if 350 tanh-weighted inputs saturate the output
 * layer, every genome's argmax lands on the same head and the population is one
 * policy wearing different weights. Selection between identical players cannot
 * produce progress, and nothing else in the pipeline would report it.
 */
export function behaviourDiversity(
  genomes: readonly Genome[],
  config: TrainingConfig,
): BehaviourReport {
  const slate = buildValidationSlate(config.kingdoms, config.balanceConfigId, {
    maxTicks: config.slate.maxTicks,
  });
  // One scenario is enough to characterise a policy's action mix.
  const single = { ...slate, scenarios: slate.scenarios.slice(0, 2) };

  const profiles = genomes.map((genome) => {
    const candidate = networkCandidate(buildNetwork(genome), genome.id);
    // One scenario, then read the controller's own counters. The action-
    // variability numbers live on ControllerStats rather than on the scored
    // result, because they describe the POLICY rather than the match.
    const result = playScenario(candidate, single.scenarios[0]!, config.fitness);
    const stats = candidate.stats();
    const n = Math.max(1, result.decisions);
    return {
      casts: result.casts / n,
      invests: result.invests / n,
      economy: (result.citizensBought + result.repairs + result.shields) / n,
      waits: result.waits / n,
      forcedShare: result.forcedWaits / n,
      switchRate: (stats?.actionSwitches ?? 0) / n,
      distinctActions: stats?.distinctActions ?? 0,
      legalPerDecision: (stats?.legalOffered ?? 0) / n,
      decisions: result.decisions,
    };
  });

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i]!;
      const b = profiles[j]!;
      sum +=
        Math.abs(a.casts - b.casts) +
        Math.abs(a.invests - b.invests) +
        Math.abs(a.economy - b.economy) +
        Math.abs(a.waits - b.waits);
      pairs += 1;
    }
  }

  return {
    profiles: profiles.map(
      ({ casts, invests, economy, waits, forcedShare, switchRate, distinctActions, legalPerDecision }) => ({
        casts, invests, economy, waits, forcedShare, switchRate, distinctActions, legalPerDecision,
      }),
    ),
    diversity: pairs > 0 ? sum / pairs : 0,
    meanDecisions:
      profiles.reduce((s, p) => s + p.decisions, 0) / Math.max(1, profiles.length),
  };
}
