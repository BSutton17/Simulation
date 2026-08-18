/**
 * Training — the only layer that knows both NEAT and Elementals.
 *
 *   neat/      generic algorithm; no game types at all
 *   training/  the adapter: genome → network → controller → matches → fitness
 *   ai/        runtime representation and the gameplay controller
 */

export {
  AI_FITNESS_VERSION,
  DEFAULT_FITNESS,
  DEFAULT_SLATE,
  trainingConfig,
  type FitnessConfig,
  type SlateConfig,
  type TrainingConfig,
} from "./config.js";
export {
  aggregate,
  placementOf,
  scoreMatch,
  type GenomeFitness,
  type MatchScore,
} from "./fitness.js";
export { buildSlate, slateSize, type SlateEntry } from "./slate.js";
export {
  ELEMENTALS_SHAPE,
  evaluateGenome,
  playMatch,
  type GenomeEvaluation,
} from "./matchEvaluator.js";
export {
  TRAINING_CHECKPOINT_VERSION,
  identityMismatches,
  localIdentity,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointLoad,
  type TrainingCheckpoint,
  type TrainingIdentity,
} from "./checkpoint.js";
export {
  estimateMatches,
  toModel,
  train,
  writeModel,
  type GenerationRecord,
  type TrainOptions,
  type TrainingResult,
} from "./trainer.js";
