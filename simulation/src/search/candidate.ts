import type { ParameterSet } from "../../../src/engine/parameters.js";
import { hashSeed } from "../rng.js";
import type { FitnessResult } from "../fitness/index.js";
import { SCHEMA_VERSION, type BalanceSchema } from "./schema.js";

/**
 * Candidate balance configurations, and the cache that stops us paying for the
 * same one twice.
 *
 * A candidate is only ever a set of parameter OVERRIDES. The optimizer never
 * writes production data and never edits source: promoting a candidate into the
 * real game stays a deliberate human act.
 */

export type EvaluationTier = "screen" | "full" | "validation";

export interface Candidate {
  /** Deterministic identity: same schema and values ⇒ same hash. */
  hash: string;
  /** Readable id, e.g. "gen003-c07". */
  id: string;
  generation: number;
  index: number;
  optimizer: string;
  schemaVersion: string;
  /** Normalised search coordinates, for the optimizer's own bookkeeping. */
  vector: number[];
  /** Engine-facing overrides. */
  parameters: ParameterSet;
}

export interface CandidateEvaluation {
  candidate: Candidate;
  tier: EvaluationTier;
  fitness: FitnessResult | null;
  /** Non-null when evaluation failed outright — never silently dropped. */
  failure: string | null;
  /** Wall-clock cost of this evaluation. */
  durationMs: number;
  /** True when the result came from the cache rather than a fresh run. */
  cached: boolean;
}

/**
 * Stable hash of a candidate's parameter values.
 *
 * Values are rounded before hashing so two vectors that decode to the same
 * game are recognised as the same candidate — without that, floating-point
 * noise in the search would defeat the cache entirely.
 */
export function candidateHash(
  schema: BalanceSchema,
  parameters: ParameterSet,
): string {
  const entries = Object.entries(parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${round(v)}`);
  return hashSeed(`${schema.version}|${schema.catalogHash}|${entries.join(";")}`)
    .toString(16)
    .padStart(8, "0");
}

const round = (n: number): string => Number(n.toPrecision(9)).toString();

export function makeCandidate(options: {
  schema: BalanceSchema;
  vector: number[];
  parameters: ParameterSet;
  generation: number;
  index: number;
  optimizer: string;
}): Candidate {
  const hash = candidateHash(options.schema, options.parameters);
  return {
    hash,
    id: `gen${String(options.generation).padStart(3, "0")}-c${String(options.index).padStart(2, "0")}`,
    generation: options.generation,
    index: options.index,
    optimizer: options.optimizer,
    schemaVersion: options.schema.version ?? SCHEMA_VERSION,
    vector: [...options.vector],
    parameters: { ...options.parameters },
  };
}

/**
 * Evaluation cache.
 *
 * The key deliberately includes far more than the candidate hash: an old score
 * is only reusable if the engine, the fitness rules, the seed pool and the
 * evaluation tier all still match. Reusing a score across any of those would be
 * worse than not caching at all, because the error would be invisible.
 */
export class CandidateCache {
  private readonly entries = new Map<string, CandidateEvaluation>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly context: {
      engineSha: string;
      fitnessVersion: string;
      schemaVersion: string;
      seedPool: string;
      samplerVersions: string;
    },
  ) {}

  private key(hash: string, tier: EvaluationTier): string {
    const c = this.context;
    return [
      hash, tier, c.engineSha, c.fitnessVersion, c.schemaVersion, c.seedPool, c.samplerVersions,
    ].join("|");
  }

  get(hash: string, tier: EvaluationTier): CandidateEvaluation | undefined {
    const hit = this.entries.get(this.key(hash, tier));
    if (hit) this.hits += 1;
    else this.misses += 1;
    return hit;
  }

  set(evaluation: CandidateEvaluation): void {
    this.entries.set(
      this.key(evaluation.candidate.hash, evaluation.tier),
      evaluation,
    );
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  /** The cache's contents, for checkpointing. The key travels WITH the entry —
   *  it is the record of the context the score was earned under. */
  dump(): { key: string; evaluation: CandidateEvaluation }[] {
    return [...this.entries].map(([key, evaluation]) => ({ key, evaluation }));
  }

  /**
   * Repopulates from a checkpoint, dropping anything earned under a different
   * context.
   *
   * The stored key must equal the key this cache would compute today. Rebuilding
   * keys from the live context instead would do the exact opposite of what the
   * cache is for: a score measured on another engine would be filed under the
   * current engine's key and served as if it were current. The run-level
   * identity check should already prevent that combination from reaching here,
   * so this is a second lock on the same door — cheap, and the failure it guards
   * against is silent.
   *
   * Hit/miss counters are left alone: they describe this process's work.
   */
  load(entries: { key: string; evaluation: CandidateEvaluation }[]): number {
    let loaded = 0;
    for (const { key, evaluation } of entries) {
      if (key !== this.key(evaluation.candidate.hash, evaluation.tier)) continue;
      this.entries.set(key, evaluation);
      loaded += 1;
    }
    return loaded;
  }
}
