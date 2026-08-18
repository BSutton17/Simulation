/**
 * The AI runtime.
 *
 *     Match/GameState
 *          ↓  knowledge.ts   ← the ONLY reader of engine state
 *     PlayerKnowledge          (hidden fields do not exist on the type)
 *          ↓  observation.ts
 *     Float32Array[64]
 *          ↓  network.ts      ← random today, NEAT in Phase 2
 *     Float32Array[22]
 *          ↓  legality.ts     ← hard engine legality; WAIT always legal
 *     ActionMask
 *          ↓  decode.ts
 *     Decision
 *          ↓  controller.ts   ← the ONLY writer to the match
 *     Match
 *
 * Nothing here implements NEAT. The point of building this first is that the
 * runtime does not care where its network came from, so the algorithm can
 * arrive later and plug into `Network` without any of this changing.
 */

export { createBaselineAI } from "./baseline.js";

export {
  ObservedHistory,
  knowledgeFor,
  heuristicValue,
  attackElementsOf,
  payoffStatusesOf,
  kingdomOrder,
  type EnemyKnowledge,
  type FieldKnowledge,
  type KitSlotKnowledge,
  type Known,
  type PlayerKnowledge,
  type RevealKnowledge,
  type SelfKnowledge,
} from "./knowledge.js";

export {
  FORBIDDEN_FIELDS,
  REVEALING_STATUS_IDS,
  VISIBILITY,
  visibilitySpecHash,
  type VisibilityRule,
  type VisibilityScope,
} from "./visibility.js";

export {
  KIT_BASE,
  KIT_STRIDE,
  OBSERVATION_SIZE,
  UNKNOWN,
  encode,
  observationSpecHash,
} from "./observation.js";

export {
  ACTION_SIZE,
  BUY_CITIZEN,
  BUY_SHIELD,
  CAST_BASE,
  CHARGE_FRACTION,
  INVEST_BASE,
  KIT_SLOTS,
  PRIMARY_ACTION_COUNT,
  REPAIR,
  SWITCH_GATE,
  TARGET_BASE,
  TARGET_SLOTS,
  WAIT,
  actionName,
  orderEnemies,
  primaryActionOf,
  type PrimaryAction,
} from "./actions.js";

export { createMask, legalActions, legalPrimaryCount, type ActionMask } from "./legality.js";
export { chargesToSpend, decide, type Decision } from "./decode.js";
export { DenseNetwork, randomNetwork, type Network } from "./network.js";
export {
  NetworkController,
  networkAI,
  randomNetworkAI,
  type ControllerStats,
  type NetworkControllerOptions,
} from "./controller.js";
export {
  DEFAULT_DECISION_PERIOD,
  DIFFICULTY,
  type Difficulty,
  type DifficultyConfig,
} from "./difficulty.js";
export {
  ModelCompatibilityError,
  assertModelCompatible,
  modelMismatches,
  runtimeIdentity,
  type AiModel,
  type AiModelIdentity,
  type AiModelTraining,
} from "./model.js";
export {
  ACTION_VERSION,
  GENOME_VERSION,
  MODEL_FORMAT_VERSION,
  OBSERVATION_VERSION,
} from "./versions.js";
