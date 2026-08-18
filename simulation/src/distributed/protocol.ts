import type { Candidate, CandidateEvaluation, EvaluationTier } from "../search/index.js";

/**
 * The contract between the coordinator and its workers.
 *
 * Everything here is pure: no network, no database, no clock. That is
 * deliberate. Distribution has exactly one way to corrupt the science —
 * returning a score paired with the wrong candidate — and the defences against
 * it belong somewhere that can be tested without standing up Supabase.
 *
 * `cma.tell(vectors, scores)` takes the correspondence between candidate and
 * score from array position and nothing else. A permuted result set trains the
 * strategy on mismatched pairs, completes without error, and produces a run
 * that looks healthy and means nothing. So the rule throughout is: verify
 * identity, never infer it from arrival order.
 */

/** What makes two runs the same experiment. A worker built from a different
 *  commit, schema or seed must not contribute to this one. */
export interface ExperimentIdentity {
  engineSha: string;
  schemaVersion: string;
  catalogHash: string;
  seed: number;
  populationSize: number;
  sigma: number;
  scope: string;
  fitnessVersion: string;
  weightsName: string;
  /**
   * Which match-budget split produced this experiment's numbers.
   *
   * It lives on the experiment row rather than in each notebook's environment
   * because workers do the evaluating: a worker configured for a different
   * split than its coordinator would return scores measured on a different
   * instrument, and nothing downstream would notice. One source of truth, read
   * by whoever needs it.
   */
  allocation: string;
}

/** One unit of work: a single candidate at a single tier. */
export interface JobRecord {
  id: string;
  experimentId: string;
  generationNumber: number;
  candidateIndex: number;
  candidateId: string;
  candidateHash: string;
  tier: EvaluationTier;
  parameters: Record<string, number>;
}

/** What a worker sends back. */
export interface ResultRecord {
  jobId: string;
  generationNumber: number;
  candidateIndex: number;
  candidateHash: string;
  fitness: unknown | null;
  failure: string | null;
  durationMs: number;
  matches: number;
}

export class ProtocolError extends Error {}

/**
 * Whether a worker may take part in this experiment.
 *
 * Checked before evaluating rather than after, because the failure it prevents
 * is silent: an out-of-date worker produces perfectly valid-looking numbers for
 * a different game. Every field is compared and every mismatch is named, so a
 * misconfigured notebook says which field is wrong instead of "identity
 * mismatch".
 */
export function identityMismatches(
  worker: ExperimentIdentity,
  experiment: ExperimentIdentity,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(experiment) as (keyof ExperimentIdentity)[]) {
    // `allocation` is a property of the RUN, not of the build.
    //
    // Everything else here answers "is this worker the same code as the
    // coordinator?" — engine, schema, catalog, fitness version. A worker can
    // only be wrong about those by being built from a different commit.
    //
    // Allocation is chosen by the coordinator when it creates the experiment,
    // and a worker from the identical commit serves whichever one it is told.
    // Comparing it here meant a correctly-built worker was refused for not
    // having guessed a value it had no way to know. The real hazard — a worker
    // whose build does not understand the experiment's allocation at all — is
    // checked in assertWorkerMatches, where it can be checked properly.
    if (key === "allocation") continue;
    if (worker[key] !== experiment[key]) {
      out.push(`${key}: worker has ${String(worker[key])}, experiment expects ${String(experiment[key])}`);
    }
  }
  return out;
}

/** Turns a generation's candidates into jobs. Pure, so publishing is
 *  repeatable: a coordinator restart produces the identical job set, which the
 *  table's uniqueness constraint then de-duplicates. */
export function jobsForGeneration(
  experimentId: string,
  generationNumber: number,
  candidates: readonly Candidate[],
  tier: EvaluationTier,
): Omit<JobRecord, "id">[] {
  return candidates.map((candidate, index) => ({
    experimentId,
    generationNumber,
    candidateIndex: index,
    candidateId: candidate.id,
    candidateHash: candidate.hash,
    tier,
    parameters: { ...candidate.parameters },
  }));
}

/**
 * Rebuilds the generation's results in candidate order.
 *
 * This is the single most important function in the distributed layer. Results
 * arrive in whatever order workers finish, and `cma.tell` needs them in the
 * order `ask()` produced. Everything is verified rather than assumed:
 *
 *  - every candidate has a result, so tell() never sees a partial population;
 *  - no candidate has two, so a duplicate cannot displace the real answer;
 *  - each result's hash matches the candidate at its index, so a result cannot
 *    be filed against the wrong candidate;
 *  - nothing from another generation is present, so a late answer from a
 *    reclaimed job in generation N cannot leak into N+1.
 *
 * Each of those is a way the run could otherwise complete and be meaningless.
 */
export function orderResults(
  candidates: readonly Candidate[],
  results: readonly ResultRecord[],
  generationNumber: number,
  toEvaluation: (candidate: Candidate, result: ResultRecord) => CandidateEvaluation,
): CandidateEvaluation[] {
  const stale = results.filter((r) => r.generationNumber !== generationNumber);
  if (stale.length > 0) {
    throw new ProtocolError(
      `${stale.length} result(s) from another generation: ` +
        `expected ${generationNumber}, saw ${[...new Set(stale.map((r) => r.generationNumber))].join(", ")}`,
    );
  }

  const byIndex = new Map<number, ResultRecord>();
  for (const result of results) {
    const existing = byIndex.get(result.candidateIndex);
    if (existing && existing.jobId !== result.jobId) {
      throw new ProtocolError(
        `two results for candidate ${result.candidateIndex} from different jobs ` +
          `(${existing.jobId} and ${result.jobId})`,
      );
    }
    byIndex.set(result.candidateIndex, result);
  }

  const missing = candidates
    .map((_, index) => index)
    .filter((index) => !byIndex.has(index));
  if (missing.length > 0) {
    throw new ProtocolError(
      `generation ${generationNumber} is incomplete: no result for candidate(s) ${missing.join(", ")}`,
    );
  }

  return candidates.map((candidate, index) => {
    const result = byIndex.get(index)!;
    if (result.candidateHash !== candidate.hash) {
      throw new ProtocolError(
        `candidate ${index} hash mismatch: job answered ${result.candidateHash}, ` +
          `expected ${candidate.hash} (${candidate.id})`,
      );
    }
    return toEvaluation(candidate, result);
  });
}

/**
 * A worker identifier that cannot collide.
 *
 * Two Kaggle notebooks started from the same template share a hostname and
 * often a process id, and two workers sharing an id would corrupt each other's
 * lease bookkeeping. The random suffix is what actually guarantees uniqueness.
 */
export function makeWorkerId(prefix = "worker"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${random}`;
}

/**
 * How long to wait before asking for work again.
 *
 * Evaluations take minutes, so polling every second buys nothing and spends
 * the request budget. Backs off to a ceiling and returns to the floor as soon
 * as there is work.
 */
export function backoffMs(consecutiveEmptyPolls: number, floor = 5_000, ceiling = 60_000): number {
  return Math.min(ceiling, floor * 2 ** Math.min(consecutiveEmptyPolls, 10));
}
