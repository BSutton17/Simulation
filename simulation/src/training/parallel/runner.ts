import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { buildNetwork, type Genome } from "../../neat/index.js";
import { randomNetwork } from "../../ai/index.js";
import { mulberry32 } from "../../rng.js";
import {
  networkCandidate,
  personalityCandidate,
  playScenario,
  type Candidate,
} from "../matchEvaluator.js";
import { playTable, type SelfPlayTable } from "../selfPlay.js";
import { aggregate, type FitnessConfig, type ScenarioResult, type TrainingResult } from "../fitness.js";
import type { Slate } from "../slate.js";
import type {
  CandidateSpec,
  SeatRow,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

/**
 * Match execution, serial or parallel, behind one interface.
 *
 * Measured on the 50-generation run: simulating matches was ~100% of the cost
 * (100ms per match, 84 matches, a 9-second training generation), and it ran on
 * one core of twelve. This is the only lever left of any size.
 *
 * ⚠️ THE ACCEPTANCE CRITERION IS DETERMINISTIC EQUIVALENCE, not throughput. A
 * faster run that answers a different question is worthless here, so three
 * properties are load-bearing and each is pinned by a test:
 *
 *   1. Matches are INDEPENDENT. One match is a pure function of its seed, its
 *      seats and its tick cap. Nothing crosses between them, so who runs a match
 *      cannot affect its outcome.
 *   2. ORDER IS RESTORED before aggregation. Every task carries its parent-side
 *      index and results are sorted back into it. `aggregate()` sums floats, and
 *      floating-point addition is not associative — summing in completion order
 *      would drift in the low bits and the equivalence claim would be false.
 *   3. `workers <= 1` takes the SERIAL path, which is the code that ran before
 *      this file existed. The old behaviour is therefore reachable exactly, not
 *      merely reproduced.
 */

export interface MatchRunner {
  /** Broadcast the genomes that table tasks will refer to by index. */
  setPopulation(genomes: readonly Genome[], hallOfFame: readonly Genome[]): Promise<void>;
  /** Plays tables, returning each one's seat rows IN THE ORDER GIVEN. */
  playTables(tables: readonly SelfPlayTable[], fitness: FitnessConfig): Promise<SeatRow[][]>;
  /** Scores one candidate over a whole slate, in slate order. */
  evaluate(spec: CandidateSpec, slate: Slate, fitness: FitnessConfig): Promise<TrainingResult>;
  close(): Promise<void>;
  readonly workers: number;
}

function candidateFor(spec: CandidateSpec): Candidate {
  switch (spec.kind) {
    case "genome":
      return networkCandidate(buildNetwork(spec.genome), spec.name);
    case "personality":
      return personalityCandidate(spec.profile);
    case "random":
      return networkCandidate(randomNetwork(mulberry32(spec.seed)), spec.name);
  }
}

/**
 * In-process execution — the path that ran before this subsystem existed.
 *
 * Kept as a first-class implementation rather than a fallback, because it is the
 * reference the parallel path is checked against.
 */
class SerialRunner implements MatchRunner {
  readonly workers = 1;
  private genomes: readonly Genome[] = [];
  private hall: readonly Genome[] = [];

  async setPopulation(genomes: readonly Genome[], hallOfFame: readonly Genome[]): Promise<void> {
    this.genomes = genomes;
    this.hall = hallOfFame;
  }

  async playTables(tables: readonly SelfPlayTable[], fitness: FitnessConfig): Promise<SeatRow[][]> {
    const resolve = (index: number): Genome =>
      index >= 0 ? this.genomes[index]! : this.hall[-(index + 1)]!;
    return tables.map((table) => playTable(table, resolve, fitness));
  }

  async evaluate(spec: CandidateSpec, slate: Slate, fitness: FitnessConfig): Promise<TrainingResult> {
    const candidate = candidateFor(spec);
    return aggregate(slate.scenarios.map((scenario) => playScenario(candidate, scenario, fitness)));
  }

  async close(): Promise<void> {}
}

/**
 * Default worker count: about two thirds of reported parallelism.
 *
 * Not a guess — the balance pool measured this machine and recorded that
 * throughput peaked at 8 workers (3.22x serial) and REGRESSED at 12, because
 * `availableParallelism()` counts hyperthreads and match simulation is
 * allocation-heavy enough that siblings contend rather than add. The same
 * workload runs here, so the same knee applies. Re-benchmark on very different
 * hardware rather than trusting the constant.
 */
export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(Math.round(availableParallelism() * 0.67), 16));
}

function workerEntry(): URL {
  const here = import.meta.url;
  return here.endsWith(".ts")
    ? new URL("./worker-bootstrap.mjs", here)
    : new URL("./worker.js", here);
}

class WorkerPoolRunner implements MatchRunner {
  private readonly pool: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  private readonly pending = new Map<number, (response: WorkerResponse) => void>();
  private nextBatch = 0;
  private startup: Promise<void>;

  constructor(readonly workers: number) {
    const readies: Promise<void>[] = [];
    for (let i = 0; i < workers; i++) {
      const worker = new Worker(workerEntry());
      this.pool.push(worker);
      readies.push(
        new Promise<void>((resolveReady, rejectReady) => {
          const onMessage = (response: WorkerResponse): void => {
            if (response.kind === "ready") {
              this.idle.push(worker);
              resolveReady();
              return;
            }
            const settle = this.pending.get(response.batchId);
            this.pending.delete(response.batchId);
            this.release(worker);
            settle?.(response);
          };
          worker.on("message", onMessage);
          worker.on("error", rejectReady);
        }),
      );
    }
    this.startup = Promise.all(readies).then(() => undefined);
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  private acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise<Worker>((resolveWorker) => this.waiting.push(resolveWorker));
  }

  private async send(request: Extract<WorkerRequest, { batchId: number }>): Promise<WorkerResponse> {
    const worker = await this.acquire();
    return new Promise<WorkerResponse>((settle) => {
      this.pending.set(request.batchId, settle);
      worker.postMessage(request);
    });
  }

  async setPopulation(genomes: readonly Genome[], hallOfFame: readonly Genome[]): Promise<void> {
    await this.startup;
    // Every worker must hold the same snapshot before any table referring to it
    // is dispatched, so this is a broadcast rather than a queued task.
    const request: WorkerRequest = {
      kind: "population",
      snapshot: { genomes: [...genomes], hallOfFame: [...hallOfFame] },
    };
    for (const worker of this.pool) worker.postMessage(request);
  }

  async playTables(tables: readonly SelfPlayTable[], fitness: FitnessConfig): Promise<SeatRow[][]> {
    await this.startup;
    const batches = chunk(
      tables.map((table, index) => ({ index, table })),
      this.workers,
    );
    const out: SeatRow[][] = new Array(tables.length);
    const failures: { index: number; error: string }[] = [];

    await Promise.all(
      batches.map(async (tasks) => {
        const response = await this.send({
          kind: "tables",
          batchId: this.nextBatch++,
          tasks,
          fitness,
        });
        if (response.kind !== "tables") throw new Error("worker answered the wrong question");
        // Placed BY INDEX, never appended: see the ordering note at the top.
        for (const { index, rows } of response.results) out[index] = rows;
        failures.push(...response.failures);
      }),
    );

    if (failures.length > 0) throw new Error(describe("table", failures));
    return out;
  }

  async evaluate(spec: CandidateSpec, slate: Slate, fitness: FitnessConfig): Promise<TrainingResult> {
    await this.startup;
    const batches = chunk(
      slate.scenarios.map((scenario, index) => ({ index, scenario })),
      this.workers,
    );
    const out: ScenarioResult[] = new Array(slate.scenarios.length);
    const failures: { index: number; error: string }[] = [];

    await Promise.all(
      batches.map(async (tasks) => {
        const response = await this.send({
          kind: "scenarios",
          batchId: this.nextBatch++,
          candidate: spec,
          tasks,
          fitness,
        });
        if (response.kind !== "scenarios") throw new Error("worker answered the wrong question");
        for (const { index, result } of response.results) out[index] = result;
        failures.push(...response.failures);
      }),
    );

    if (failures.length > 0) throw new Error(describe("scenario", failures));
    // `out` is in slate order, so the sum below adds the same numbers in the
    // same sequence the serial path does.
    return aggregate(out);
  }

  async close(): Promise<void> {
    await Promise.all(this.pool.map((worker) => worker.terminate()));
  }
}

function describe(kind: string, failures: { index: number; error: string }[]): string {
  const shown = failures.slice(0, 3).map((f) => `${kind} ${f.index}: ${f.error}`);
  return `${failures.length} ${kind} task(s) failed — ${shown.join("; ")}`;
}

/**
 * Splits work into one batch per worker, round-robin.
 *
 * Round-robin rather than contiguous slices because match cost varies a lot —
 * a match that reaches the tick cap runs several times longer than one that
 * ends early — and contiguous slices would hand one worker a run of long
 * matches while others idle.
 */
function chunk<T>(tasks: T[], workers: number): T[][] {
  const batches: T[][] = Array.from({ length: Math.min(workers, Math.max(1, tasks.length)) }, () => []);
  tasks.forEach((task, i) => batches[i % batches.length]!.push(task));
  return batches.filter((batch) => batch.length > 0);
}

/** One or fewer workers means the serial path — the pre-existing code. */
export function createRunner(workers: number): MatchRunner {
  return workers <= 1 ? new SerialRunner() : new WorkerPoolRunner(workers);
}
