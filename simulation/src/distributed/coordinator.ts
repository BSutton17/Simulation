import type { Candidate, CandidateEvaluation, EvaluationTier } from "../search/index.js";
import type { FitnessResult } from "../fitness/index.js";
import { QueueClient } from "./client.js";
import { jobsForGeneration, orderResults, type ExperimentIdentity, type ResultRecord } from "./protocol.js";

/**
 * Turns a Supabase queue into a `SearchConfig.evaluateGeneration` function.
 *
 * The coordinator is the only holder of CMA-ES state. It never evaluates
 * anything: it asks the strategy for a population, writes each candidate to the
 * queue, waits for every one to come back, restores candidate order, and hands
 * the ordered array to the search loop, which calls `tell()` exactly once.
 *
 * That is the whole design. Distribution changes WHERE a candidate is
 * evaluated and nothing else — evaluation is deterministic given
 * (parameters, tier, pool), so an ordered result set makes the distributed run
 * mathematically identical to a local one rather than merely similar.
 */

export interface CoordinatorOptions {
  client: QueueClient;
  experimentId: string;
  /** Called with each generation's progress, for the log. */
  onProgress?: (line: string) => void;
  /** How often to ask whether the generation is finished. Evaluations take
   *  minutes, so this is deliberately unhurried. */
  pollMs?: number;
  /** Give up on a generation that has not finished in this long. Prevents a
   *  permanently stuck run when every worker has vanished for good. */
  generationTimeoutMs?: number;
}

/** Progress counters, for a one-line status. */
export interface GenerationStatus {
  generation: number;
  total: number;
  complete: number;
  running: number;
  pending: number;
  failed: number;
  workers: number;
  elapsedMs: number;
}

export function formatStatus(s: GenerationStatus): string {
  const rate = s.complete > 0 ? s.elapsedMs / s.complete / 1000 : 0;
  const remaining = rate > 0 ? Math.round((rate * (s.total - s.complete)) / 60) : 0;
  return (
    `gen ${s.generation}  ${s.complete}/${s.total} done  ` +
    `${s.running} running  ${s.pending} waiting  ${s.failed} failed  ` +
    `${s.workers} workers  ~${remaining}m left`
  );
}

/**
 * The distributed evaluator.
 *
 * Returned in the shape `SearchConfig.evaluateGeneration` expects, so the
 * search loop needs no knowledge that anything is remote. The loop's own guards
 * — result count, and hash-per-index — still apply on top of the ones here,
 * which is deliberate: the checks are cheap and the failure they prevent is
 * silent.
 */
export function distributedEvaluator(options: CoordinatorOptions) {
  const { client, experimentId } = options;
  const pollMs = options.pollMs ?? 15_000;
  const timeoutMs = options.generationTimeoutMs ?? 6 * 60 * 60 * 1000;
  const log = options.onProgress ?? (() => {});

  /**
   * The generation index comes from the search loop, never from a counter here.
   *
   * This function used to own `let generation = 0` and increment it per call,
   * which is only correct in a process that starts at generation 0. A
   * coordinator restarting into generation 13 published that work as generation
   * 0, where it collided with the rows generation 0 had already written. The
   * search loop is the only thing that knows which generation it is running.
   */
  return async function evaluateGeneration(
    candidates: Candidate[],
    tier: EvaluationTier,
    current: number,
  ): Promise<CandidateEvaluation[]> {
    const started = Date.now();

    // Publishing is idempotent: the table's uniqueness constraint means a
    // coordinator that restarts mid-generation re-publishes harmlessly instead
    // of creating a second copy of the population.
    await client.publishJobs(jobsForGeneration(experimentId, current, candidates, tier));
    await client.setCurrentGeneration(experimentId, current);
    log(`published ${candidates.length} ${tier} jobs for generation ${current}`);

    let lastLogged = "";
    for (;;) {
      const progress = await client.progress(experimentId, current);
      const workers = await client.activeWorkers(experimentId);
      const line = formatStatus({
        generation: current, ...progress, workers, elapsedMs: Date.now() - started,
      });
      if (line !== lastLogged) { log(line); lastLogged = line; }

      if (progress.complete >= candidates.length) break;

      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `generation ${current} did not finish within ${Math.round(timeoutMs / 3600000)}h ` +
            `(${progress.complete}/${candidates.length} complete, ${workers} workers active). ` +
            `Jobs remain in the queue; restarting the coordinator resumes from here.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const results = await client.resultsFor(experimentId, current);
    log(`generation ${current} complete in ${Math.round((Date.now() - started) / 60000)}m`);

    // Verified, never inferred from arrival order. Throws on a missing result,
    // a duplicate from a different job, a hash that does not match the
    // candidate at that index, or anything from another generation.
    return orderResults(candidates, results, current, toEvaluation(tier));
  };
}

/** Rebuilds the evaluation the search loop expects from a stored result. */
function toEvaluation(tier: EvaluationTier) {
  return (candidate: Candidate, result: ResultRecord): CandidateEvaluation => ({
    candidate,
    tier,
    fitness: (result.fitness as FitnessResult | null) ?? null,
    failure: result.failure,
    durationMs: result.durationMs,
    cached: false,
  });
}

/**
 * Confirms the coordinator's own build matches the experiment it is resuming.
 *
 * The coordinator can drift from its experiment exactly as a worker can — a
 * rebuild between sessions is enough — and it is the one process whose drift
 * would poison every generation that follows.
 */
export async function assertCoordinatorMatches(
  client: QueueClient,
  experimentId: string,
  local: ExperimentIdentity,
): Promise<void> {
  const remote = await client.experimentIdentity(experimentId);
  const { identityMismatches } = await import("./protocol.js");
  const mismatches = identityMismatches(local, remote);
  if (mismatches.length > 0) {
    throw new Error(
      `this build does not match experiment ${experimentId}:\n  ${mismatches.join("\n  ")}\n` +
        `Refusing to coordinate a run it would not reproduce.`,
    );
  }
}
