/**
 * NEAT — NeuroEvolution of Augmenting Topologies.
 *
 * A generic implementation. It knows about genomes, innovation numbers,
 * species and networks, and NOTHING about Elementals: no PlayerState, no
 * kingdoms, no match, no engine import of any kind. That is enforced by
 * `test/neatBoundary.test.ts`, and it is what makes the XOR benchmark possible
 * — an algorithm that could only be exercised through the game would have to be
 * debugged through eight-hour training runs.
 *
 * `training/` is the only layer permitted to know both this and the game.
 */

export { NeatRng } from "./rng.js";
export { activate, type ActivationName, type ConnectionGene, type NodeGene, type NodeType } from "./gene.js";
export {
  addConnection,
  addNode,
  biasNodeId,
  cloneGenome,
  createGenome,
  enabledConnections,
  findNode,
  firstHiddenId,
  genomeSize,
  hasConnection,
  inputNodeId,
  outputNodeId,
  validateGenome,
  type Genome,
  type GenomeShape,
} from "./genome.js";
export { InnovationRegistry, type InnovationState } from "./innovation.js";
export {
  DEFAULT_CONFIG,
  NEAT_CONFIG_VERSION,
  configHash,
  withConfig,
  type NeatConfig,
} from "./config.js";
export {
  connectInitial,
  createsCycle,
  mutate,
  mutateAddConnection,
  mutateAddNode,
  mutateReenable,
  mutateToggleEnable,
  mutateWeights,
} from "./mutation.js";
export { clone, crossover, type CrossoverResult } from "./crossover.js";
export { compatibility, compatibilityDistance, type DistanceBreakdown } from "./distance.js";
export {
  allocateOffspring,
  cullStagnant,
  shareFitness,
  speciate,
  toState,
  updateStagnation,
  type Species,
  type SpeciesState,
} from "./species.js";
export { reproduce } from "./reproduction.js";
export { GenomeNetwork, buildNetwork, type ActivationNetwork } from "./networkBuilder.js";
export {
  Population,
  type GenerationReport,
  type PopulationSnapshot,
} from "./population.js";
export { XOR_CONFIG, evaluateXor, runXor, type XorResult } from "./xor.js";
