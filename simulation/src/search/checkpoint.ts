import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CmaSnapshot } from "./cmaes.js";
import type { CandidateEvaluation, EvaluationTier } from "./candidate.js";
import type { GenerationRecord } from "./run.js";
import type { BalanceSchema } from "./schema.js";

/**
 * Search checkpointing.
 *
 * A full-depth run is measured in hours, and on a hosted runner it can be
 * interrupted for reasons that have nothing to do with the search: a session
 * limit, a pre-emption, a lost connection. Without a checkpoint, every one of
 * those costs the entire run. The CMA-ES strategy state is already
 * serialisable; what was missing was anything that actually wrote it down.
 *
 * A checkpoint is written after every generation, so the most that can ever be
 * lost is one generation of work.
 *
 * Resuming is deliberately CONSERVATIVE. A checkpoint is only accepted when the
 * run it describes is the same run in every respect that could change a score —
 * same engine, same schema, same fitness rules, same seed, same tiers. Silently
 * resuming across a changed engine would splice two incomparable searches
 * together and present the result as one, which is worse than starting over.
 */

/** v2 added `stage` and put `promote` in the identity. */
export const CHECKPOINT_VERSION = "v2";

/** The identity a checkpoint must match to be resumable. */
export interface CheckpointIdentity {
  engineSha: string;
  engineDirty: boolean;
  schemaVersion: string;
  catalogHash: string;
  fitnessVersion: string;
  optimizerVersion: string;
  weightsName: string;
  seed: number;
  generations: number;
  populationSize: number | null;
  sigma: number;
  /**
   * Candidates promoted to a full evaluation each generation.
   *
   * This does NOT affect where the search goes — `cma.tell` runs on the whole
   * population's screening scores before anything is promoted, verified in
   * test/promoteTrajectory.test.ts. It is in the identity for a different
   * reason: it decides how many candidates are ever measured at full depth, so
   * changing it mid-run leaves some generations with three fully-evaluated
   * candidates and others with one. The elite is then drawn from uneven
   * coverage, and the run's own record gives no hint that happened.
   */
  promote: number;
  /** Fingerprint of the three tier configurations. */
  tiersHash: string;
}

/**
 * How far a run has actually got.
 *
 * Finishing the last generation is not finishing the run. Validation is a
 * separate stage costing 43,632 matches — one to two hours — and a session
 * killed inside it used to leave a checkpoint that was refused as "already
 * complete" on the next attempt, because completed generations were the only
 * thing being counted. The work was intact on disk and unreachable.
 */
export type CheckpointStage =
  /** Generations still to run. */
  | "search"
  /** Every generation done; validation not yet finished. Resumable. */
  | "validation"
  /** Validation finished and its results are in the checkpoint. Done. */
  | "complete";

export interface SearchCheckpoint {
  version: string;
  identity: CheckpointIdentity;
  writtenAt: string;
  /** Generations FULLY completed. The loop resumes at this index. */
  completedGenerations: number;
  /** Which stage the run reached. Only "complete" means there is nothing left. */
  stage: CheckpointStage;
  cma: CmaSnapshot;
  schema: BalanceSchema;
  generationRecords: GenerationRecord[];
  /** Full/validation evaluations kept for the final report. */
  evaluations: CandidateEvaluation[];
  /** Every cached evaluation, so a resumed run does not re-pay for scores it
   *  already has. Keyed by "hash|tier". */
  cacheEntries: { key: string; evaluation: CandidateEvaluation }[];
  bestFullKey: string | null;
  counters: {
    candidateCount: number;
    matches: number;
    screens: number;
    fulls: number;
    validations: number;
    failures: number;
    elapsedMs: number;
  };
}

export function cacheKeyOf(hash: string, tier: EvaluationTier): string {
  return `${hash}|${tier}`;
}

/**
 * Writes a checkpoint atomically.
 *
 * Via a temp file and a rename, because the interruption this exists to survive
 * can just as easily land in the middle of the write. A half-written checkpoint
 * that parses as valid JSON would be the worst possible outcome: a resume that
 * looks fine and silently continues from a truncated state.
 */
export function writeCheckpoint(path: string, checkpoint: SearchCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(checkpoint), "utf8");
  renameSync(temporary, path);
}

export interface CheckpointLoad {
  checkpoint: SearchCheckpoint | null;
  /** Why a checkpoint on disk was not used. Null when it was, or when absent. */
  rejected: string | null;
}

/**
 * Reads a checkpoint, refusing any that does not match the run being started.
 *
 * Every mismatch is reported rather than swallowed: "no checkpoint" and "a
 * checkpoint that does not apply" are very different situations for whoever is
 * watching a long run, and only one of them means work was lost.
 */
export function readCheckpoint(path: string, identity: CheckpointIdentity): CheckpointLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { checkpoint: null, rejected: null };
  }

  let parsed: SearchCheckpoint;
  try {
    parsed = JSON.parse(raw) as SearchCheckpoint;
  } catch (error) {
    return { checkpoint: null, rejected: `unreadable checkpoint: ${(error as Error).message}` };
  }
  return acceptCheckpoint(parsed, identity);
}

/**
 * Decides whether an already-loaded checkpoint applies to this run.
 *
 * Split out from `readCheckpoint` so a checkpoint restored from Supabase gets
 * exactly the same scrutiny as one read from disk. Durable storage moved where
 * the bytes live; it must not change what counts as a resumable run.
 */
export function acceptCheckpoint(
  parsed: SearchCheckpoint | null,
  identity: CheckpointIdentity,
): CheckpointLoad {
  if (!parsed) return { checkpoint: null, rejected: null };

  if (parsed.version !== CHECKPOINT_VERSION) {
    return { checkpoint: null, rejected: `checkpoint version ${parsed.version} != ${CHECKPOINT_VERSION}` };
  }

  const mismatches = identityMismatches(parsed.identity, identity);
  if (mismatches.length > 0) {
    return { checkpoint: null, rejected: `checkpoint is from a different run: ${mismatches.join(", ")}` };
  }
  // Refused only when there is genuinely nothing left to do: validation
  // finished AND no further generations have been asked for. A run whose
  // generations are done but whose validation is not is precisely the case
  // that must resume — otherwise an interrupted validation stage throws away
  // every generation behind it.
  if (parsed.stage === "complete" && parsed.completedGenerations >= identity.generations) {
    return { checkpoint: null, rejected: "run is already complete (search and validation)" };
  }
  return { checkpoint: parsed, rejected: null };
}

/** Field-by-field, so the rejection message says which thing changed. */
export function identityMismatches(a: CheckpointIdentity, b: CheckpointIdentity): string[] {
  const out: string[] = [];
  for (const key of Object.keys(b) as (keyof CheckpointIdentity)[]) {
    // A run may legitimately be resumed with MORE generations requested than the
    // checkpoint was created for; everything else must match exactly.
    if (key === "generations") continue;
    if (a[key] !== b[key]) out.push(`${key}: ${String(a[key])} -> ${String(b[key])}`);
  }
  return out;
}
