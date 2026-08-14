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

export const CHECKPOINT_VERSION = "v1";

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
  /** Fingerprint of the three tier configurations. */
  tiersHash: string;
}

export interface SearchCheckpoint {
  version: string;
  identity: CheckpointIdentity;
  writtenAt: string;
  /** Generations FULLY completed. The loop resumes at this index. */
  completedGenerations: number;
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

  if (parsed.version !== CHECKPOINT_VERSION) {
    return { checkpoint: null, rejected: `checkpoint version ${parsed.version} != ${CHECKPOINT_VERSION}` };
  }

  const mismatches = identityMismatches(parsed.identity, identity);
  if (mismatches.length > 0) {
    return { checkpoint: null, rejected: `checkpoint is from a different run: ${mismatches.join(", ")}` };
  }
  if (parsed.completedGenerations >= identity.generations) {
    return { checkpoint: null, rejected: "checkpoint is already complete" };
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
