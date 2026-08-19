import type { Genome } from "../../neat/index.js";
import type { FitnessConfig, ScenarioResult } from "../fitness.js";
import type { SelfPlayTable } from "../selfPlay.js";
import type { SlateScenario } from "../slate.js";

/**
 * The parent↔worker contract for parallel match execution.
 *
 * Deliberately narrow: workers run MATCHES and nothing else. Speciation,
 * selection, reproduction, fitness aggregation and champion choice all stay in
 * the parent, single-threaded, in the order they already ran. A worker cannot
 * change what the run concludes because it is never asked a question whose
 * answer depends on anything but one match.
 *
 * ⚠️ ORDERING IS PART OF THE CONTRACT. Every task carries the `index` it held in
 * the parent's list, and the parent reassembles by that index before aggregating.
 * This is not tidiness — `aggregate()` sums floating-point scores, and floating-
 * point addition is not associative, so results summed in completion order would
 * differ from results summed in slate order in the last bits. Deterministic
 * equivalence is the acceptance criterion for this whole subsystem, so the index
 * travels with the work.
 */

/** Which controller drives the seat under evaluation. */
export type CandidateSpec =
  | { kind: "genome"; genome: Genome; name: string }
  | { kind: "personality"; profile: string }
  | { kind: "random"; seed: number; name: string };

/**
 * The genomes a batch of tables refers to.
 *
 * Broadcast once per generation rather than attached to every task: a table
 * names up to seven genomes and a genome carries ~370 connections, so inlining
 * them would serialise the population dozens of times per generation and spend
 * the parallelism on JSON.
 */
export interface PopulationSnapshot {
  genomes: Genome[];
  hallOfFame: Genome[];
}

export type WorkerRequest =
  | { kind: "population"; snapshot: PopulationSnapshot }
  | {
      kind: "tables";
      batchId: number;
      tasks: { index: number; table: SelfPlayTable }[];
      fitness: FitnessConfig;
    }
  | {
      kind: "scenarios";
      batchId: number;
      candidate: CandidateSpec;
      tasks: { index: number; scenario: SlateScenario }[];
      fitness: FitnessConfig;
    }
  | { kind: "stop" };

/** One seat's outcome in a self-play table. */
export interface SeatRow {
  seat: number;
  genomeIndex: number;
  result: ScenarioResult;
}

export type WorkerResponse =
  | { kind: "ready" }
  | {
      kind: "tables";
      batchId: number;
      results: { index: number; rows: SeatRow[] }[];
      failures: { index: number; error: string }[];
    }
  | {
      kind: "scenarios";
      batchId: number;
      results: { index: number; result: ScenarioResult }[];
      failures: { index: number; error: string }[];
    };
