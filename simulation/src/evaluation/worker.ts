import { parentPort, workerData } from "node:worker_threads";
import { withParameterSet } from "../../../src/engine/parameters.js";
import type { ParameterSet } from "../../../src/engine/parameters.js";
import { ACTIVE_POPULATION } from "./population.js";
import { runJob, type MatchJob, type MatchOutcome } from "./jobs.js";

/**
 * Evaluation worker.
 *
 * Each worker is its own V8 isolate, so the engine's module-level state — the
 * active parameter set above all — is private to it. That is the property that
 * makes parallel candidate evaluation safe: one worker's balance overrides
 * cannot reach another's matches, which a shared-memory design could not
 * guarantee.
 *
 * The balance configuration arrives explicitly in `workerData` and is applied
 * around every batch; nothing is inherited from the parent.
 */

interface WorkerInit {
  balance: ParameterSet | null;
  populationVersion: string;
}

/** A batch of jobs to run, so per-message overhead stays negligible. */
export interface WorkerRequest {
  batchId: number;
  jobs: MatchJob[];
}

export interface WorkerResponse {
  batchId: number;
  outcomes: MatchOutcome[];
  /** Jobs that threw. Never silently dropped — the evaluator decides. */
  failures: { id: string; error: string }[];
}

const init = workerData as WorkerInit;

if (init.populationVersion !== ACTIVE_POPULATION.version) {
  throw new Error(
    `worker population ${ACTIVE_POPULATION.version} does not match requested ${init.populationVersion}`,
  );
}

parentPort!.on("message", (request: WorkerRequest) => {
  const outcomes: MatchOutcome[] = [];
  const failures: { id: string; error: string }[] = [];

  withParameterSet(init.balance, () => {
    for (const job of request.jobs) {
      try {
        outcomes.push(runJob(job, ACTIVE_POPULATION));
      } catch (error) {
        // A crashed match is an infrastructure failure, distinct from a match
        // that legitimately reached its tick cap. Report it; do not drop it.
        failures.push({ id: job.id, error: (error as Error).message });
      }
    }
  });

  const response: WorkerResponse = { batchId: request.batchId, outcomes, failures };
  parentPort!.postMessage(response);
});
