import type { ParameterSet } from "../../../src/engine/parameters.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import {
  POPULATION_V1,
  orderedPairings,
  type StrategyPopulation,
} from "./population.js";
import type { SeedPoolName } from "./seeds.js";
import { captureProvenance, type Provenance } from "./provenance.js";
import {
  coverageOf,
  coverageQuality,
  type CoverageQuality,
  type SamplerContext,
} from "./samplers.js";
import {
  allDuelPairings,
  balancedDuelPairings,
  planCompositions,
  planJobs,
  samplerFor,
  type MatchJob,
  type MatchOutcome,
} from "./jobs.js";
import { executeJobs, defaultWorkerCount } from "./pool.js";
import {
  placementStats,
  pool,
  rate,
  spreadOf,
  type PlacementStats,
  type Rate,
  type Spread,
} from "./stats.js";

/**
 * The balance evaluation system.
 *
 * Answers one question: given this engine and this balance configuration, how
 * balanced is the game? It measures; it does not judge. No threshold here
 * declares a kingdom overpowered — that is the future fitness function's job,
 * and conflating the two is how a measuring instrument acquires opinions.
 *
 * The central rule, from Step 3: a reading is always taken over a POPULATION of
 * strategies across ordered pairings, never a single personality.
 *
 * Execution is a three-stage pipeline — plan, execute, aggregate. The plan is a
 * pure function of the configuration and aggregation walks it in order, so
 * running across one thread or twelve produces the same reading.
 */

export interface FormatConfig {
  enabled: boolean;
  /** Seeds per (matchup or composition × ordered strategy pairing). */
  seedsPerPairing: number;
  /** FFA only: how many compositions to sample. */
  compositions?: number;
  /** FFA only: sampler name (see SAMPLERS). */
  sampler?: string;
}

export interface EvaluationConfig {
  balanceConfigId?: string;
  balance?: ParameterSet | null;
  pool?: SeedPoolName;
  population?: StrategyPopulation;
  maxTicks?: number;
  duel?: Partial<FormatConfig> & { pairings?: [KingdomId, KingdomId][] };
  ffa4?: Partial<FormatConfig>;
  ffa7?: Partial<FormatConfig>;
  /** Threads to run matches on. 1 runs in-process. */
  workers?: number;
  batchSize?: number;
  /** Bias for context-aware samplers (e.g. `diagnostic`). */
  samplerContext?: SamplerContext;
  onProgress?: (done: number, total: number) => void;
  /** Outcomes already computed (resume). */
  resume?: Map<string, MatchOutcome>;
  onBatch?: (outcomes: MatchOutcome[]) => void;
  now?: () => string;
}

const DEFAULT_DUEL: FormatConfig = { enabled: true, seedsPerPairing: 1 };
const DEFAULT_FFA4: FormatConfig = {
  enabled: true, seedsPerPairing: 1, compositions: 24, sampler: "coverage",
};
const DEFAULT_FFA7: FormatConfig = {
  enabled: true, seedsPerPairing: 1, compositions: 16, sampler: "coverage",
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface MatchupResult {
  a: KingdomId;
  b: KingdomId;
  /** A's win rate pooled over every ordered strategy pairing. THE number. */
  aggregate: Rate;
  byPairing: Record<string, Rate>;
  /** How much the result moves with strategy — diagnostic, never a fitness
   *  input. A wide spread means the matchup is strategy-sensitive, which is
   *  information about the game, not necessarily a defect. */
  profileSpread: Spread;
  timeouts: number;
  meanTicks: number;
}

export interface DuelResults {
  pairings: number;
  matches: number;
  matchups: MatchupResult[];
  kingdoms: Record<string, Rate>;
  profiles: Record<string, Rate>;
  /** Mirror pairings — seat-0 win rate. Diagnostic for controller asymmetry. */
  mirrors: Record<string, Rate>;
}

export interface FfaKingdomResult {
  kingdom: KingdomId;
  placement: PlacementStats;
}

export interface FfaKingdomSeatStats {
  /** Appearances per seat index. */
  appearances: number[];
  /** Mean placement when occupying each seat index. */
  meanPlacement: number[];
}

export interface FfaResults {
  seats: number;
  sampler: string;
  /** Sampler algorithm version — samples are not comparable across versions. */
  samplerVersion: number;
  compositions: KingdomId[][];
  coverage: Record<string, number>;
  /** How evenly the sample spreads across kingdoms and co-occurrences. */
  coverageQuality: CoverageQuality;
  /** Per-kingdom seat occupancy, so seat bias is visible rather than assumed. */
  seats_: Record<string, FfaKingdomSeatStats>;
  matches: number;
  timeouts: number;
  meanTicks: number;
  kingdoms: Record<string, FfaKingdomResult>;
  profiles: Record<string, Rate>;
}

export interface EvaluationResult {
  provenance: Provenance;
  pool: SeedPoolName;
  population: { version: string; profiles: string[] };
  totals: { matches: number; ticks: number; timeouts: number; durationMs: number };
  /** Infrastructure diagnostics. Excluded from equality comparisons because
   *  worker count legitimately varies between runs of the same evaluation. */
  execution: { workers: number; failures: { id: string; error: string }[] };
  duel: DuelResults | null;
  ffa4: FfaResults | null;
  ffa7: FfaResults | null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export { allDuelPairings, balancedDuelPairings };

function resolveConfig(config: EvaluationConfig) {
  return {
    population: config.population ?? POPULATION_V1,
    seedPool: config.pool ?? ("validation" as SeedPoolName),
    maxTicks: config.maxTicks ?? 24_000,
    duel: { ...DEFAULT_DUEL, ...config.duel },
    ffa4: { ...DEFAULT_FFA4, ...config.ffa4 } as Required<FormatConfig>,
    ffa7: { ...DEFAULT_FFA7, ...config.ffa7 } as Required<FormatConfig>,
  };
}

/** The jobs an evaluation would run — useful for cost estimates and resume. */
export function planEvaluation(config: EvaluationConfig = {}): MatchJob[] {
  const c = resolveConfig(config);
  return planJobs({
    pool: c.seedPool,
    population: c.population,
    maxTicks: c.maxTicks,
    duel: {
      enabled: c.duel.enabled,
      seedsPerPairing: c.duel.seedsPerPairing,
      pairings: config.duel?.pairings,
    },
    ffa4: c.ffa4,
    ffa7: c.ffa7,
    samplerContext: config.samplerContext,
  });
}

/** Evaluates a balance configuration and returns a reading. */
export async function evaluate(
  config: EvaluationConfig = {},
): Promise<EvaluationResult> {
  const c = resolveConfig(config);
  const jobs = planEvaluation(config);

  const provenance = captureProvenance({
    balanceConfigId: config.balanceConfigId ?? "baseline",
    balance: config.balance,
    strategyPopulationVersion: c.population.version,
    now: config.now,
  });

  const startedAt = performance.now();
  const execution = await executeJobs(jobs, {
    balance: config.balance ?? null,
    population: c.population,
    workers: config.workers,
    batchSize: config.batchSize,
    onProgress: config.onProgress,
    completed: config.resume,
    onBatch: config.onBatch,
  });
  const durationMs = performance.now() - startedAt;

  // Aggregate by walking the PLAN, not the results: completion order is
  // irrelevant and every reading is assembled in the same sequence.
  const outcome = (job: MatchJob): MatchOutcome | undefined =>
    execution.outcomes.get(job.id);

  let ticks = 0;
  let timeouts = 0;
  let counted = 0;
  for (const job of jobs) {
    const o = outcome(job);
    if (!o) continue;
    ticks += o.endedAtTick;
    if (o.timedOut) timeouts += 1;
    counted += 1;
  }

  return {
    provenance,
    pool: c.seedPool,
    population: {
      version: c.population.version,
      profiles: c.population.profiles.map((p) => p.id),
    },
    totals: { matches: counted, ticks, timeouts, durationMs },
    execution: { workers: execution.workers, failures: execution.failures },
    duel: c.duel.enabled ? aggregateDuels(jobs, execution.outcomes, c.population) : null,
    ffa4: c.ffa4.enabled
      ? aggregateFfa("ffa4", 4, jobs, execution.outcomes, c, config)
      : null,
    ffa7: c.ffa7.enabled
      ? aggregateFfa("ffa7", 7, jobs, execution.outcomes, c, config)
      : null,
  };
}

function bump(
  m: Map<string, { w: number; n: number }>,
  key: string,
  won: boolean,
): void {
  const e = m.get(key) ?? { w: 0, n: 0 };
  e.n += 1;
  if (won) e.w += 1;
  m.set(key, e);
}

function toRates(m: Map<string, { w: number; n: number }>): Record<string, Rate> {
  const out: Record<string, Rate> = {};
  for (const [k, v] of [...m].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = rate(v.w, v.n);
  }
  return out;
}

function aggregateDuels(
  jobs: MatchJob[],
  outcomes: Map<string, MatchOutcome>,
  population: StrategyPopulation,
): DuelResults {
  const pairings = orderedPairings(population);
  const kingdomWins = new Map<string, { w: number; n: number }>();
  const profileWins = new Map<string, { w: number; n: number }>();
  const mirrorWins = new Map<string, { w: number; n: number }>();

  // Group duel jobs by matchup, preserving plan order.
  const order: string[] = [];
  const grouped = new Map<string, MatchJob[]>();
  for (const job of jobs) {
    if (job.format !== "duel") continue;
    const key = `${job.duelA}|${job.duelB}`;
    let list = grouped.get(key);
    if (!list) { list = []; grouped.set(key, list); order.push(key); }
    list.push(job);
  }

  const matchups: MatchupResult[] = [];
  let matches = 0;

  for (const key of order) {
    const group = grouped.get(key)!;
    const a = group[0]!.duelA!;
    const b = group[0]!.duelB!;
    const byPairingCounts = new Map<string, { w: number; n: number }>();
    let aWins = 0;
    let n = 0;
    let mTimeouts = 0;
    let mTicks = 0;

    for (const job of group) {
      const o = outcomes.get(job.id);
      if (!o) continue;
      matches += 1;
      n += 1;
      mTicks += o.endedAtTick;
      if (o.timedOut) mTimeouts += 1;

      const aWon = o.winnerKingdom === a;
      const bWon = o.winnerKingdom === b;
      if (aWon) aWins += 1;
      bump(byPairingCounts, job.pairingKey, aWon);
      bump(kingdomWins, a, aWon);
      bump(kingdomWins, b, bWon);
      // Seat 0 plays profile A, seat 1 profile B.
      bump(profileWins, job.pairingA, aWon);
      bump(profileWins, job.pairingB, bWon);
      if (job.mirror) bump(mirrorWins, job.pairingA, o.winnerSeat === 0);
    }

    // Pairing order follows the population, not insertion, so the serialised
    // object is byte-stable.
    const byPairing: Record<string, Rate> = {};
    const perPairingRates: number[] = [];
    for (const pairing of pairings) {
      const c = byPairingCounts.get(pairing.key);
      if (!c) continue;
      const r = rate(c.w, c.n);
      byPairing[pairing.key] = r;
      perPairingRates.push(r.rate);
    }

    matchups.push({
      a, b,
      aggregate: rate(aWins, n),
      byPairing,
      profileSpread: spreadOf(perPairingRates),
      timeouts: mTimeouts,
      meanTicks: n > 0 ? mTicks / n : 0,
    });
  }

  return {
    pairings: matchups.length,
    matches,
    matchups,
    kingdoms: toRates(kingdomWins),
    profiles: toRates(profileWins),
    mirrors: toRates(mirrorWins),
  };
}

function aggregateFfa(
  format: "ffa4" | "ffa7",
  seats: number,
  jobs: MatchJob[],
  outcomes: Map<string, MatchOutcome>,
  c: ReturnType<typeof resolveConfig>,
  config: EvaluationConfig,
): FfaResults {
  const cfg = format === "ffa4" ? c.ffa4 : c.ffa7;
  const compositions = planCompositions(seats, cfg, c.seedPool, config.samplerContext);
  const byKingdom = new Map<string, number[]>();
  const profileFirsts = new Map<string, { w: number; n: number }>();
  // Seat occupancy and placement-by-seat: rotation is supposed to neutralise
  // positional advantage, and this is how we check that it did.
  const seatAppear = new Map<string, number[]>();
  const seatPlaceSum = new Map<string, number[]>();
  let matches = 0;
  let timeouts = 0;
  let ticks = 0;

  for (const job of jobs) {
    if (job.format !== format) continue;
    const o = outcomes.get(job.id);
    if (!o) continue;
    matches += 1;
    ticks += o.endedAtTick;
    if (o.timedOut) timeouts += 1;

    job.kingdoms.forEach((kingdom, seat) => {
      const list = byKingdom.get(kingdom) ?? [];
      list.push(o.placements[seat]!);
      byKingdom.set(kingdom, list);
      bump(profileFirsts, job.profiles[seat]!, o.winnerSeat === seat);

      const appear = seatAppear.get(kingdom) ?? new Array<number>(seats).fill(0);
      appear[seat] = (appear[seat] ?? 0) + 1;
      seatAppear.set(kingdom, appear);
      const sums = seatPlaceSum.get(kingdom) ?? new Array<number>(seats).fill(0);
      sums[seat] = (sums[seat] ?? 0) + o.placements[seat]!;
      seatPlaceSum.set(kingdom, sums);
    });
  }
  void config;

  const kingdoms: Record<string, FfaKingdomResult> = {};
  for (const [kingdom, list] of [...byKingdom].sort(([x], [y]) => x.localeCompare(y))) {
    kingdoms[kingdom] = {
      kingdom: kingdom as KingdomId,
      placement: placementStats(list, seats),
    };
  }

  const seats_: Record<string, FfaKingdomSeatStats> = {};
  for (const [kingdom, appear] of [...seatAppear].sort(([x], [y]) => x.localeCompare(y))) {
    const sums = seatPlaceSum.get(kingdom)!;
    seats_[kingdom] = {
      appearances: appear,
      meanPlacement: appear.map((n, i) => (n > 0 ? sums[i]! / n : 0)),
    };
  }

  return {
    seats,
    sampler: cfg.sampler,
    samplerVersion: samplerFor(cfg.sampler).version,
    compositions,
    coverage: coverageOf(compositions),
    coverageQuality: coverageQuality(compositions, seats),
    seats_,
    matches,
    timeouts,
    meanTicks: matches > 0 ? ticks / matches : 0,
    kingdoms,
    profiles: toRates(profileFirsts),
  };
}

/** Pools a set of matchup aggregates — used by reporting and comparison. */
export function poolMatchups(matchups: readonly MatchupResult[]): Rate {
  return pool(matchups.map((m) => m.aggregate));
}

export { defaultWorkerCount };
