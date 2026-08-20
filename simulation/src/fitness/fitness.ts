import type { UsageSummary } from "../evaluation/evaluator.js";
import type {
  DuelResults,
  EvaluationResult,
  FfaResults,
} from "../evaluation/evaluator.js";
import { uncertainty } from "../evaluation/stats.js";
import {
  clamp01,
  distributionDivergence,
  fairnessFrom,
  normalisedDeviation,
  weightedMean,
  type Fairness,
} from "./metrics.js";

/**
 * Balance fitness.
 *
 * Turns an evaluation reading into one comparable number, and — just as
 * importantly — shows its working. The Balance AI will compare thousands of
 * configurations with this; a single opaque figure would make every result
 * impossible to argue with.
 *
 * The evaluator measures and refuses to judge. This module is where judgement
 * lives, and it is deliberately the only place: every threshold, weight and
 * target is declared here, versioned, and recorded in the output.
 */

/** Bump when any scoring rule changes. Scores across versions are NOT
 *  comparable, and the comparison path refuses to mix them. */
export const FITNESS_VERSION = "v2";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FormatWeights {
  ffa4: number;
  ffa7: number;
  duel: number;
}

/**
 * Candidate weightings. The designer's stated priority is 4-FFA > 7-FFA > 1v1;
 * which numbers express that best is an empirical question, so several are
 * provided and benchmarked rather than one being asserted.
 */
export const WEIGHT_PRESETS: Record<string, FormatWeights> = {
  equal: { ffa4: 1 / 3, ffa7: 1 / 3, duel: 1 / 3 },
  ffaPriority: { ffa4: 0.5, ffa7: 0.3, duel: 0.2 },
  strongFfa: { ffa4: 0.6, ffa7: 0.25, duel: 0.15 },
  mildFfa: { ffa4: 0.4, ffa7: 0.35, duel: 0.25 },
  /**
   * Calibrated so the EFFECTIVE priority matches the designer's stated
   * 4-FFA > 7-FFA > 1v1.
   *
   * Weights alone do not express priority, because the three format scores do
   * not respond equally to the same amount of imbalance. Measured at equal
   * weights, damaging each format by the same amount costs 0.018 (4-FFA),
   * 0.017 (7-FFA) and 0.031 (1v1) — the duel score is roughly 1.9× as sensitive,
   * because a kingdom's win rate has equal room either side of 50% while an
   * FFA first-place rate has far more room above fair share than below it.
   *
   * Under the obvious 0.5 / 0.3 / 0.2 the ordering inverts and 1v1 outranks
   * 7-FFA. Lifting 7-FFA to 0.35 and dropping 1v1 to 0.15 restores the intended
   * order; see the sensitivity analysis for the measurement.
   */
  designerPriority: { ffa4: 0.5, ffa7: 0.35, duel: 0.15 },
};

export interface FitnessConfig {
  /** Balance v4 usage terms. Omit to use the defaults. */
  usage?: Partial<UsageTargets>;
  weights?: FormatWeights;
  /** Name recorded in provenance when a preset is used. */
  weightsName?: string;
  /**
   * Free deviation before a kingdom costs anything, per format. Wider for
   * matchups than for kingdom aggregates: an individual counter-matchup is a
   * design feature, a kingdom that loses overall is not.
   */
  deadBands?: Partial<DeadBands>;
  /** Sub-weights within each format score. */
  components?: Partial<ComponentWeights>;
  /** Thresholds at which a result stops being asymmetry and becomes a defect. */
  constraints?: Partial<Constraints>;
}

export interface DeadBands {
  duelKingdom: number;
  duelMatchup: number;
  ffaFirst: number;
  ffaLast: number;
  ffaPlacement: number;
  ffaDistribution: number;
}

export interface ComponentWeights {
  duelKingdom: number;
  duelMatchup: number;
  ffaFirst: number;
  ffaLast: number;
  ffaPlacement: number;
  ffaDistribution: number;
}

/**
 * Balance v4: usage terms, and why they are shaped this way.
 *
 * v3 produced a materially fairer game — duel std deviation fell 36% — in which
 * sixteen of eighty abilities were never cast once and bots never bought a
 * shield. That was not an oversight in the search; it was the objective working
 * as written. Parity is the only thing v1 measured, an ability nobody casts
 * cannot unbalance anything, and so making a dead ability WORSE was a free way
 * to score better. The search duly did it: `theEndOfTheWorld` +40% cost,
 * `brickWall` +40% cooldown, `earthquake` -40% damage.
 *
 * ⚠️ THE SHAPE MATTERS MORE THAN THE WEIGHTS. Usage is deliberately NOT another
 * term in the weighted average. Averaging lets a candidate buy usage with
 * balance — 0.9 balance and 0.6 usage beats 0.8 and 0.9 — which is exactly the
 * trade we must not permit. Instead:
 *
 *   - balance is scored first, unchanged, and is the primary objective;
 *   - a BALANCE FLOOR makes any regression below the incumbent a violation,
 *     using the same machinery as the existing catastrophes;
 *   - usage is added on top, bounded small, so it can only decide BETWEEN
 *     candidates that are already at least as balanced.
 *
 * The floor is what makes this "in addition to" rather than "instead of".
 */
export interface UsageTargets {
  /** Fraction of castable abilities that must be cast at least once. */
  abilityCoverage: number;
  /** Shield purchases per match at which the shield term is fully paid. */
  shieldsPerMatch: number;
  /**
   * A candidate scoring below this on BALANCE alone is a regression, however
   * good its usage. Set to the incumbent's balance score to make v4 strictly
   * additive; 0 disables the floor.
   */
  balanceFloor: number;
  /**
   * Ceiling on the usage bonus, as a share of the final objective.
   *
   * Small on purpose. Large enough to break ties and to pay for reaching a dead
   * ability, far too small to buy a meaningful amount of imbalance.
   */
  weight: number;
}

export const DEFAULT_USAGE_TARGETS: UsageTargets = {
  // 80/80. The point of v4 is that every ability is reachable, so the target is
  // not a comfortable fraction.
  abilityCoverage: 1,
  // Bots currently buy zero. Two per match is "shields are part of play"
  // without demanding they be spammed.
  shieldsPerMatch: 2,
  // Set by the caller from the incumbent's measured score. Off by default so an
  // ad-hoc scoring call does not silently fail everything.
  balanceFloor: 0,
  weight: 0.15,
};

export interface Constraints {
  /** A format scoring below this is treated as catastrophic. */
  catastrophicFormat: number;
  /** 1v1 win rate outside [x, 1-x] is catastrophic for that kingdom. */
  duelWinRateBound: number;
  /** FFA first-place rate below fair × this is catastrophic. */
  ffaFirstFloorRatio: number;
  /** FFA last-place rate above fair × this is catastrophic. */
  ffaLastCeilingRatio: number;
  /** Penalty subtracted per catastrophic finding, before clamping. */
  penaltyPerViolation: number;
  /** Overall fitness cannot exceed this when any constraint is violated. */
  violationCap: number;
}

const DEFAULT_DEAD_BANDS: DeadBands = {
  // A kingdom 10% of the way to total dominance costs nothing: 45–55% in 1v1.
  duelKingdom: 0.1,
  // Counters are intentional, so individual matchups get far more room.
  duelMatchup: 0.3,
  ffaFirst: 0.15,
  ffaLast: 0.15,
  ffaPlacement: 0.12,
  ffaDistribution: 0.25,
};

const DEFAULT_COMPONENTS: ComponentWeights = {
  duelKingdom: 0.6,
  duelMatchup: 0.4,
  // First-place rate carries the most weight: "can this kingdom win?" is the
  // question players actually feel. Distribution shape is the tiebreaker that
  // separates a fair-but-swingy kingdom from a fair-but-toothless one.
  ffaFirst: 0.35,
  ffaLast: 0.25,
  ffaPlacement: 0.25,
  ffaDistribution: 0.15,
};

export const DEFAULT_CONSTRAINTS: Constraints = {
  catastrophicFormat: 0.35,
  duelWinRateBound: 0.2, // outside 20–80%
  ffaFirstFloorRatio: 0.35, // below 35% of fair share
  ffaLastCeilingRatio: 2.0, // above twice fair share
  penaltyPerViolation: 0.04,
  violationCap: 0.6,
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface ComponentScore {
  name: string;
  score: number;
  weight: number;
  fairness: Fairness;
}

export interface FormatFitness {
  format: "duel" | "ffa4" | "ffa7";
  score: number;
  weight: number;
  contribution: number;
  components: ComponentScore[];
  /** Mean 95% interval width of the format's headline rate, in points. */
  uncertaintyPp: number;
  matches: number;
}

export interface ConstraintViolation {
  format: string;
  kind: string;
  subject: string;
  observed: number;
  threshold: number;
  detail: string;
}

export interface FitnessDiagnostics {
  /** Per-strategy performance — Economic dominance stays visible but never
   *  scored, because a strategy winning more is not itself a balance defect. */
  strategies: Record<string, { duel: number; ffa4First: number; ffa7First: number }>;
  /** Mean placement by seat index per format. Diagnostic only: rotation keeps
   *  kingdom aggregates unbiased, so this must not reach the score. */
  seatPlacement: Record<string, number[]>;
  /** Widest cross-strategy swing seen in any 1v1 matchup, in points. */
  worstProfileSpreadPp: number;
  timeoutRate: number;
}

export interface FitnessProvenance {
  fitnessVersion: string;
  evaluationFormatVersion: number;
  engineSha: string;
  engineDirty: boolean;
  balanceConfigId: string;
  balanceConfigHash: string;
  balanceBaselineHash: string;
  strategyPopulationVersion: string;
  seedPool: string;
  samplers: Record<string, string>;
  weights: FormatWeights;
  weightsName: string;
  totalMatches: number;
}

export interface FitnessUsage {
  /** Fraction of the ability-coverage target met, in [0,1]. */
  coverage: number;
  /** Fraction of the shields-per-match target met, in [0,1]. */
  shields: number;
  /** Combined behaviour score, in [0,1]. */
  score: number;
  abilitiesUsed: number;
  abilitiesTotal: number;
  shieldsPerMatch: number;
  /** What this actually added to the objective. */
  bonus: number;
}

export interface FitnessResult {
  usage: FitnessUsage;
  /**
   * The authoritative verdict, capped when a constraint is violated. This is
   * the number a human reads and the gate a candidate must pass to be promoted.
   */
  overall: number;
  /**
   * What an optimizer should climb: the same score WITHOUT the constraint cap.
   *
   * `overall` is deliberately discontinuous — any violation pins it to the cap,
   * which is correct for a verdict and useless as a search signal. Measured in
   * Step 8: every candidate in every generation scored exactly 0.6000, so
   * CMA-ES had no information about which direction improved the game and spent
   * 114,588 matches drifting.
   *
   * This value still carries the full per-violation penalty, so fixing two of
   * three violations scores better than fixing one — it simply does not flatten
   * everything that remains imperfect onto a single number. It is NOT a weaker
   * definition of balance: thresholds, weights and what counts as a violation
   * are identical. Only the discontinuity is removed.
   */
  searchObjective: number;
  /** Weighted sum before penalties, for transparency. */
  weightedScore: number;
  penalty: number;
  /** True when a constraint capped the score. */
  capped: boolean;
  formats: FormatFitness[];
  violations: ConstraintViolation[];
  diagnostics: FitnessDiagnostics;
  provenance: FitnessProvenance;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreDuels(
  duel: DuelResults,
  bands: DeadBands,
  comps: ComponentWeights,
): { components: ComponentScore[]; score: number; uncertaintyPp: number } {
  // Kingdom aggregate win rate against an even 50%.
  const kingdomSubjects = Object.entries(duel.kingdoms).map(([subject, r]) => ({
    subject,
    observed: r.rate,
    deviation: normalisedDeviation(r.rate, 0.5, 0.5, 0.5),
  }));
  const kingdom = fairnessFrom(kingdomSubjects, { deadBand: bands.duelKingdom });

  // Individual matchups. A wide dead band keeps deliberate counters free.
  const matchupSubjects = duel.matchups.map((m) => ({
    subject: `${m.a} vs ${m.b}`,
    observed: m.aggregate.rate,
    deviation: normalisedDeviation(m.aggregate.rate, 0.5, 0.5, 0.5),
  }));
  const matchup = fairnessFrom(matchupSubjects, { deadBand: bands.duelMatchup });

  const components: ComponentScore[] = [
    { name: "kingdomWinRate", score: kingdom.score, weight: comps.duelKingdom, fairness: kingdom },
    { name: "matchupBalance", score: matchup.score, weight: comps.duelMatchup, fairness: matchup },
  ];
  const widths = Object.values(duel.kingdoms).map((r) => uncertainty(r) * 100);
  return {
    components,
    score: weightedMean(components),
    uncertaintyPp: widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0,
  };
}

function scoreFfa(
  ffa: FfaResults,
  bands: DeadBands,
  comps: ComponentWeights,
): { components: ComponentScore[]; score: number; uncertaintyPp: number } {
  const seats = ffa.seats;
  const fairRate = 1 / seats;
  const fairPlace = (seats + 1) / 2;
  const kingdoms = Object.values(ffa.kingdoms);

  const first = fairnessFrom(
    kingdoms.map((k) => ({
      subject: k.kingdom,
      observed: k.placement.first.rate,
      deviation: normalisedDeviation(k.placement.first.rate, fairRate),
    })),
    { deadBand: bands.ffaFirst },
  );

  const last = fairnessFrom(
    kingdoms.map((k) => ({
      subject: k.kingdom,
      observed: k.placement.last.rate,
      deviation: normalisedDeviation(k.placement.last.rate, fairRate),
    })),
    { deadBand: bands.ffaLast },
  );

  const placement = fairnessFrom(
    kingdoms.map((k) => ({
      subject: k.kingdom,
      observed: k.placement.average,
      // Placement runs 1..seats, so the room either side of fair is (seats-1)/2.
      deviation: normalisedDeviation(
        k.placement.average,
        fairPlace,
        (seats - 1) / 2,
        (seats - 1) / 2,
      ),
    })),
    { deadBand: bands.ffaPlacement },
  );

  // Distribution shape — the component that separates two kingdoms with the
  // same mean placement but very different odds of actually winning.
  const distribution = fairnessFrom(
    kingdoms.map((k) => ({
      subject: k.kingdom,
      observed: distributionDivergence(k.placement.distribution),
      deviation: distributionDivergence(k.placement.distribution),
    })),
    { deadBand: bands.ffaDistribution },
  );

  const components: ComponentScore[] = [
    { name: "firstPlaceRate", score: first.score, weight: comps.ffaFirst, fairness: first },
    { name: "lastPlaceRate", score: last.score, weight: comps.ffaLast, fairness: last },
    { name: "averagePlacement", score: placement.score, weight: comps.ffaPlacement, fairness: placement },
    { name: "placementShape", score: distribution.score, weight: comps.ffaDistribution, fairness: distribution },
  ];
  const widths = kingdoms.map((k) => uncertainty(k.placement.first) * 100);
  return {
    components,
    score: weightedMean(components),
    uncertaintyPp: widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0,
  };
}

/** Findings severe enough that they must not be averaged away. */
function findViolations(
  result: EvaluationResult,
  formats: FormatFitness[],
  limits: Constraints,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const f of formats) {
    if (f.score < limits.catastrophicFormat) {
      violations.push({
        format: f.format,
        kind: "catastrophicFormat",
        subject: f.format,
        observed: f.score,
        threshold: limits.catastrophicFormat,
        detail: `${f.format} scored ${f.score.toFixed(3)}, below the catastrophic floor`,
      });
    }
  }

  if (result.duel) {
    for (const [kingdom, r] of Object.entries(result.duel.kingdoms)) {
      if (r.rate < limits.duelWinRateBound || r.rate > 1 - limits.duelWinRateBound) {
        violations.push({
          format: "duel",
          kind: "extremeWinRate",
          subject: kingdom,
          observed: r.rate,
          threshold: limits.duelWinRateBound,
          detail: `${kingdom} wins ${(r.rate * 100).toFixed(1)}% of duels`,
        });
      }
    }
  }

  for (const [name, ffa] of [
    ["ffa4", result.ffa4],
    ["ffa7", result.ffa7],
  ] as const) {
    if (!ffa) continue;
    const fair = 1 / ffa.seats;
    for (const k of Object.values(ffa.kingdoms)) {
      if (k.placement.first.rate < fair * limits.ffaFirstFloorRatio) {
        violations.push({
          format: name,
          kind: "cannotWin",
          subject: k.kingdom,
          observed: k.placement.first.rate,
          threshold: fair * limits.ffaFirstFloorRatio,
          detail: `${k.kingdom} takes first ${(k.placement.first.rate * 100).toFixed(1)}% (fair ${(fair * 100).toFixed(1)}%)`,
        });
      }
      if (k.placement.last.rate > fair * limits.ffaLastCeilingRatio) {
        violations.push({
          format: name,
          kind: "chronicLast",
          subject: k.kingdom,
          observed: k.placement.last.rate,
          threshold: fair * limits.ffaLastCeilingRatio,
          detail: `${k.kingdom} finishes last ${(k.placement.last.rate * 100).toFixed(1)}% (fair ${(fair * 100).toFixed(1)}%)`,
        });
      }
    }
  }
  return violations;
}

function collectDiagnostics(result: EvaluationResult): FitnessDiagnostics {
  const strategies: FitnessDiagnostics["strategies"] = {};
  const ids = new Set([
    ...Object.keys(result.duel?.profiles ?? {}),
    ...Object.keys(result.ffa4?.profiles ?? {}),
    ...Object.keys(result.ffa7?.profiles ?? {}),
  ]);
  for (const id of [...ids].sort()) {
    strategies[id] = {
      duel: result.duel?.profiles[id]?.rate ?? 0,
      ffa4First: result.ffa4?.profiles[id]?.rate ?? 0,
      ffa7First: result.ffa7?.profiles[id]?.rate ?? 0,
    };
  }

  const seatPlacement: Record<string, number[]> = {};
  for (const [name, ffa] of [["ffa4", result.ffa4], ["ffa7", result.ffa7]] as const) {
    if (!ffa) continue;
    const sums = new Array<number>(ffa.seats).fill(0);
    const counts = new Array<number>(ffa.seats).fill(0);
    for (const s of Object.values(ffa.seats_)) {
      s.meanPlacement.forEach((p, i) => {
        const n = s.appearances[i] ?? 0;
        if (n > 0) { sums[i]! += p * n; counts[i]! += n; }
      });
    }
    seatPlacement[name] = sums.map((v, i) => (counts[i]! > 0 ? v / counts[i]! : 0));
  }

  const worstProfileSpreadPp = Math.max(
    0,
    ...(result.duel?.matchups.map((m) => m.profileSpread.spread * 100) ?? [0]),
  );

  return {
    strategies,
    seatPlacement,
    worstProfileSpreadPp,
    timeoutRate: result.totals.matches > 0 ? result.totals.timeouts / result.totals.matches : 0,
  };
}

/** Scores an evaluation reading. */
/**
 * Scores behaviour: how much of the game is reachable, and are shields played.
 *
 * Both terms are SATURATING — full marks at the target, nothing beyond it — so
 * neither can be farmed. Coverage is the fraction of castable abilities cast at
 * least once, which is the number this exists to move; casting one ability a
 * thousand times must not substitute for casting a second one once.
 */
export function scoreUsage(
  usage: UsageSummary,
  targets: UsageTargets,
): { coverage: number; shields: number; score: number } {
  const wanted = Math.max(1, Math.round(usage.abilitiesTotal * targets.abilityCoverage));
  const coverage = Math.min(1, usage.abilitiesUsed / wanted);
  const shields =
    targets.shieldsPerMatch <= 0
      ? 1
      : Math.min(1, usage.shieldsPerMatch / targets.shieldsPerMatch);
  // Coverage carries the weight: an unreachable ability is a piece of the game
  // nobody can play, where a missing shield purchase is a habit.
  return { coverage, shields, score: 0.7 * coverage + 0.3 * shields };
}

export function scoreFitness(
  result: EvaluationResult,
  config: FitnessConfig = {},
): FitnessResult {
  const weights = config.weights ?? WEIGHT_PRESETS.ffaPriority!;
  const bands = { ...DEFAULT_DEAD_BANDS, ...config.deadBands };
  const comps = { ...DEFAULT_COMPONENTS, ...config.components };
  const limits = { ...DEFAULT_CONSTRAINTS, ...config.constraints };

  const formats: FormatFitness[] = [];
  const add = (
    format: FormatFitness["format"],
    weight: number,
    scored: { components: ComponentScore[]; score: number; uncertaintyPp: number },
    matches: number,
  ) => {
    formats.push({
      format,
      score: scored.score,
      weight,
      contribution: scored.score * weight,
      components: scored.components,
      uncertaintyPp: scored.uncertaintyPp,
      matches,
    });
  };

  if (result.ffa4) add("ffa4", weights.ffa4, scoreFfa(result.ffa4, bands, comps), result.ffa4.matches);
  if (result.ffa7) add("ffa7", weights.ffa7, scoreFfa(result.ffa7, bands, comps), result.ffa7.matches);
  if (result.duel) add("duel", weights.duel, scoreDuels(result.duel, bands, comps), result.duel.matches);

  // Renormalise so a reading missing a format is still scored on the same
  // scale rather than silently penalised for the absence.
  const totalWeight = formats.reduce((a, f) => a + f.weight, 0);
  const weightedScore =
    totalWeight > 0 ? formats.reduce((a, f) => a + f.contribution, 0) / totalWeight : 0;

  const violations = findViolations(result, formats, limits);

  // ── Balance v4 ───────────────────────────────────────────────────────────
  // The balance score is computed FIRST and is never diluted. Usage is added on
  // top, and a regression below the incumbent's balance is a violation like any
  // other catastrophe — which is what stops usage being bought with fairness.
  const targets = { ...DEFAULT_USAGE_TARGETS, ...config.usage };
  const usage = scoreUsage(result.usage, targets);
  if (targets.balanceFloor > 0 && weightedScore < targets.balanceFloor) {
    violations.push({
      format: "overall",
      kind: "balanceRegression",
      subject: "balance",
      observed: weightedScore,
      threshold: targets.balanceFloor,
      detail:
        `balance ${weightedScore.toFixed(4)} is below the floor ` +
        `${targets.balanceFloor.toFixed(4)} — usage must not be bought with fairness`,
    });
  }

  const penalty = Math.min(0.5, violations.length * limits.penaltyPerViolation);
  // The continuous signal: penalised but never capped, so partial progress is
  // visible to a search. The cap is applied only to `overall` below.
  // Usage takes a RESERVED SHARE of the scale rather than riding on top.
  //
  // Adding a bonus was the obvious shape and it was wrong: a fair game scored
  // 1.0 + 0.15, clamped back to 1.0, so every good candidate flattened to the
  // same number and the search lost all resolution exactly where it operates.
  // Reserving a share keeps the objective in [0,1] and strictly increasing in
  // balance.
  //
  // Trading usage for balance is prevented by the FLOOR, not by the shape: below
  // the incumbent's balance a violation fires, is penalised, and caps the score.
  // Above it, letting usage decide is the entire point of v4.
  const balancePart = (1 - targets.weight) * clamp01(weightedScore - penalty);
  const usagePart = targets.weight * usage.score;
  const usageBonus = usagePart;
  const searchObjective = clamp01(balancePart + usagePart);
  let overall = searchObjective;

  // A hard ceiling on top of the penalty: catastrophic imbalance in one format
  // must not be rescued by excellence elsewhere, which weighted averaging alone
  // would happily allow.
  const capped = violations.length > 0 && overall > limits.violationCap;
  if (capped) overall = limits.violationCap;

  const samplers: Record<string, string> = {};
  if (result.ffa4) samplers.ffa4 = `${result.ffa4.sampler} v${result.ffa4.samplerVersion}`;
  if (result.ffa7) samplers.ffa7 = `${result.ffa7.sampler} v${result.ffa7.samplerVersion}`;

  return {
    overall,
    searchObjective,
    weightedScore,
    penalty,
    capped,
    formats,
    violations,
    usage: {
      ...usage,
      abilitiesUsed: result.usage.abilitiesUsed,
      abilitiesTotal: result.usage.abilitiesTotal,
      shieldsPerMatch: result.usage.shieldsPerMatch,
      bonus: usageBonus,
    },
    diagnostics: collectDiagnostics(result),
    provenance: {
      fitnessVersion: FITNESS_VERSION,
      evaluationFormatVersion: result.provenance.formatVersion,
      engineSha: result.provenance.engineSha,
      engineDirty: result.provenance.engineDirty,
      balanceConfigId: result.provenance.balanceConfigId,
      balanceConfigHash: result.provenance.balanceConfigHash,
      balanceBaselineHash: result.provenance.balanceBaselineHash,
      strategyPopulationVersion: result.provenance.strategyPopulationVersion,
      seedPool: result.pool,
      samplers,
      weights,
      weightsName: config.weightsName ?? namePreset(weights),
      totalMatches: result.totals.matches,
    },
  };
}

function namePreset(weights: FormatWeights): string {
  for (const [name, preset] of Object.entries(WEIGHT_PRESETS)) {
    if (
      Math.abs(preset.ffa4 - weights.ffa4) < 1e-9 &&
      Math.abs(preset.ffa7 - weights.ffa7) < 1e-9 &&
      Math.abs(preset.duel - weights.duel) < 1e-9
    ) {
      return name;
    }
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface FitnessComparison {
  /** Non-null when the two results must not be compared. */
  incomparable: string | null;
  baselineId: string;
  candidateId: string;
  overall: { baseline: number; candidate: number; delta: number };
  formats: {
    format: string;
    baseline: number;
    candidate: number;
    delta: number;
    /** Share of the overall movement this format is responsible for. */
    contributionDelta: number;
  }[];
  violationsAdded: ConstraintViolation[];
  violationsResolved: ConstraintViolation[];
  /** True when the format intervals are tight enough that the movement is
   *  unlikely to be sampling noise. */
  meaningful: boolean;
}

export function compareFitness(
  baseline: FitnessResult,
  candidate: FitnessResult,
): FitnessComparison {
  const problems: string[] = [];
  if (baseline.provenance.fitnessVersion !== candidate.provenance.fitnessVersion) {
    problems.push(
      `fitness ${baseline.provenance.fitnessVersion} vs ${candidate.provenance.fitnessVersion}`,
    );
  }
  if (baseline.provenance.engineSha !== candidate.provenance.engineSha) {
    problems.push("different engine");
  }
  if (baseline.provenance.weightsName !== candidate.provenance.weightsName) {
    problems.push(
      `weights ${baseline.provenance.weightsName} vs ${candidate.provenance.weightsName}`,
    );
  }

  const key = (f: FormatFitness) => f.format;
  const candidateByFormat = new Map(candidate.formats.map((f) => [key(f), f]));
  const formats = baseline.formats.map((b) => {
    const c = candidateByFormat.get(key(b));
    return {
      format: b.format,
      baseline: b.score,
      candidate: c?.score ?? 0,
      delta: (c?.score ?? 0) - b.score,
      contributionDelta: (c?.contribution ?? 0) - b.contribution,
    };
  });

  const sig = (v: ConstraintViolation) => `${v.format}|${v.kind}|${v.subject}`;
  const baseSigs = new Set(baseline.violations.map(sig));
  const candSigs = new Set(candidate.violations.map(sig));

  // Movement is called meaningful only when it exceeds the typical interval
  // width of the formats involved — otherwise it is noise wearing a number.
  const meanUncertainty =
    candidate.formats.reduce((a, f) => a + f.uncertaintyPp, 0) /
    Math.max(1, candidate.formats.length) /
    100;
  const overallDelta = candidate.overall - baseline.overall;

  return {
    incomparable: problems.length > 0 ? problems.join("; ") : null,
    baselineId: baseline.provenance.balanceConfigId,
    candidateId: candidate.provenance.balanceConfigId,
    overall: {
      baseline: baseline.overall,
      candidate: candidate.overall,
      delta: overallDelta,
    },
    formats,
    violationsAdded: candidate.violations.filter((v) => !baseSigs.has(sig(v))),
    violationsResolved: baseline.violations.filter((v) => !candSigs.has(sig(v))),
    meaningful: Math.abs(overallDelta) > meanUncertainty * 0.5,
  };
}
