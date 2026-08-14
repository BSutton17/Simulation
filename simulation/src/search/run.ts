import {
  evaluate,
  balancedDuelPairings,
  type EvaluationConfig,
} from "../evaluation/index.js";
import {
  FITNESS_VERSION,
  WEIGHT_PRESETS,
  scoreFitness,
  type FitnessConfig,
  type FitnessResult,
} from "../fitness/index.js";
import { Cmaes } from "./cmaes.js";
import {
  CHECKPOINT_VERSION,
  cacheKeyOf,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointIdentity,
} from "./checkpoint.js";
import { captureProvenance } from "../evaluation/provenance.js";
import { hashSeed } from "../rng.js";
import {
  CandidateCache,
  makeCandidate,
  type Candidate,
  type CandidateEvaluation,
  type EvaluationTier,
} from "./candidate.js";
import {
  baseVector,
  buildSchema,
  searchable,
  vectorToParameters,
  type BalanceSchema,
} from "./schema.js";

/**
 * The balance search loop.
 *
 * Screening → full evaluation → validation on disjoint seeds. A full reading
 * costs minutes, so evaluating every candidate at full depth would put a modest
 * run into the tens of hours; most candidates only ever need to be rejected,
 * and screening is how they get rejected cheaply.
 *
 * The optimizer may change the game. It may not change what counts as balanced:
 * fitness weights, thresholds and validation seeds are inputs here, never
 * search dimensions.
 */

export const OPTIMIZER_VERSION = "v1";

export interface TierConfig {
  /** Duel pairings to evaluate; omit for all 120. */
  duelPairings?: number;
  duelSeeds: number;
  ffa4Compositions: number;
  ffa7Compositions: number;
  ffaSeeds: number;
  sampler: string;
}

/**
 * Cheap and deliberately approximate — enough to reject the obviously bad.
 *
 * The pairing subset is balanced, never a prefix: with a prefix, Dark would be
 * measured on a single matchup while Water got fifteen, and the search would be
 * steered by a win rate that is not one.
 */
export const SCREEN_TIER: TierConfig = {
  duelPairings: 32,
  duelSeeds: 1,
  ffa4Compositions: 8,
  ffa7Compositions: 6,
  ffaSeeds: 1,
  sampler: "coverage",
};

/**
 * What a candidate must survive to be taken seriously.
 *
 * All 120 pairings: at 36 ordered strategy pairings each, that resolves a
 * kingdom's aggregate win rate to about ±1.3pp, comfortably finer than the 20%
 * constraint bound it is checked against. Trimming this tier is what made it
 * disagree with reference depth in Step 9, so it is deliberately left whole.
 */
export const FULL_TIER: TierConfig = {
  duelSeeds: 1,
  ffa4Compositions: 24,
  ffa7Compositions: 16,
  ffaSeeds: 1,
  sampler: "stratified",
};

/** Reference depth, on seeds the search never saw. */
export const VALIDATION_TIER: TierConfig = {
  duelSeeds: 3,
  ffa4Compositions: 50,
  ffa7Compositions: 32,
  ffaSeeds: 3,
  sampler: "stratified",
};

export interface SearchConfig {
  schema?: BalanceSchema;
  /** CMA-ES seed. The whole run is reproducible from it. */
  seed?: number;
  generations?: number;
  populationSize?: number;
  sigma?: number;
  workers?: number;
  /** Candidates promoted from screening to full evaluation each generation. */
  promote?: number;
  /** Elites validated at the end of the run. */
  validate?: number;
  fitness?: FitnessConfig;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => string;
  /** Where to write a resumable checkpoint after each generation. Omit to
   *  disable checkpointing entirely. */
  checkpointPath?: string;
  /** Ignore any checkpoint on disk and start over. */
  restart?: boolean;
  /**
   * Wall-clock budget in milliseconds. When it runs out the search stops at the
   * next generation boundary and returns normally.
   *
   * Hosted runners kill a session on a hard clock. Being killed is survivable —
   * the checkpoint is one generation old at worst — but it forfeits the
   * validation stage and the final artifacts. Stopping deliberately keeps them.
   */
  budgetMs?: number;
}

export interface ProgressEvent {
  kind: "generation" | "candidate";
  generation: number;
  message: string;
}

export interface GenerationRecord {
  generation: number;
  screened: number;
  promoted: number;
  cached: number;
  failed: number;
  bestScreen: number;
  meanScreen: number;
  worstScreen: number;
  bestFull: number | null;
  bestCandidateId: string | null;
  durationMs: number;
}

export interface SearchResult {
  optimizer: string;
  optimizerVersion: string;
  seed: number;
  schema: BalanceSchema;
  /** Search objective (uncapped) at each tier. */
  baseline: { screen: number | null; full: number | null; validation: number | null };
  /** Authoritative capped verdict at each tier. */
  baselineVerdict: { full: number | null; validation: number | null };
  generations: GenerationRecord[];
  best: {
    candidate: Candidate;
    screen: number | null;
    full: number | null;
    validation: number | null;
    /** Capped verdicts — a candidate is only a real improvement if these hold up. */
    fullVerdict: number | null;
    validationVerdict: number | null;
  } | null;
  /** Every full/validation evaluation, for the report. */
  evaluations: CandidateEvaluation[];
  /** Non-null when this run continued from a checkpoint. */
  resumedFrom: { generations: number; cacheEntries: number } | null;
  /** Set when the wall-clock budget ended the run before `generations`. The
   *  checkpoint is complete, so a later session resumes from here. */
  stoppedEarly: { afterGeneration: number; of: number; reason: string } | null;
  /** Set when a checkpoint existed but was refused, with the reason. */
  checkpointRejected: string | null;
  cache: { hits: number; misses: number; size: number };
  totals: { candidates: number; screens: number; fulls: number; validations: number; failures: number; matches: number; durationMs: number };
}

/** Builds the evaluation configuration for a tier. */
function evaluationConfig(
  tier: TierConfig,
  pool: "training" | "validation",
  parameters: Record<string, number> | null,
  id: string,
  workers: number | undefined,
): EvaluationConfig {
  return {
    balanceConfigId: id,
    balance: parameters,
    pool,
    workers,
    duel: {
      enabled: true,
      seedsPerPairing: tier.duelSeeds,
      pairings: tier.duelPairings ? balancedDuelPairings(tier.duelPairings) : undefined,
    },
    ffa4: {
      enabled: true,
      seedsPerPairing: tier.ffaSeeds,
      compositions: tier.ffa4Compositions,
      sampler: tier.sampler,
    },
    ffa7: {
      enabled: true,
      seedsPerPairing: tier.ffaSeeds,
      compositions: tier.ffa7Compositions,
      sampler: tier.sampler,
    },
  };
}

const TIERS: Record<EvaluationTier, TierConfig> = {
  screen: SCREEN_TIER,
  full: FULL_TIER,
  validation: VALIDATION_TIER,
};

/**
 * Attempts per evaluation before a failure is believed.
 *
 * An evaluation can fail for two very different reasons: the candidate breaks
 * the simulator, or the machine hiccuped — a worker killed by memory pressure,
 * a thread that failed to spawn. The first is a genuine result about the
 * candidate. The second is noise, and recording it as a result is actively
 * harmful: the candidate sinks to the bottom of the ranking and CMA-ES learns
 * to avoid a perfectly good region of the search space for no reason. On a
 * hosted runner over many hours, the second kind is the one to expect.
 *
 * Retrying once separates them cheaply. Evaluation is deterministic, so a real
 * candidate-caused crash reproduces and still gets recorded; a transient one
 * usually does not.
 */
const EVALUATION_ATTEMPTS = 2;

/** Evaluates one candidate at one tier, going through the cache. */
async function evaluateCandidate(
  candidate: Candidate,
  tier: EvaluationTier,
  cache: CandidateCache,
  config: SearchConfig,
  fitnessConfig: FitnessConfig,
): Promise<CandidateEvaluation> {
  const cached = cache.get(candidate.hash, tier);
  if (cached) return { ...cached, cached: true };

  // Validation must never touch the pool the search trained on, or an
  // "improvement" is just the optimizer recognising its own dice.
  const pool = tier === "validation" ? "validation" : "training";
  const started = performance.now();
  const attempts: string[] = [];
  let evaluation: CandidateEvaluation | null = null;

  for (let attempt = 1; attempt <= EVALUATION_ATTEMPTS; attempt++) {
    try {
      const reading = await evaluate(
        evaluationConfig(
          TIERS[tier],
          pool,
          candidate.parameters,
          `${candidate.id}:${tier}`,
          config.workers,
        ),
      );
      evaluation = {
        candidate,
        tier,
        fitness: scoreFitness(reading, fitnessConfig),
        failure: null,
        durationMs: performance.now() - started,
        cached: false,
      };
      if (attempt > 1) {
        config.onProgress?.({
          kind: "candidate",
          generation: candidate.generation,
          message: `${candidate.id}:${tier} recovered on attempt ${attempt} after: ${attempts[0]}`,
        });
      }
      break;
    } catch (error) {
      attempts.push((error as Error).message);
    }
  }

  if (!evaluation) {
    // Failed every attempt: this is a property of the candidate, not the
    // machine. Recorded and scored at the floor, never silently skipped.
    evaluation = {
      candidate,
      tier,
      fitness: null,
      failure: `failed ${EVALUATION_ATTEMPTS} attempts: ${[...new Set(attempts)].join(" | ")}`,
      durationMs: performance.now() - started,
      cached: false,
    };
    config.onProgress?.({
      kind: "candidate",
      generation: candidate.generation,
      message: `${candidate.id}:${tier} FAILED — ${evaluation.failure}`,
    });
  }
  cache.set(evaluation);
  return evaluation;
}

/**
 * What the search climbs.
 *
 * `searchObjective`, not `overall`: the capped verdict pins every candidate
 * with a violation to the same number, which measured in Step 8 as a perfectly
 * flat landscape — 0.6000 in every generation, no gradient at all. The
 * uncapped score still carries the full per-violation penalty, so reducing two
 * violations beats reducing one; it simply does not collapse everything
 * imperfect onto one value.
 *
 * A failed candidate sinks to the bottom deterministically.
 */
function rankOf(evaluation: CandidateEvaluation): number {
  return evaluation.failure !== null ? -1 : (evaluation.fitness?.searchObjective ?? -1);
}

/** The authoritative verdict — what a candidate must pass to be promoted to a
 *  real balance change. Never used to steer the search. */
function verdictOf(evaluation: CandidateEvaluation): number {
  return evaluation.failure !== null ? 0 : (evaluation.fitness?.overall ?? 0);
}

/** Runs a CMA-ES balance search. */
export async function runSearch(config: SearchConfig = {}): Promise<SearchResult> {
  const schema = config.schema ?? buildSchema();
  const params = searchable(schema);
  const fitnessConfig: FitnessConfig = config.fitness ?? {
    weights: WEIGHT_PRESETS.designerPriority,
    weightsName: "designerPriority",
  };
  const seed = config.seed ?? 20260813;
  const generations = config.generations ?? 10;
  const promote = config.promote ?? 3;
  const validateCount = config.validate ?? 1;

  const populationSize = config.populationSize ?? null;
  const sigma = config.sigma ?? 0.2;
  const provenance = captureProvenance({
    balanceConfigId: "search",
    strategyPopulationVersion: "v1",
    now: config.now,
  });

  const cache = new CandidateCache({
    engineSha: provenance.engineSha,
    fitnessVersion: FITNESS_VERSION,
    schemaVersion: schema.version,
    seedPool: "training",
    samplerVersions: `${SCREEN_TIER.sampler}/${FULL_TIER.sampler}`,
  });

  // A checkpoint may only be resumed into an identical run. Folding the tier
  // configs into the identity means a resume cannot silently mix scores taken
  // at different evaluation depths, which would be invisible in the output.
  const identity: CheckpointIdentity = {
    engineSha: provenance.engineSha,
    engineDirty: provenance.engineDirty,
    schemaVersion: schema.version,
    catalogHash: schema.catalogHash,
    fitnessVersion: FITNESS_VERSION,
    optimizerVersion: OPTIMIZER_VERSION,
    weightsName: fitnessConfig.weightsName ?? "custom",
    seed,
    generations,
    populationSize,
    sigma,
    tiersHash: hashSeed(JSON.stringify([SCREEN_TIER, FULL_TIER, VALIDATION_TIER]))
      .toString(16)
      .padStart(8, "0"),
  };

  const loaded =
    config.checkpointPath && !config.restart
      ? readCheckpoint(config.checkpointPath, identity)
      : { checkpoint: null, rejected: null };
  if (loaded.rejected) {
    config.onProgress?.({
      kind: "generation",
      generation: -1,
      message: `starting fresh — ${loaded.rejected}`,
    });
  }

  const started = performance.now();
  const evaluations: CandidateEvaluation[] = [];
  let matches = 0;
  let screens = 0;
  let fulls = 0;
  let validations = 0;
  let failures = 0;

  const record = (e: CandidateEvaluation) => {
    if (e.cached) return;
    if (e.tier === "screen") screens += 1;
    else if (e.tier === "full") fulls += 1;
    else validations += 1;
    if (e.failure) failures += 1;
    matches += e.fitness?.provenance.totalMatches ?? 0;
  };

  // The baseline is evaluated through the same pipeline, so "better than
  // baseline" is a like-for-like comparison rather than an appeal to an
  // earlier run with different settings.
  const baselineCandidate = makeCandidate({
    schema,
    vector: baseVector(schema),
    parameters: {},
    generation: -1,
    index: 0,
    optimizer: "baseline",
  });
  // Restoring the cache BEFORE the baseline runs is what makes a resume cheap:
  // the baseline's two evaluations are the single most expensive thing in a
  // short run, and they are identical every time.
  const resumed = loaded.checkpoint;
  const restoredEntries = resumed ? cache.load(resumed.cacheEntries) : 0;
  if (resumed) {
    config.onProgress?.({
      kind: "generation",
      generation: resumed.completedGenerations,
      message:
        `resuming from checkpoint at generation ${resumed.completedGenerations}/${generations} ` +
        `(${restoredEntries} cached evaluations)`,
    });
  }

  config.onProgress?.({ kind: "generation", generation: -1, message: "evaluating baseline" });
  const baselineScreen = await evaluateCandidate(baselineCandidate, "screen", cache, config, fitnessConfig);
  record(baselineScreen);
  evaluations.push(baselineScreen);
  const baselineFull = await evaluateCandidate(baselineCandidate, "full", cache, config, fitnessConfig);
  record(baselineFull);
  evaluations.push(baselineFull);

  const cma = resumed
    ? Cmaes.restore(resumed.cma)
    : new Cmaes({
        dimension: params.length,
        mean: baseVector(schema),
        sigma,
        populationSize: config.populationSize,
        seed,
      });

  const generationRecords: GenerationRecord[] = resumed ? [...resumed.generationRecords] : [];
  let stoppedEarly: SearchResult["stoppedEarly"] = null;
  let bestFull: CandidateEvaluation | null = null;
  let candidateCount = resumed ? resumed.counters.candidateCount : 0;
  const firstGeneration = resumed ? resumed.completedGenerations : 0;

  if (resumed) {
    // Replay the previous run's bookkeeping so the final report describes the
    // whole search, not just the segment after the interruption.
    for (const e of resumed.evaluations) {
      if (!evaluations.some((x) => x.candidate.hash === e.candidate.hash && x.tier === e.tier)) {
        evaluations.push(e);
      }
    }
    matches += resumed.counters.matches;
    screens += resumed.counters.screens;
    fulls += resumed.counters.fulls;
    validations += resumed.counters.validations;
    failures += resumed.counters.failures;
    if (resumed.bestFullKey) {
      bestFull =
        resumed.cacheEntries.find(
          (x) => cacheKeyOf(x.evaluation.candidate.hash, x.evaluation.tier) === resumed.bestFullKey,
        )?.evaluation ?? null;
    }
  }

  for (let g = firstGeneration; g < generations; g++) {
    const genStarted = performance.now();
    const vectors = cma.ask();
    const candidates = vectors.map((vector, index) =>
      makeCandidate({
        schema,
        vector,
        parameters: vectorToParameters(schema, vector),
        generation: g,
        index,
        optimizer: "cmaes",
      }),
    );
    candidateCount += candidates.length;

    // Screen everything cheaply.
    const screened: CandidateEvaluation[] = [];
    for (const candidate of candidates) {
      const e = await evaluateCandidate(candidate, "screen", cache, config, fitnessConfig);
      record(e);
      screened.push(e);
    }

    // CMA-ES learns from the screening scores: they are what every candidate
    // has, and using full scores for some and screening for others would feed
    // the strategy an inconsistent objective.
    cma.tell(vectors, screened.map(rankOf));

    // Promote the best few to a real evaluation.
    const promoted = [...screened]
      .sort((a, b) => rankOf(b) - rankOf(a) || a.candidate.index - b.candidate.index)
      .slice(0, promote);
    let bestFullThisGen: number | null = null;
    for (const p of promoted) {
      if (p.failure) continue;
      const full = await evaluateCandidate(p.candidate, "full", cache, config, fitnessConfig);
      record(full);
      evaluations.push(full);
      const score = rankOf(full);
      if (bestFullThisGen === null || score > bestFullThisGen) bestFullThisGen = score;
      if (!bestFull || score > rankOf(bestFull)) bestFull = full;
    }

    const scores = screened.map(rankOf);
    generationRecords.push({
      generation: g,
      screened: screened.length,
      promoted: promoted.length,
      cached: screened.filter((e) => e.cached).length,
      failed: screened.filter((e) => e.failure).length,
      bestScreen: Math.max(...scores),
      meanScreen: scores.reduce((a, b) => a + b, 0) / scores.length,
      worstScreen: Math.min(...scores),
      bestFull: bestFullThisGen,
      bestCandidateId: bestFull?.candidate.id ?? null,
      durationMs: performance.now() - genStarted,
    });
    config.onProgress?.({
      kind: "generation",
      generation: g,
      message:
        `gen ${g + 1}/${generations}  screen best ${Math.max(...scores).toFixed(4)}  ` +
        `mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)}  ` +
        `full best ${bestFull ? rankOf(bestFull).toFixed(4) : "—"}`,
    });

    // Written AFTER the generation is fully accounted for, so a checkpoint
    // never describes a half-finished generation. A failure to write must not
    // destroy a run that is otherwise fine — a lost checkpoint costs time, an
    // aborted search costs everything.
    if (config.checkpointPath) {
      try {
        writeCheckpoint(config.checkpointPath, {
          version: CHECKPOINT_VERSION,
          identity,
          writtenAt: (config.now ?? (() => new Date().toISOString()))(),
          completedGenerations: g + 1,
          cma: cma.snapshot(),
          schema,
          generationRecords,
          evaluations,
          cacheEntries: cache.dump(),
          bestFullKey: bestFull ? cacheKeyOf(bestFull.candidate.hash, bestFull.tier) : null,
          counters: {
            candidateCount,
            matches, screens, fulls, validations, failures,
            elapsedMs: performance.now() - started,
          },
        });
      } catch (error) {
        config.onProgress?.({
          kind: "generation",
          generation: g,
          message: `checkpoint write failed (continuing): ${(error as Error).message}`,
        });
      }
    }

    // Checked AFTER the checkpoint, so the work just finished is never the work
    // that gets lost.
    if (config.budgetMs !== undefined && performance.now() - started >= config.budgetMs && g + 1 < generations) {
      stoppedEarly = {
        afterGeneration: g + 1,
        of: generations,
        reason: `wall-clock budget of ${(config.budgetMs / 3600000).toFixed(2)}h reached`,
      };
      config.onProgress?.({
        kind: "generation",
        generation: g,
        message: `stopping at generation ${g + 1}/${generations} — ${stoppedEarly.reason}; resume from the checkpoint`,
      });
      break;
    }
  }

  // Validate the elite on seeds the search never saw.
  let bestValidation: CandidateEvaluation | null = null;
  let baselineValidation: CandidateEvaluation | null = null;
  // A truncated run skips validation: the budget that ended it is the same
  // budget validation would have to come out of, and the elite it would
  // validate is provisional anyway. The resumed session validates the real one.
  if (bestFull && validateCount > 0 && !stoppedEarly) {
    config.onProgress?.({ kind: "generation", generation: generations, message: "validating elite on disjoint seeds" });
    baselineValidation = await evaluateCandidate(baselineCandidate, "validation", cache, config, fitnessConfig);
    record(baselineValidation);
    evaluations.push(baselineValidation);
    bestValidation = await evaluateCandidate(bestFull.candidate, "validation", cache, config, fitnessConfig);
    record(bestValidation);
    evaluations.push(bestValidation);
  }

  return {
    optimizer: "cmaes",
    optimizerVersion: OPTIMIZER_VERSION,
    seed,
    schema,
    baseline: {
      screen: rankOf(baselineScreen),
      full: rankOf(baselineFull),
      validation: baselineValidation ? rankOf(baselineValidation) : null,
    },
    baselineVerdict: {
      full: verdictOf(baselineFull),
      validation: baselineValidation ? verdictOf(baselineValidation) : null,
    },
    generations: generationRecords,
    best: bestFull
      ? {
          candidate: bestFull.candidate,
          screen: cache.get(bestFull.candidate.hash, "screen")?.fitness?.searchObjective ?? null,
          full: rankOf(bestFull),
          validation: bestValidation ? rankOf(bestValidation) : null,
          fullVerdict: verdictOf(bestFull),
          validationVerdict: bestValidation ? verdictOf(bestValidation) : null,
        }
      : null,
    evaluations,
    resumedFrom: resumed
      ? { generations: resumed.completedGenerations, cacheEntries: restoredEntries }
      : null,
    stoppedEarly,
    checkpointRejected: loaded.rejected,
    cache: cache.stats,
    totals: {
      candidates: candidateCount,
      screens, fulls, validations, failures, matches,
      durationMs: performance.now() - started,
    },
  };
}

/** Fitness results keyed for reporting. */
export function fitnessOf(
  result: SearchResult,
  candidateHash: string,
  tier: EvaluationTier,
): FitnessResult | null {
  return (
    result.evaluations.find(
      (e) => e.candidate.hash === candidateHash && e.tier === tier,
    )?.fitness ?? null
  );
}
