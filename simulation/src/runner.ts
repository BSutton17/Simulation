import { withParameterSet } from "../../src/engine/parameters.js";
import { DEFAULT_MAX_TICKS, runHeadlessMatch } from "./headless.js";
import { createBaselineAI } from "./ai/baseline.js";
import { deriveSeed, normalizeSeed } from "./rng.js";
import type { MatchRecord, SimulationConfig, SimulationResult } from "./types.js";

/**
 * Simulation runner (ticket #201): executes N complete headless matches and
 * collects their records.
 *
 * Lifecycle per run:
 *   1. Normalize the master seed (strings hash to integers).
 *   2. For each match index, derive an independent match seed — so match #7
 *      replays identically whether you run 8 matches or 800,000.
 *   3. Run the match to completion through the production engine.
 *   4. Notify observers (analytics/recording hooks — later tickets).
 *
 * The loop is deliberately synchronous and allocation-light: one match is
 * pure computation, so throughput scales with CPU. Parallelism (worker
 * processes sharding the match range by index) can be layered on later
 * without touching this API, because per-match seeds are index-derived.
 */
export function runSimulation(config: SimulationConfig): SimulationResult {
  if (config.matches < 1) {
    throw new Error("SimulationConfig.matches must be >= 1");
  }
  if (config.players.length < 2 || config.players.length > 8) {
    throw new Error("SimulationConfig.players must have 2-8 seats");
  }

  const baseSeed = normalizeSeed(config.seed);
  const createAI = config.createAI ?? createBaselineAI;
  const observers = config.observers ?? [];
  const maxTicks = config.maxTicks ?? DEFAULT_MAX_TICKS;

  // FFA fairness: cyclically rotate the seat order each match so no kingdom is
  // pinned to one seat's positional advantage (turn order, targeting, RNG
  // stream). rotate(players, k) moves seat k to the front.
  const rotate = (players: typeof config.players, k: number) =>
    players.map((_, i) => players[(i + k) % players.length]!);

  const records: MatchRecord[] = [];
  let totalTicks = 0;
  const startedAt = performance.now();

  // The whole run executes under the candidate balance configuration (or the
  // production baseline when none is given). Scoped: overrides can never leak
  // past this run, and production data is never touched.
  withParameterSet(config.parameters ?? null, () => {
    for (let i = 0; i < config.matches; i++) {
      const record = runHeadlessMatch({
        players: config.rotateSeats
          ? rotate(config.players, i % config.players.length)
          : config.players,
        seed: deriveSeed(baseSeed, i),
        maxTicks,
        createAI,
        index: i,
        observers,
        telemetry: config.telemetry,
      });
      records.push(record);
      totalTicks += record.endedAtTick;
    }
  });

  const result: SimulationResult = {
    records,
    totalTicks,
    durationMs: performance.now() - startedAt,
  };
  for (const o of observers) o.onComplete?.(result);
  return result;
}
