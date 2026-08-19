import { parentPort } from "node:worker_threads";
import { buildNetwork, type Genome } from "../../neat/index.js";
import { randomNetwork } from "../../ai/index.js";
import { mulberry32 } from "../../rng.js";
import {
  networkCandidate,
  personalityCandidate,
  playScenario,
  type Candidate,
} from "../matchEvaluator.js";
import { playTable } from "../selfPlay.js";
import type { CandidateSpec, PopulationSnapshot, WorkerRequest, WorkerResponse } from "./protocol.js";

/**
 * A match worker.
 *
 * Its own V8 isolate, so the engine's module-level state is private to it —
 * the same property that makes the balance search's workers safe. This one is
 * separate from that pool deliberately: `evaluation/worker.ts` is wired to the
 * balance search's job and population types, and adapting it would mean editing
 * CMA-ES infrastructure to serve NEAT. A second, additive worker costs one file
 * and leaves that system untouched.
 *
 * Runs no balance overrides at all. Training plays the production configuration
 * (`balanceConfigId: "baseline"`), so there is nothing to apply and nothing to
 * scope — and if that ever changes, it must arrive here explicitly rather than
 * be inherited, because inheritance across isolates is exactly the bug the
 * other pool's design note warns about.
 */

let population: PopulationSnapshot = { genomes: [], hallOfFame: [] };

/** Mirrors the parent's index convention: negative indexes the Hall of Fame. */
function resolve(index: number): Genome {
  const genome =
    index >= 0 ? population.genomes[index] : population.hallOfFame[-(index + 1)];
  if (genome === undefined) {
    throw new Error(
      `worker has no genome at index ${index} ` +
        `(population ${population.genomes.length}, hall ${population.hallOfFame.length})`,
    );
  }
  return genome;
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

parentPort!.on("message", (request: WorkerRequest) => {
  if (request.kind === "stop") {
    parentPort!.close();
    return;
  }

  if (request.kind === "population") {
    population = request.snapshot;
    return;
  }

  if (request.kind === "tables") {
    const results: { index: number; rows: ReturnType<typeof playTable> }[] = [];
    const failures: { index: number; error: string }[] = [];
    for (const task of request.tasks) {
      try {
        results.push({ index: task.index, rows: playTable(task.table, resolve, request.fitness) });
      } catch (error) {
        // Never dropped. A crashed match is an infrastructure failure and the
        // parent decides what to do; silently returning fewer results would
        // change a genome's fitness without anyone noticing.
        failures.push({ index: task.index, error: (error as Error).message });
      }
    }
    const response: WorkerResponse = { kind: "tables", batchId: request.batchId, results, failures };
    parentPort!.postMessage(response);
    return;
  }

  const results: { index: number; result: ReturnType<typeof playScenario> }[] = [];
  const failures: { index: number; error: string }[] = [];
  // One candidate per batch, so its network is compiled once rather than per
  // scenario — and, for a heuristic, so its profile is looked up once.
  const candidate = candidateFor(request.candidate);
  for (const task of request.tasks) {
    try {
      results.push({ index: task.index, result: playScenario(candidate, task.scenario, request.fitness) });
    } catch (error) {
      failures.push({ index: task.index, error: (error as Error).message });
    }
  }
  const response: WorkerResponse = {
    kind: "scenarios",
    batchId: request.batchId,
    results,
    failures,
  };
  parentPort!.postMessage(response);
});

const ready: WorkerResponse = { kind: "ready" };
parentPort!.postMessage(ready);
