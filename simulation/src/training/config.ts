import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { withConfig, type NeatConfig } from "../neat/index.js";
import { DEFAULT_FITNESS, type FitnessConfig } from "./fitness.js";
import { DEFAULT_SLATE, type SlateConfig } from "./slate.js";

/**
 * Training configuration — the layer that knows both NEAT and Elementals.
 */

export interface TrainingConfig {
  neat: NeatConfig;
  slate: SlateConfig;
  fitness: FitnessConfig;
  /** Seed for the whole run: population, slate sampling, match seeds. */
  seed: number;
  generations: number;
  /** Write a checkpoint every N generations (0 disables). */
  checkpointEvery: number;
  /**
   * Evaluate the champion against the FROZEN validation slate every N
   * generations (0 disables).
   *
   * The only way to tell a policy that learned Elementals from one that learned
   * its training slate. Costs one champion evaluation, not a population's.
   */
  validateEvery: number;
  /** Kingdoms the run may train on. */
  kingdoms: readonly KingdomId[];
  /**
   * Which balance configuration these matches are played under.
   *
   * "baseline" is the production data as committed. When Balance V3 lands, its
   * approved configuration is applied through the existing parameter registry
   * and named here — the trainer needs no other change, and every checkpoint
   * and model records which environment produced it.
   */
  balanceConfigId: string;
}

export function trainingConfig(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    neat: withConfig({
      populationSize: 60,
      activation: "tanh",
      // 65 sources x 22 outputs would be 1,430 genes per genome before a single
      // mutation, which makes speciation's O(pop^2) distance pass the dominant
      // cost of a generation for no benefit. A quarter of them still wires every
      // output several times over.
      initialConnectivity: 0.25,
      targetSpecies: 6,
      // The interface is 64 inputs and 22 outputs, so a brand-new genome already
      // carries ~340 genes with no hidden nodes at all. Normalizing by that
      // count divides every structural difference by the width of the problem
      // and leaves speciation blind to topology; see the field's own note.
      normalizeBySize: false,
      ...(overrides.neat ?? {}),
    }),
    slate: { ...DEFAULT_SLATE, ...(overrides.slate ?? {}) },
    fitness: { ...DEFAULT_FITNESS, ...(overrides.fitness ?? {}) },
    seed: overrides.seed ?? 20260817,
    generations: overrides.generations ?? 30,
    checkpointEvery: overrides.checkpointEvery ?? 1,
    validateEvery: overrides.validateEvery ?? 5,
    kingdoms: overrides.kingdoms ?? KINGDOM_IDS,
    balanceConfigId: overrides.balanceConfigId ?? "baseline",
  };
}

export { DEFAULT_FITNESS, DEFAULT_SLATE };
export type { FitnessConfig, SlateConfig };
