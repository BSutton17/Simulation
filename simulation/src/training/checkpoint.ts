import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { captureProvenance } from "../evaluation/provenance.js";
import {
  ACTION_VERSION,
  GENOME_VERSION,
  OBSERVATION_VERSION,
  observationSpecHash,
} from "../ai/index.js";
import { NEAT_CONFIG_VERSION, configHash, type PopulationSnapshot } from "../neat/index.js";
import type { TrainingConfig } from "./config.js";
import { AI_FITNESS_VERSION } from "./fitness.js";
import { SLATE_VERSION, slateShapeHash } from "./slate.js";
import type { Genome } from "../neat/index.js";
import type { GenerationRecord } from "./trainer.js";

/**
 * Training checkpoints.
 *
 * Follows the convention already settled in `search/checkpoint.ts`: a version
 * constant, an identity struct, and a load that REFUSES and names the field
 * that differs. Resuming across a changed observation schema would be worse
 * than starting over — the population's weights are tuned to input indices that
 * no longer mean the same thing, and nothing anywhere would raise an error.
 */

export const TRAINING_CHECKPOINT_VERSION = "v1";

export interface TrainingIdentity {
  /** The 64 inputs and the visibility rule that gates them. */
  observationVersion: string;
  observationHash: string;
  /** The 22 outputs and the target ordering. */
  actionVersion: string;
  genomeVersion: string;
  neatConfigVersion: string;
  fitnessVersion: string;
  /** Fingerprint of every NEAT rate and coefficient. */
  neatConfigHash: string;
  engineSha: string;
  engineDirty: boolean;
  /** Fingerprint of the production tunables — catches an uncommitted edit. */
  balanceBaselineHash: string;
  /** Fingerprint of any candidate configuration in force ("baseline" if none). */
  balanceConfigHash: string;
  seed: number;
  populationSize: number;
  /**
   * The slate's SHAPE — formats, kingdoms, opponents, seats, tick cap.
   *
   * A genome's fitness only means something next to the matches that produced
   * it, so resuming under a redesigned slate would splice two incomparable
   * searches together and present the result as one. Pinned as the shape rather
   * than the built slate, because the design deliberately rotates matchups every
   * generation and a resume must not be refused for doing what it was told.
   */
  slateVersion: string;
  slateShapeHash: string;
  /** Which balance configuration the environment was running. */
  balanceConfigId: string;
}

export interface TrainingCheckpoint {
  version: string;
  identity: TrainingIdentity;
  writtenAt: string;
  completedGenerations: number;
  population: PopulationSnapshot;
  history: GenerationRecord[];
  /**
   * The best genome seen so far, and when.
   *
   * Carried because the champion is run state, not population state. `tell()`
   * replaces the population every generation, so a champion found in generation
   * 0 no longer exists in the population by generation 4 — a resume that
   * restored only the population would silently forget it and go on to save a
   * worse model. Found by the resume-equivalence test, which compared champion
   * identity rather than merely fitness.
   */
  champion: Genome | null;
  championGeneration: number | null;
}

/** What this build believes it is. */
export function localIdentity(config: TrainingConfig): TrainingIdentity {
  const provenance = captureProvenance({
    balanceConfigId: "neat-training",
    strategyPopulationVersion: "v1",
  });
  return {
    observationVersion: OBSERVATION_VERSION,
    observationHash: observationSpecHash(),
    actionVersion: ACTION_VERSION,
    genomeVersion: GENOME_VERSION,
    neatConfigVersion: NEAT_CONFIG_VERSION,
    fitnessVersion: AI_FITNESS_VERSION,
    neatConfigHash: configHash(config.neat),
    engineSha: provenance.engineSha,
    engineDirty: provenance.engineDirty,
    balanceBaselineHash: provenance.balanceBaselineHash,
    balanceConfigHash: provenance.balanceConfigHash,
    seed: config.seed,
    populationSize: config.neat.populationSize,
    slateVersion: SLATE_VERSION,
    slateShapeHash: slateShapeHash(
      config.slate,
      config.kingdoms,
      config.seed,
      config.balanceConfigId,
    ),
    balanceConfigId: config.balanceConfigId,
  };
}

/** Field-by-field, so a rejection says which thing changed. */
export function identityMismatches(a: TrainingIdentity, b: TrainingIdentity): string[] {
  const out: string[] = [];
  for (const key of Object.keys(b) as (keyof TrainingIdentity)[]) {
    // A dirty tree is recorded but never blocks a resume: it changes nothing
    // about whether the population is still meaningful.
    if (key === "engineDirty") continue;
    if (a[key] !== b[key]) out.push(`${key}: ${String(a[key])} -> ${String(b[key])}`);
  }
  return out;
}

/** Atomic write — an interruption mid-write must not leave valid-parsing JSON. */
export function writeCheckpoint(path: string, checkpoint: TrainingCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(checkpoint), "utf8");
  renameSync(temporary, path);
}

export interface CheckpointLoad {
  checkpoint: TrainingCheckpoint | null;
  /** Why one on disk was not used. Null when it was, or when absent. */
  rejected: string | null;
}

/**
 * Reads a checkpoint, refusing any that does not describe this run.
 *
 * "No checkpoint" and "a checkpoint that does not apply" are very different
 * situations for whoever is watching a long run, and only one of them means
 * work was lost — so the reason is always reported rather than swallowed.
 */
export function readCheckpoint(path: string, identity: TrainingIdentity): CheckpointLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { checkpoint: null, rejected: null };
  }

  let parsed: TrainingCheckpoint;
  try {
    parsed = JSON.parse(raw) as TrainingCheckpoint;
  } catch (error) {
    return { checkpoint: null, rejected: `unreadable checkpoint: ${(error as Error).message}` };
  }

  if (parsed.version !== TRAINING_CHECKPOINT_VERSION) {
    return {
      checkpoint: null,
      rejected: `checkpoint version ${parsed.version} != ${TRAINING_CHECKPOINT_VERSION}`,
    };
  }
  const mismatches = identityMismatches(parsed.identity, identity);
  if (mismatches.length > 0) {
    return {
      checkpoint: null,
      rejected: `checkpoint is from a different run: ${mismatches.join(", ")}`,
    };
  }
  return { checkpoint: parsed, rejected: null };
}
