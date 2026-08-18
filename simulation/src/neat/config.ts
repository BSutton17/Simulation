import type { ActivationName } from "./gene.js";

/**
 * Everything tunable about the search, in one place.
 *
 * Bump `NEAT_CONFIG_VERSION` when a field changes meaning: it is part of the
 * checkpoint identity, and resuming a run under different rates would splice
 * two different searches together and present the result as one.
 */
export const NEAT_CONFIG_VERSION = "v1";

export interface NeatConfig {
  populationSize: number;

  /** Compatibility distance coefficients (δ = c1·E/N + c2·D/N + c3·W̄). */
  excessCoefficient: number;
  disjointCoefficient: number;
  weightCoefficient: number;
  compatibilityThreshold: number;
  /**
   * Genomes smaller than this are not normalized by size. Standard NEAT sets
   * N = 1 for small genomes; dividing a two-gene difference by a gene count of
   * three makes every small genome look identical to every other.
   */
  smallGenomeSize: number;
  /**
   * Nudge the threshold each generation to steer toward `targetSpecies`.
   * 0 disables it and the threshold stays fixed.
   */
  compatibilityAdjust: number;
  targetSpecies: number;

  /** Probability a genome's weights are perturbed at all. */
  weightMutationRate: number;
  /** Within a weight mutation, chance each gene is nudged rather than replaced. */
  weightPerturbChance: number;
  weightPerturbPower: number;
  weightResetRange: number;
  weightCap: number;

  addConnectionRate: number;
  addNodeRate: number;
  toggleEnableRate: number;
  reenableRate: number;

  /** Allow connections that would create a cycle. Phase 1 reserved the genome
   *  format for recurrence; the mutation stays off until benchmarking asks. */
  allowRecurrent: boolean;
  /** Attempts before giving up on finding a legal new connection. */
  addConnectionTries: number;

  crossoverRate: number;
  /** Chance a gene disabled in either parent stays disabled in the child. */
  inheritDisabledChance: number;

  /** Top fraction of a species eligible to reproduce. */
  survivalThreshold: number;
  /** Copy the best genome of a species this many times, unmutated. */
  elitism: number;
  /** A species must have at least this many members to get an elite. */
  elitismMinSize: number;
  /** Generations without improvement before a species is culled. */
  stagnationLimit: number;
  /** Never cull below this many species, however stagnant. */
  minSpecies: number;
  tournamentSize: number;

  activation: ActivationName;
  /** "full", or a density in (0,1] for a sparse initial genome. */
  initialConnectivity: "full" | number;
}

export const DEFAULT_CONFIG: NeatConfig = {
  populationSize: 150,

  excessCoefficient: 1,
  disjointCoefficient: 1,
  weightCoefficient: 0.4,
  compatibilityThreshold: 3,
  smallGenomeSize: 20,
  compatibilityAdjust: 0.3,
  targetSpecies: 10,

  weightMutationRate: 0.8,
  weightPerturbChance: 0.9,
  weightPerturbPower: 0.5,
  weightResetRange: 2,
  weightCap: 8,

  addConnectionRate: 0.05,
  addNodeRate: 0.03,
  toggleEnableRate: 0.01,
  reenableRate: 0.05,

  allowRecurrent: false,
  addConnectionTries: 20,

  crossoverRate: 0.75,
  inheritDisabledChance: 0.75,

  survivalThreshold: 0.2,
  elitism: 1,
  elitismMinSize: 5,
  stagnationLimit: 15,
  minSpecies: 2,
  tournamentSize: 3,

  activation: "sigmoid",
  initialConnectivity: "full",
};

export function withConfig(overrides: Partial<NeatConfig> = {}): NeatConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Fingerprint of the config, for checkpoint identity. */
export function configHash(config: NeatConfig): string {
  const text = Object.keys(config)
    .sort()
    .map((k) => `${k}=${String((config as unknown as Record<string, unknown>)[k])}`)
    .join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
