/**
 * Training — the only layer that knows both NEAT and Elementals.
 *
 *   neat/      generic algorithm; no game types at all
 *   training/  the adapter: genome → network → controller → matches → fitness
 *   ai/        runtime representation and the gameplay controller
 */

export {
  trainingConfig,
  DEFAULT_FITNESS,
  DEFAULT_SLATE,
  type FitnessConfig,
  type SlateConfig,
  type TrainingConfig,
} from "./config.js";

export {
  AI_FITNESS_VERSION,
  aggregate,
  maxScore,
  placementOf,
  scoreScenario,
  type FitnessTerms,
  type ScenarioContext,
  type ScenarioResult,
  type TrainingResult,
} from "./fitness.js";

export {
  FORMAT_SEATS,
  SLATE_VERSION,
  buildSlate,
  buildValidationSlate,
  hashSlate,
  slateSeatCost,
  slateShapeHash,
  slateSize,
  type MatchFormat,
  type Slate,
  type SlateScenario,
} from "./slate.js";

export { CombatObserver, type SeatCombat } from "./matchObserver.js";

export {
  behaviourDiversity,
  correlation,
  fitnessReliability,
  heritability,
  stdev,
  validationDiscrimination,
  type BehaviourReport,
  type DiscriminationReport,
  type HeritabilityReport,
  type ReliabilityReport,
} from "./diagnostics.js";

export {
  DEFAULT_SELF_PLAY,
  HallOfFame,
  buildSelfPlayTables,
  evaluatePopulation,
  playTable,
  tableCount,
  type SelfPlayConfig,
  type SelfPlayTable,
} from "./selfPlay.js";

export {
  ELEMENTALS_SHAPE,
  evaluateCandidate,
  evaluateGenome,
  networkCandidate,
  personalityCandidate,
  playScenario,
  type Candidate,
} from "./matchEvaluator.js";

export {
  formatBaselines,
  minimalGenomeCandidate,
  randomCandidate,
  runBaselines,
  type BaselineEntry,
  type BaselineOptions,
  type BaselineReport,
} from "./baselines.js";

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
  championWouldRegress,
  estimateMatches,
  toModel,
  train,
  writeModel,
  type GenerationRecord,
  type TrainOptions,
  type TrainingRunResult,
} from "./trainer.js";
