import {
  ACTION_VERSION,
  GENOME_VERSION,
  MODEL_FORMAT_VERSION,
  OBSERVATION_VERSION,
} from "./versions.js";
import type { Difficulty } from "./difficulty.js";

/**
 * The trained-model envelope, and the refusal that protects it.
 *
 * Follows the convention the repository already settled on — a version
 * constant, an identity struct, and a comparison that refuses and NAMES the
 * field that differs (`search/checkpoint.ts:171`,
 * `evaluation/provenance.ts:142`, `distributed/protocol.ts:67`). Introducing a
 * different scheme here would mean two ways of answering the same question.
 *
 * Phase 1 defines the types and the compatibility check. There are no trained
 * models yet, and `genome` is deliberately typed loosely until Phase 2 owns
 * that shape — the point today is that a model written tomorrow already carries
 * everything needed to refuse it later.
 */

/**
 * What a model must agree with to be safe to run.
 *
 * Split from `training` below on purpose: only these fields gate loading.
 * Generation and seed are provenance you want recorded but must never refuse
 * on, the same way `comparabilityKey` excludes `createdAt`.
 */
export interface AiModelIdentity {
  /** The 64 inputs, their normalization, and the visibility rule. */
  readonly observationVersion: string;
  /** The 22 outputs and the target ordering. */
  readonly actionVersion: string;
  /** The genome/network serialization shape. */
  readonly genomeVersion: string;
  /** Commit of the engine this model was trained against. */
  readonly engineSha: string;
  /** True when that tree had uncommitted changes; loadable, but recorded. */
  readonly engineDirty: boolean;
  /**
   * Fingerprint of the candidate balance configuration in force during
   * training ("baseline" when none). Produced by
   * `evaluation/provenance.ts:hashParameterSet`.
   */
  readonly balanceConfigHash: string;
  /**
   * Fingerprint of every tunable's PRODUCTION base value, from
   * `evaluation/provenance.ts:hashBaseline`.
   *
   * Deliberately a second hash rather than a duplicate of the first. The config
   * hash catches "a different candidate was active"; this catches "somebody
   * edited src/data and never committed it", which the config hash cannot see
   * because the edit changes the base, not the overrides.
   */
  readonly balanceBaselineHash: string;
  /** A seventeenth kingdom changes what the five kit slots mean. */
  readonly kingdomCount: number;
}

/** Recorded, never refused on. */
export interface AiModelTraining {
  readonly seed: number;
  readonly generation: number;
  readonly fitnessVersion: string;
  readonly trainedAt: string;
}

export interface AiModel {
  readonly formatVersion: number;
  readonly kind: "elementals.ai.model";
  readonly difficulty: Difficulty;
  readonly identity: AiModelIdentity;
  readonly training: AiModelTraining;
  /** Typed in Phase 2, when the genome format exists. */
  readonly genome: unknown;
}

/** What this build believes it is, for the fields it can answer alone. */
export function runtimeIdentity(): Pick<
  AiModelIdentity,
  "observationVersion" | "actionVersion" | "genomeVersion"
> {
  return {
    observationVersion: OBSERVATION_VERSION,
    actionVersion: ACTION_VERSION,
    genomeVersion: GENOME_VERSION,
  };
}

/**
 * Field-by-field, so a rejection says which thing changed.
 *
 * Only the fields this build can evaluate on its own are compared here; engine
 * and balance identity are supplied by the caller, because `ai/` deliberately
 * does not import the provenance machinery (it would drag `src/engine` into a
 * module the boundary test wants clean).
 */
export function modelMismatches(model: AiModel, expected?: Partial<AiModelIdentity>): string[] {
  const out: string[] = [];
  if (model.formatVersion !== MODEL_FORMAT_VERSION) {
    out.push(`formatVersion: ${model.formatVersion} -> ${MODEL_FORMAT_VERSION}`);
  }
  const runtime = { ...runtimeIdentity(), ...expected };
  for (const key of Object.keys(runtime) as (keyof AiModelIdentity)[]) {
    const want = runtime[key];
    if (want === undefined) continue;
    if (model.identity[key] !== want) {
      out.push(`${key}: ${String(model.identity[key])} -> ${String(want)}`);
    }
  }
  return out;
}

export class ModelCompatibilityError extends Error {}

/**
 * Throws unless the model matches this build.
 *
 * Deliberately fatal rather than a warning. A model whose `observationVersion`
 * disagrees with the encoder is not a degraded model — it is a different
 * function reading the same 64 numbers, and it will play confidently and
 * wrongly with nothing anywhere raising an error.
 */
export function assertModelCompatible(
  model: AiModel,
  expected?: Partial<AiModelIdentity>,
): void {
  const mismatches = modelMismatches(model, expected);
  if (mismatches.length > 0) {
    throw new ModelCompatibilityError(
      `model is not compatible with this build: ${mismatches.join(", ")}`,
    );
  }
}
