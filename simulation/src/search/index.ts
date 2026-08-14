/**
 * Balance search — the first stage allowed to change game parameters.
 *
 * It proposes candidate configurations as parameter OVERRIDES, never by editing
 * production data or source. Fitness rules, thresholds, format weights and the
 * validation seed pool are inputs, never search dimensions: the optimizer may
 * change the game, but it may not change what counts as balanced.
 */
export {
  buildSchema,
  searchable,
  encode,
  decode,
  coerce,
  boundsFor,
  baseVector,
  vectorToParameters,
  describeSchema,
  SCHEMA_VERSION,
  type BalanceSchema,
  type SchemaParameter,
  type ParameterType,
} from "./schema.js";

export {
  Cmaes,
  jacobiEigen,
  type CmaOptions,
  type CmaState,
  type CmaSnapshot,
} from "./cmaes.js";

export {
  CandidateCache,
  candidateHash,
  makeCandidate,
  type Candidate,
  type CandidateEvaluation,
  type EvaluationTier,
} from "./candidate.js";

export {
  runSearch,
  fitnessOf,
  OPTIMIZER_VERSION,
  SCREEN_TIER,
  FULL_TIER,
  VALIDATION_TIER,
  type SearchConfig,
  type SearchResult,
  type GenerationRecord,
  type TierConfig,
  type ProgressEvent,
} from "./run.js";

export {
  readCheckpoint,
  writeCheckpoint,
  identityMismatches,
  cacheKeyOf,
  CHECKPOINT_VERSION,
  type SearchCheckpoint,
  type CheckpointStage,
  type CheckpointIdentity,
  type CheckpointLoad,
} from "./checkpoint.js";
