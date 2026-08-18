import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Population, cloneGenome, type GenerationReport, type Genome } from "../neat/index.js";
import { MODEL_FORMAT_VERSION, type AiModel, type Difficulty } from "../ai/index.js";
import type { TrainingConfig } from "./config.js";
import { ELEMENTALS_SHAPE, evaluateGenome } from "./matchEvaluator.js";
import { buildSlate, buildValidationSlate, slateSize, type Slate } from "./slate.js";
import type { TrainingResult } from "./fitness.js";
import { AI_FITNESS_VERSION } from "./fitness.js";
import {
  TRAINING_CHECKPOINT_VERSION,
  localIdentity,
  readCheckpoint,
  writeCheckpoint,
  type TrainingCheckpoint,
} from "./checkpoint.js";

/**
 * The training loop.
 *
 * Deliberately thin: NEAT owns evolution, `matchEvaluator` owns the game, and
 * this coordinates them and writes down what happened. Everything expensive is
 * behind `evaluateGenome`, so a distributed version later replaces one call
 * rather than restructuring the loop — the same shape `search/run.ts` uses.
 */

export interface GenerationRecord extends GenerationReport {
  wins: number;
  losses: number;
  draws: number;
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  matches: number;
  damageDealt: number;
  damageReceived: number;
  kills: number;
  casts: number;
  slateHash: string;
  /**
   * Champion fitness on the frozen validation slate, when one was run this
   * generation. Null otherwise — never interpolated, because a made-up point on
   * a generalisation curve is worse than a gap in it.
   */
  validationFitness: number | null;
  validationWins: number | null;
  durationMs: number;
}

export interface TrainingRunResult {
  generations: number;
  history: GenerationRecord[];
  best: Genome;
  bestFitness: number;
  /** Generation the champion was found in; survives a resume. */
  bestGeneration: number | null;
  /**
   * The champion's full per-scenario result.
   *
   * Null when the champion was restored from a checkpoint rather than found in
   * this session — the detail is too large to persist, and the genome is what a
   * model needs.
   */
  bestResult: TrainingResult | null;
  resumedFrom: number | null;
  checkpointRejected: string | null;
}

export interface TrainOptions {
  config: TrainingConfig;
  /** Where to write the checkpoint; omit for an in-memory run. */
  checkpointPath?: string;
  /** Resume from `checkpointPath` when one is present and compatible. */
  resume?: boolean;
  onGeneration?: (record: GenerationRecord) => void;
  /** Stop at the next generation boundary once this much wall clock is spent. */
  budgetMs?: number;
}

export function train(options: TrainOptions): TrainingRunResult {
  const { config } = options;
  const identity = localIdentity(config);

  let population: Population;
  let history: GenerationRecord[] = [];
  let restoredChampion: Genome | null = null;
  let restoredChampionGeneration: number | null = null;
  let startGeneration = 0;
  let resumedFrom: number | null = null;
  let checkpointRejected: string | null = null;

  if (options.resume && options.checkpointPath) {
    const load = readCheckpoint(options.checkpointPath, identity);
    checkpointRejected = load.rejected;
    if (load.checkpoint) {
      population = Population.restore(load.checkpoint.population, config.neat);
      history = load.checkpoint.history;
      startGeneration = load.checkpoint.completedGenerations;
      resumedFrom = startGeneration;
      restoredChampion = load.checkpoint.champion;
      restoredChampionGeneration = load.checkpoint.championGeneration;
    } else {
      population = new Population(ELEMENTALS_SHAPE, config.neat, config.seed);
    }
  } else {
    population = new Population(ELEMENTALS_SHAPE, config.neat, config.seed);
  }

  const started = Date.now();
  // The champion is snapshotted at EVALUATION time, not read back from the
  // population afterwards. `tell()` replaces the population, and elites are
  // cloned complete with their parent's fitness, so asking the live population
  // for its best after a generation returns a genome whose recorded fitness was
  // measured on a different generation's slate.
  // Built once and reused: frozen is the whole point, and rebuilding it per
  // generation would invite it to drift.
  const validationSlate =
    config.validateEvery > 0
      ? buildValidationSlate(config.kingdoms, config.balanceConfigId, {
          maxTicks: config.slate.maxTicks,
        })
      : null;

  let champion: Genome | null = restoredChampion;
  let championGeneration: number | null = restoredChampionGeneration;
  // Only populated when the champion is found in THIS session: the per-scenario
  // detail is far too large to carry in a checkpoint, and the genome is what a
  // model actually needs.
  let championResult: TrainingResult | null = null;

  for (let generation = startGeneration; generation < config.generations; generation++) {
    const generationStarted = Date.now();
    // One slate per generation, shared by every genome: a fitness difference is
    // then a difference in play rather than in which matchups were drawn.
    const slate: Slate = buildSlate(
      generation,
      config.slate,
      config.kingdoms,
      config.seed,
      config.balanceConfigId,
    );
    const genomes = population.ask();
    const results = genomes.map((genome) => evaluateGenome(genome, slate, config.fitness));

    results.forEach((result, i) => {
      if (champion === null || result.fitness > champion.fitness) {
        const snapshot = cloneGenome(genomes[i]!);
        snapshot.fitness = result.fitness;
        champion = snapshot;
        championGeneration = generation;
        championResult = result;
      }
    });

    const report = population.tell(results.map((r) => r.fitness));
    const sum = (pick: (r: TrainingResult) => number): number =>
      results.reduce((total, r) => total + pick(r), 0);

    // Validation runs on the CHAMPION only — one genome, not the population —
    // so a broad slate stays affordable.
    let validationFitness: number | null = null;
    let validationWins: number | null = null;
    // Scheduled purely by generation INDEX, never by position within the run.
    // An earlier version also validated on the final generation, which made the
    // schedule depend on config.generations — so a run stopped at 2 and resumed
    // to 4 validated at different generations than one that ran straight
    // through, and the recorded history diverged. Caught by the resume-
    // equivalence test.
    if (
      validationSlate &&
      champion !== null &&
      config.validateEvery > 0 &&
      generation % config.validateEvery === 0
    ) {
      const validated = evaluateGenome(champion, validationSlate, config.fitness);
      validationFitness = validated.fitness;
      validationWins = validated.wins;
    }

    const record: GenerationRecord = {
      ...report,
      wins: sum((r) => r.wins),
      losses: sum((r) => r.losses),
      draws: sum((r) => r.draws),
      timeouts: sum((r) => r.timeouts),
      inactive: sum((r) => r.inactive),
      meanPlacement: sum((r) => r.meanPlacement) / results.length,
      matches: sum((r) => r.matches),
      damageDealt: sum((r) => r.totalDamageDealt),
      damageReceived: sum((r) => r.totalDamageReceived),
      kills: sum((r) => r.totalKills),
      casts: sum((r) => r.totalCasts),
      slateHash: slate.hash,
      validationFitness,
      validationWins,
      durationMs: Date.now() - generationStarted,
    };
    history.push(record);
    options.onGeneration?.(record);

    if (
      options.checkpointPath &&
      config.checkpointEvery > 0 &&
      (generation + 1) % config.checkpointEvery === 0
    ) {
      writeCheckpoint(options.checkpointPath, {
        version: TRAINING_CHECKPOINT_VERSION,
        identity,
        writtenAt: new Date().toISOString(),
        completedGenerations: generation + 1,
        population: population.snapshot(),
        history,
        champion,
        championGeneration,
      } satisfies TrainingCheckpoint);
    }

    if (options.budgetMs !== undefined && Date.now() - started >= options.budgetMs) break;
  }

  const best: Genome = champion ?? population.best();
  return {
    generations: history.length,
    history,
    best,
    bestFitness: best.fitness,
    bestGeneration: championGeneration,
    bestResult: championResult,
    resumedFrom,
    checkpointRejected,
  };
}

/** Matches one training run will play, for budgeting. */
export function estimateMatches(config: TrainingConfig): number {
  return (
    config.neat.populationSize *
    slateSize(config.slate, config.kingdoms.length) *
    config.generations
  );
}

/**
 * Packages a trained genome as a loadable model.
 *
 * Difficulty is a property of the MODEL, not of the algorithm: the same NEAT
 * engine produces all three, and `ai/difficulty.ts` decides cadence and noise at
 * runtime. That is what keeps Easy/Medium/Hard one lineage rather than three
 * unrelated players.
 */
export function toModel(
  genome: Genome,
  config: TrainingConfig,
  difficulty: Difficulty,
  generation: number,
): AiModel {
  const identity = localIdentity(config);
  return {
    formatVersion: MODEL_FORMAT_VERSION,
    kind: "elementals.ai.model",
    difficulty,
    identity: {
      observationVersion: identity.observationVersion,
      actionVersion: identity.actionVersion,
      genomeVersion: identity.genomeVersion,
      engineSha: identity.engineSha,
      engineDirty: identity.engineDirty,
      balanceConfigHash: identity.balanceConfigHash,
      balanceBaselineHash: identity.balanceBaselineHash,
      kingdomCount: 16,
    },
    training: {
      seed: config.seed,
      generation,
      fitnessVersion: AI_FITNESS_VERSION,
      trainedAt: new Date().toISOString(),
    },
    genome,
  };
}

export function writeModel(path: string, model: AiModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2), "utf8");
}
