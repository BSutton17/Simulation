import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { withParameterSet } from "../../../src/engine/parameters.js";
import type { ParameterSet } from "../../../src/engine/parameters.js";
import { ACTIVE_POPULATION, type StrategyPopulation } from "./population.js";
import { runJob, type MatchJob, type MatchOutcome } from "./jobs.js";
import type { WorkerRequest, WorkerResponse } from "./worker.js";

/**
 * Executes a plan of match jobs, serially or across a pool of worker threads.
 *
 * Parallelism here changes runtime and nothing else. Every job carries its own
 * seed, roster and strategies, and results are returned keyed by job id for the
 * caller to aggregate in plan order — so worker count, scheduling and
 * completion order are all invisible in the output.
 *
 * Worker threads rather than child processes: each thread is a separate V8
 * isolate, which gives per-worker module state (crucially, the engine's active
 * parameter set) at a fraction of a process's ~4.4s startup cost.
 */

export interface ExecuteOptions {
  balance?: ParameterSet | null;
  population?: StrategyPopulation;
  /** 1 runs in-process. Defaults to available parallelism, capped sensibly. */
  workers?: number;
  /** Jobs per message. Amortises IPC without starving workers near the end. */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
  /** Jobs already completed (resume support); their outcomes are supplied. */
  completed?: Map<string, MatchOutcome>;
  /** Called as batches complete, for checkpointing. */
  onBatch?: (outcomes: MatchOutcome[]) => void;
}

export interface ExecuteResult {
  outcomes: Map<string, MatchOutcome>;
  failures: { id: string; error: string }[];
  workers: number;
}

/**
 * Default worker count: about two thirds of reported parallelism.
 *
 * Measured on a 12-logical-core machine, throughput peaked at 8 workers
 * (3.22× serial) and *regressed* at 12 (3.00×) — `availableParallelism()`
 * counts hyperthreads, and match simulation is allocation-heavy enough that
 * sibling threads contend rather than add. Two thirds lands on the measured
 * knee here and should degrade sensibly elsewhere; re-benchmark on very
 * different hardware rather than trusting this constant.
 */
export function defaultWorkerCount(): number {
  const cores = availableParallelism();
  return Math.max(1, Math.min(Math.round(cores * 0.67), 16));
}

/** Batch size that keeps every worker busy while still amortising messaging. */
function chooseBatchSize(total: number, workers: number, override?: number): number {
  if (override && override > 0) return override;
  // Aim for several batches per worker so a slow batch cannot leave others idle.
  return Math.max(1, Math.min(64, Math.ceil(total / (workers * 8))));
}

/** Runs the plan and returns every outcome, keyed by job id. */
export async function executeJobs(
  jobs: MatchJob[],
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const population = options.population ?? ACTIVE_POPULATION;
  const balance = options.balance ?? null;
  const completed = options.completed ?? new Map<string, MatchOutcome>();
  const pending = jobs.filter((j) => !completed.has(j.id));
  const outcomes = new Map<string, MatchOutcome>(completed);
  const failures: { id: string; error: string }[] = [];

  const requested = options.workers ?? defaultWorkerCount();
  // Never spin up more workers than there is work for.
  const workers = Math.max(1, Math.min(requested, pending.length || 1));

  let done = completed.size;
  const report = () => options.onProgress?.(done, jobs.length);
  report();

  if (workers === 1 || pending.length === 0) {
    // Serial path: identical semantics, no threads. Also the reference the
    // parallel path is validated against.
    withParameterSet(balance, () => {
      for (const job of pending) {
        try {
          const outcome = runJob(job, population);
          outcomes.set(job.id, outcome);
          options.onBatch?.([outcome]);
        } catch (error) {
          failures.push({ id: job.id, error: (error as Error).message });
        }
        done += 1;
        report();
      }
    });
    return { outcomes, failures, workers: 1 };
  }

  const batchSize = chooseBatchSize(pending.length, workers, options.batchSize);
  const batches: MatchJob[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    batches.push(pending.slice(i, i + batchSize));
  }

  await new Promise<void>((resolve, reject) => {
    const pool: Worker[] = [];
    let nextBatch = 0;
    let outstanding = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const w of pool) void w.terminate();
      if (error) reject(error);
      else resolve();
    };

    const dispatch = (worker: Worker): void => {
      if (settled) return;
      if (nextBatch >= batches.length) {
        if (outstanding === 0) finish();
        return;
      }
      const batchId = nextBatch++;
      outstanding += 1;
      const request: WorkerRequest = { batchId, jobs: batches[batchId]! };
      worker.postMessage(request);
    };

    for (let i = 0; i < workers; i++) {
      const worker = new Worker(workerEntry(), {
        workerData: { balance, populationVersion: population.version },
      });
      worker.on("message", (response: WorkerResponse) => {
        for (const outcome of response.outcomes) outcomes.set(outcome.id, outcome);
        failures.push(...response.failures);
        done += response.outcomes.length + response.failures.length;
        report();
        options.onBatch?.(response.outcomes);
        outstanding -= 1;
        dispatch(worker);
      });
      // A worker that dies is an infrastructure failure, not a game result:
      // fail loudly rather than quietly returning a short evaluation.
      worker.on("error", (error: unknown) => finish(error as Error));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(new Error(`worker exited with code ${code}`));
      });
      pool.push(worker);
    }

    for (const worker of pool) dispatch(worker);
  });

  return { outcomes, failures, workers };
}

/**
 * The worker script URL.
 *
 * From TypeScript sources this is the `.mjs` bootstrap that registers the tsx
 * loader first (Node strips `--import` from a worker's execArgv, so the parent's
 * loader is not inherited). From compiled output the emitted worker is loaded
 * directly.
 */
function workerEntry(): URL {
  const here = import.meta.url;
  return here.endsWith(".ts")
    ? new URL("./worker-bootstrap.mjs", here)
    : new URL("./worker.js", here);
}
