import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { withConfig, type NeatConfig } from "../neat/index.js";

/**
 * Training configuration — the layer that knows both NEAT and Elementals.
 *
 * `AI_FITNESS_VERSION` is bumped whenever the scoring rules change. It is part
 * of the checkpoint identity and of every saved model, because a fitness number
 * only means something next to the rules that produced it.
 */
export const AI_FITNESS_VERSION = "v1";

/** How a genome's match slate is built. */
export interface SlateConfig {
  /** Kingdoms the genome plays each generation. */
  kingdomsPerGenome: number;
  /** Heuristic profiles it faces. */
  opponents: string[];
  /** Seats in a match (2 = duel). */
  seats: number;
  /** Play each pairing from more than one seat position. */
  seatRotations: number;
  maxTicks: number;
}

export interface FitnessConfig {
  /** Weight on normalized placement (1 = won, 0 = eliminated first). */
  placementWeight: number;
  /** Extra credit for an outright win, on top of placement. */
  winBonus: number;
  /** Weight on the tiebreak (surviving HP on wins, survival time on losses). */
  marginWeight: number;
  /**
   * Ceiling applied to a match that hit the tick cap.
   *
   * Without it, turtling is a winning strategy: placement ranks timeout
   * survivors by remaining HP, so a genome that buys shields and never attacks
   * can place first in a timed-out free-for-all having accomplished nothing.
   */
  timeoutCap: number;
  /** A match in which the genome never cast anything scores this. */
  inactivityScore: number;
}

export interface TrainingConfig {
  neat: NeatConfig;
  slate: SlateConfig;
  fitness: FitnessConfig;
  /** Seed for the whole run: population, slate sampling, match seeds. */
  seed: number;
  generations: number;
  /** Write a checkpoint every N generations (0 disables). */
  checkpointEvery: number;
  /** Kingdoms the run is allowed to train on. */
  kingdoms: readonly KingdomId[];
}

export const DEFAULT_SLATE: SlateConfig = {
  kingdomsPerGenome: 4,
  // A fixed, versioned opponent slate rather than self-play. Pure self-play
  // against a moving population invites cyclic dominance, and the measured
  // 89.6% duel win rate of the economic profile means it would very likely
  // converge on one degenerate meta.
  opponents: ["balanced", "economic", "aggressive"],
  seats: 2,
  seatRotations: 2,
  maxTicks: 12_000,
};

export const DEFAULT_FITNESS: FitnessConfig = {
  placementWeight: 1,
  winBonus: 0.5,
  marginWeight: 0.1,
  timeoutCap: 0.25,
  inactivityScore: 0,
};

export function trainingConfig(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    neat: withConfig({
      populationSize: 60,
      activation: "tanh",
      // 65 sources × 22 outputs would be 1,430 genes per genome before a single
      // mutation, which makes speciation's O(pop²) distance pass the dominant
      // cost of a generation for no benefit. A quarter of them still wires every
      // output several times over.
      initialConnectivity: 0.25,
      targetSpecies: 6,
      ...(overrides.neat ?? {}),
    }),
    slate: { ...DEFAULT_SLATE, ...(overrides.slate ?? {}) },
    fitness: { ...DEFAULT_FITNESS, ...(overrides.fitness ?? {}) },
    seed: overrides.seed ?? 20260817,
    generations: overrides.generations ?? 30,
    checkpointEvery: overrides.checkpointEvery ?? 1,
    kingdoms: overrides.kingdoms ?? KINGDOM_IDS,
  };
}
