import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Population, cloneGenome, type GenerationReport, type Genome } from "../neat/index.js";
import {
  MODEL_FORMAT_VERSION,
  type AiModel,
  type Difficulty,
} from "../ai/index.js";
import type { TrainingConfig } from "./config.js";
import { ELEMENTALS_SHAPE, evaluateGenome } from "./matchEvaluator.js";
import { buildSlate, slateSize, type SlateEntry } from "./slate.js";
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
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  matches: number;
  durationMs: number;
}

export interface TrainingResult {
  generations: number;
  history: GenerationRecord[];
  best: Genome;
  bestFitness: number;
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

export function train(options: TrainOptions): TrainingResult {
  const { config } = options;
  const identity = localIdentity(config);

  let population: Population;
  let history: GenerationRecord[] = [];
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
  let champion: Genome | null = null;

  for (let generation = startGeneration; generation < config.generations; generation++) {
    const generationStarted = Date.now();
    // One slate per generation, shared by every genome: differences in fitness
    // are then differences in play rather than in which matchups were drawn.
    const slate: SlateEntry[] = buildSlate(generation, config.slate, config.kingdoms, config.seed);
    const genomes = population.ask();

    const evaluations = genomes.map((genome) =>
      evaluateGenome(genome, slate, config.fitness, config.slate.maxTicks),
    );
    evaluations.forEach((evaluation, i) => {
      if (champion === null || evaluation.fitness > champion.fitness) {
        const snapshot = cloneGenome(genomes[i]!);
        snapshot.fitness = evaluation.fitness;
        champion = snapshot;
      }
    });
    const report = population.tell(evaluations.map((e) => e.fitness));

    const record: GenerationRecord = {
      ...report,
      wins: evaluations.reduce((sum, e) => sum + e.wins, 0),
      timeouts: evaluations.reduce((sum, e) => sum + e.timeouts, 0),
      inactive: evaluations.reduce((sum, e) => sum + e.inactive, 0),
      meanPlacement:
        evaluations.reduce((sum, e) => sum + e.meanPlacement, 0) / evaluations.length,
      matches: evaluations.reduce((sum, e) => sum + e.matches, 0),
      durationMs: Date.now() - generationStarted,
    };
    history.push(record);
    options.onGeneration?.(record);

    if (
      options.checkpointPath &&
      config.checkpointEvery > 0 &&
      (generation + 1) % config.checkpointEvery === 0
    ) {
      const checkpoint: TrainingCheckpoint = {
        version: TRAINING_CHECKPOINT_VERSION,
        identity,
        writtenAt: new Date().toISOString(),
        completedGenerations: generation + 1,
        population: population.snapshot(),
        history,
      };
      writeCheckpoint(options.checkpointPath, checkpoint);
    }

    if (options.budgetMs !== undefined && Date.now() - started >= options.budgetMs) break;
  }

  const best: Genome = champion ?? population.best();
  return {
    generations: history.length,
    history,
    best,
    bestFitness: best.fitness,
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
      fitnessVersion: identity.fitnessVersion,
      trainedAt: new Date().toISOString(),
    },
    genome,
  };
}

export function writeModel(path: string, model: AiModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2), "utf8");
}
