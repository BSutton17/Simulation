import { evaluate, balancedDuelPairings } from "../evaluation/index.js";
import { scoreFitness, WEIGHT_PRESETS } from "../fitness/index.js";
import { tierFor, isAllocationVersion, type EvaluationTier } from "../search/index.js";
import { QueueClient } from "./client.js";
import { backoffMs, identityMismatches, makeWorkerId, type ExperimentIdentity, type JobRecord } from "./protocol.js";

/**
 * A worker: claim a job, evaluate it, submit the result, repeat.
 *
 * Deliberately ignorant. It has no idea CMA-ES exists, how many other workers
 * there are, or which generation the search is really on — it evaluates what it
 * is handed. All the reasoning lives in the coordinator, which is what keeps
 * this loop short enough to be obviously correct.
 *
 * It runs the same production evaluation path as a local search, so a candidate
 * evaluated here and one evaluated on the coordinator's machine produce
 * identical numbers.
 */


export interface WorkerOptions {
  client: QueueClient;
  experimentId: string;
  /** Local evaluation threads. Two is what a 4-core Kaggle notebook measured
   *  fastest; the worker itself does not care. */
  workers?: number;
  leaseMinutes?: number;
  onLog?: (line: string) => void;
  /** Stop after this long, so a Kaggle session ends cleanly rather than being
   *  killed mid-evaluation. */
  budgetMs?: number;
  /** Testing seam: stop after this many jobs. */
  maxJobs?: number;
}

export interface WorkerSummary {
  workerId: string;
  completed: number;
  failed: number;
  duplicates: number;
  elapsedMs: number;
}

/** Builds the evaluation config for a tier — identical to the local search. */
function configFor(tier: EvaluationTier, parameters: Record<string, number>, id: string, workers: number, allocation: string) {
  const t = tierFor(allocation, tier);
  return {
    balanceConfigId: id,
    balance: parameters,
    // Screening and full evaluations train the search, so they use the training
    // pool; validation must stay on seeds the search has never seen.
    pool: (tier === "validation" ? "validation" : "training") as "training" | "validation",
    workers,
    duel: {
      enabled: true, seedsPerPairing: t.duelSeeds,
      pairings: t.duelPairings ? balancedDuelPairings(t.duelPairings) : undefined,
    },
    ffa4: { enabled: true, seedsPerPairing: t.ffaSeeds, compositions: t.ffa4Compositions, sampler: t.sampler },
    ffa7: { enabled: true, seedsPerPairing: t.ffaSeeds, compositions: t.ffa7Compositions, sampler: t.sampler },
  };
}

/**
 * Evaluates one job through the production path.
 *
 * A failure is a result, not a crash: it is recorded and submitted so the
 * generation can close. A worker that threw instead would hold the job until
 * its lease expired and the next worker hit the same problem.
 */
async function runJob(job: JobRecord, workers: number, allocation: string): Promise<{
  fitness: unknown | null; failure: string | null; durationMs: number; matches: number;
}> {
  const started = Date.now();
  try {
    const reading = await evaluate(
      configFor(job.tier, job.parameters, `${job.candidateId}:${job.tier}`, workers, allocation),
    );
    const fitness = scoreFitness(reading, {
      weights: WEIGHT_PRESETS.designerPriority, weightsName: "designerPriority",
    });
    return {
      fitness, failure: null, durationMs: Date.now() - started,
      matches: fitness.provenance.totalMatches,
    };
  } catch (error) {
    return {
      fitness: null, failure: (error as Error).message,
      durationMs: Date.now() - started, matches: 0,
    };
  }
}

/**
 * Verifies this build belongs to the experiment before doing any work.
 *
 * The failure this prevents is silent. A worker from an older commit produces
 * perfectly plausible numbers for a slightly different game, and the search
 * would absorb them without complaint.
 */
export async function assertWorkerMatches(
  client: QueueClient, experimentId: string, local: ExperimentIdentity,
): Promise<void> {
  const remote = await client.experimentIdentity(experimentId);
  const mismatches = identityMismatches(local, remote);
  if (mismatches.length > 0) {
    throw new Error(
      `this worker does not match experiment ${experimentId}:\n  ${mismatches.join("\n  ")}\n` +
        `Refusing to evaluate. Rebuild from the same commit as the coordinator.`,
    );
  }

  // The allocation is adopted from the experiment rather than compared against
  // a local default — but only if this build actually implements it.
  //
  // A worker that cannot resolve the split would otherwise have to guess, and a
  // wrong guess is invisible: it returns plausible scores measured on a
  // different instrument and the search absorbs them without complaint. That is
  // the hazard worth refusing over, and it is the one this catches.
  if (!isAllocationVersion(remote.allocation)) {
    throw new Error(
      `experiment ${experimentId} uses allocation "${remote.allocation}", which this ` +
        `worker's build does not implement. Refusing to evaluate: the match-budget ` +
        `split decides what a score means. Rebuild from the same commit as the coordinator.`,
    );
  }
}

export async function runWorker(options: WorkerOptions): Promise<WorkerSummary> {
  const { client, experimentId } = options;
  const workers = options.workers ?? 2;
  const leaseMinutes = options.leaseMinutes ?? 30;
  const log = options.onLog ?? (() => {});
  const started = Date.now();
  const workerId = makeWorkerId("kaggle");

  // Read once, before any job is claimed. A worker that cannot determine which
  // match-budget split the experiment uses must not guess: it would return
  // scores measured on a different instrument than its coordinator assumed.
  const allocation = (await client.experimentIdentity(experimentId)).allocation;

  await client.registerWorker(workerId, experimentId);
  log(`registered ${workerId} (${workers} local threads, allocation ${allocation})`);

  let completed = 0, failed = 0, duplicates = 0, emptyPolls = 0;

  for (;;) {
    if (options.maxJobs !== undefined && completed + failed >= options.maxJobs) break;
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs) {
      log("wall-clock budget reached, stopping between jobs");
      break;
    }

    // The generation the coordinator is currently on. A worker that asks for
    // work from a finished generation simply gets nothing and backs off.
    const identity = await client.experimentIdentity(experimentId).catch(() => null);
    if (!identity) { await sleep(backoffMs(++emptyPolls)); continue; }

    const generation = await client.currentGeneration(experimentId);
    const job = await client.claimJob(experimentId, generation, workerId, leaseMinutes);

    if (!job) {
      emptyPolls += 1;
      const wait = backoffMs(emptyPolls);
      if (emptyPolls === 1) log(`no work in generation ${generation}, waiting`);
      await sleep(wait);
      continue;
    }
    emptyPolls = 0;

    log(`claimed ${job.candidateId} (candidate ${job.candidateIndex}, ${job.tier})`);

    // Long evaluations outlive the default lease, so it is extended while the
    // job runs. Without this a healthy worker would have its job reclaimed
    // out from under it.
    const renew = setInterval(() => {
      void client.renewLease(job.id, workerId, leaseMinutes).catch(() => {});
    }, (leaseMinutes * 60 * 1000) / 3);

    let outcome;
    try {
      outcome = await runJob(job, workers, allocation);
    } finally {
      clearInterval(renew);
    }

    const accepted = await client.submitResult(job, workerId, outcome);
    if (!accepted) {
      duplicates += 1;
      log(`${job.candidateId} was already answered — discarding (lease had expired)`);
    } else if (outcome.failure) {
      failed += 1;
      log(`${job.candidateId} FAILED: ${outcome.failure.slice(0, 120)}`);
    } else {
      completed += 1;
      log(`${job.candidateId} done in ${Math.round(outcome.durationMs / 1000)}s`);
    }
  }

  return { workerId, completed, failed, duplicates, elapsedMs: Date.now() - started };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
