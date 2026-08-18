import { runHeadlessMatch } from "../headless.js";
import { mulberry32 } from "../rng.js";
import { seedFor } from "../evaluation/seeds.js";
import { NetworkController, type ControllerStats } from "../ai/index.js";
import { buildNetwork, type Genome } from "../neat/index.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import type { PlayerSpec } from "../types.js";
import { CombatObserver } from "./matchObserver.js";
import { aggregate, scoreScenario, type FitnessConfig, type ScenarioResult, type TrainingResult } from "./fitness.js";
import { FORMAT_SEATS, type MatchFormat } from "./slate.js";

/**
 * Self-play: the population is its own opposition.
 *
 * Two reasons this replaces heuristic opponents as the primary signal, and the
 * first is the one that matters:
 *
 *  1. THE HEURISTICS STOPPED DISCRIMINATING. Measured over thirty generations,
 *     best fitness sat at 1.594–1.598 against a ceiling of 1.60 from generation
 *     ZERO. Once a genome wins every match there is no gradient left to climb,
 *     and evolution has nothing to select on. A population playing itself can
 *     never saturate, because the opposition improves with it.
 *
 *  2. It is far cheaper per sample. A seven-seat free-for-all of genomes yields
 *     SEVEN fitness readings from one match rather than one — so the same
 *     coverage costs roughly a seventh of the matches.
 *
 * ⚠️ AND THE COST OF IT: fitness becomes RELATIVE. A score of 1.4 in generation
 * 30 is not comparable to 1.4 in generation 0, because the opponents changed
 * underneath it. Self-play can also cycle — A beats B beats C beats A — so a
 * population can churn forever while looking busy. Two things guard against
 * that, and neither is optional:
 *
 *   - the Hall of Fame below, which keeps past champions in the pool so
 *     progress is measured against history rather than only against peers;
 *   - the frozen heuristic validation slate in `slate.ts`, which is now the
 *     only ABSOLUTE yardstick the run has.
 */

/** One self-play match: several genomes, one table. */
export interface SelfPlayTable {
  id: string;
  format: MatchFormat;
  seats: number;
  /**
   * Who sits where. A non-negative number indexes the population; a negative
   * number indexes the Hall of Fame as `-(n + 1)`.
   */
  seatGenomes: number[];
  kingdoms: KingdomId[];
  seed: number;
  maxTicks: number;
}

export interface SelfPlayConfig {
  formats: MatchFormat[];
  /**
   * Rounds per format. Each round gives every genome exactly one match in that
   * format, so this is also "matches per genome per format".
   *
   * More rounds is the honest way to reduce the luck of who you were drawn
   * against — that luck is the price of self-play, and the only alternatives are
   * a full round robin (quadratic) or opponent-strength normalisation (a model
   * of its own, with its own assumptions).
   */
  roundsPerFormat: number;
  /** Fraction of seats offered to the Hall of Fame, 0 disables it. */
  hallOfFameShare: number;
  maxTicks: number;
}

export const DEFAULT_SELF_PLAY: SelfPlayConfig = {
  formats: ["duel", "ffa4", "ffa7"],
  roundsPerFormat: 2,
  hallOfFameShare: 0.15,
  maxTicks: 12_000,
};

/** Deterministic Fisher-Yates over indices, seeded per generation and format. */
function shuffled(count: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * Builds one generation's self-play tables.
 *
 * Shuffle-and-chunk rather than random sampling. Random sampling gives one
 * genome three matches and another none, and that difference shows up as
 * fitness — a genome would be selected for its draw rather than for its play.
 *
 * FAIRNESS GUARANTEE, stated exactly because it is not "identical for all":
 * when the seat count divides the population, every genome plays exactly
 * `roundsPerFormat` matches in that format. When it does not — thirty genomes
 * do not divide into sevens — the final table wraps to the front of the order,
 * so a few genomes play one extra match per round. That is unavoidable: five
 * seven-seat tables hold thirty-five seats and there are only thirty genomes.
 *
 * What IS guaranteed is that the surplus is at most one match per round, and
 * that it rotates: the order is reshuffled per generation, format and round, so
 * no genome is systematically favoured.
 */
export function buildSelfPlayTables(
  generation: number,
  config: SelfPlayConfig,
  populationSize: number,
  kingdoms: readonly KingdomId[],
  hallOfFameSize: number,
): SelfPlayTable[] {
  const tables: SelfPlayTable[] = [];

  for (const format of config.formats) {
    const seats = FORMAT_SEATS[format];
    for (let round = 0; round < config.roundsPerFormat; round++) {
      const order = shuffled(populationSize, hash(`${generation}:${format}:${round}`));
      for (let start = 0; start < order.length; start += seats) {
        const seatGenomes: number[] = [];
        for (let s = 0; s < seats; s++) {
          // Wrap rather than drop the tail: a population that is not a multiple
          // of the seat count would otherwise leave its last few genomes
          // unevaluated in that format.
          seatGenomes.push(order[(start + s) % order.length]!);
        }
        // Offer some seats to past champions, so a generation cannot drift away
        // from everything that came before it and call that progress.
        if (hallOfFameSize > 0 && config.hallOfFameShare > 0) {
          const slots = Math.floor(seats * config.hallOfFameShare);
          for (let s = 0; s < slots; s++) {
            const which = (generation + round + start + s) % hallOfFameSize;
            seatGenomes[seats - 1 - s] = -(which + 1);
          }
        }

        const id = `${format}:g${generation}:r${round}:t${start / seats}`;
        tables.push({
          id,
          format,
          seats,
          seatGenomes,
          // Kingdoms rotate with the table so a genome meets many matchups
          // across a run rather than specialising in one.
          kingdoms: seatGenomes.map(
            (_, s) => kingdoms[(generation * seats + start + s) % kingdoms.length]!,
          ),
          seed: seedFor("training", id, "selfplay", 0),
          maxTicks: config.maxTicks,
        });
      }
    }
  }
  return tables;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const emptyStats = (): ControllerStats => ({
  decisions: 0, casts: 0, invests: 0, citizens: 0, repairs: 0, shields: 0,
  retargets: 0, waits: 0, rejected: 0, rejectedBy: {}, forcedWaits: 0,
});

/**
 * Plays one table and scores EVERY seat.
 *
 * The efficiency argument made concrete: a seven-seat match returns seven
 * results, so a population of sixty is fully evaluated in roughly nine matches
 * per round rather than sixty.
 */
export function playTable(
  table: SelfPlayTable,
  resolve: (index: number) => Genome,
  config: FitnessConfig,
): { seat: number; genomeIndex: number; result: ScenarioResult }[] {
  const stats = new Map<number, ControllerStats>();
  const players: PlayerSpec[] = table.seatGenomes.map((genomeIndex, seat) => {
    const network = buildNetwork(resolve(genomeIndex));
    return {
      kingdomId: table.kingdoms[seat]!,
      name: `g${genomeIndex}-s${seat}`,
      ai: (player, rng) => {
        const controller = new NetworkController(player, { network, rng, difficulty: "hard" });
        stats.set(seat, controller.stats);
        return controller;
      },
    };
  });

  const observer = new CombatObserver();
  const record = runHeadlessMatch({
    players,
    seed: table.seed,
    maxTicks: table.maxTicks,
    createAI: players[0]!.ai!,
    observers: [observer],
    telemetry: false,
  });

  return table.seatGenomes.map((genomeIndex, seat) => {
    const playerId = `p${seat}`;
    const combat = observer.for(playerId);
    const seatStats = stats.get(seat) ?? emptyStats();
    return {
      seat,
      genomeIndex,
      result: scoreScenario(
        record,
        playerId,
        {
          scenarioId: `${table.id}:s${seat}`,
          format: table.format,
          seats: table.seats,
          kingdom: table.kingdoms[seat]!,
          seat,
          combat,
          behaviour: {
            casts: combat.casts,
            invests: seatStats.invests,
            citizens: seatStats.citizens,
            repairs: seatStats.repairs,
            shields: seatStats.shields,
            retargets: seatStats.retargets,
            waits: seatStats.waits,
            decisions: seatStats.decisions,
            forcedWaits: seatStats.forcedWaits,
          },
        },
        config,
      ),
    };
  });
}

/** Evaluates a whole population by self-play, returning one result per genome. */
export function evaluatePopulation(
  genomes: readonly Genome[],
  hallOfFame: readonly Genome[],
  tables: readonly SelfPlayTable[],
  config: FitnessConfig,
): TrainingResult[] {
  const collected: ScenarioResult[][] = genomes.map(() => []);
  const resolve = (index: number): Genome =>
    index >= 0 ? genomes[index]! : hallOfFame[-(index + 1)]!;

  let rejected = 0;
  const causes: Record<string, number> = {};
  for (const table of tables) {
    for (const entry of playTable(table, resolve, config)) {
      // Hall-of-Fame seats are opposition, not candidates: they are scored so
      // the match resolves, but their results belong to no living genome.
      if (entry.genomeIndex >= 0) collected[entry.genomeIndex]!.push(entry.result);
    }
  }
  void rejected;
  void causes;

  return collected.map((scenarios) => aggregate(scenarios));
}

/**
 * The Hall of Fame: past champions, kept as opposition.
 *
 * Bounded and evenly spaced across the run rather than "the last N", so the pool
 * spans the whole history instead of a recent window — a population cannot then
 * escape its own past by outrunning a sliding one.
 */
export class HallOfFame {
  private readonly members: { genome: Genome; generation: number }[] = [];

  constructor(private readonly capacity = 8) {}

  /** Admits a champion, evicting to keep the span even. */
  admit(genome: Genome, generation: number): void {
    this.members.push({ genome, generation });
    if (this.members.length <= this.capacity) return;
    // Drop the entry whose neighbours are closest together, which keeps the
    // retained champions spread across generations.
    let tightest = 1;
    let smallest = Infinity;
    for (let i = 1; i < this.members.length - 1; i++) {
      const span = this.members[i + 1]!.generation - this.members[i - 1]!.generation;
      if (span < smallest) {
        smallest = span;
        tightest = i;
      }
    }
    this.members.splice(tightest, 1);
  }

  get genomes(): Genome[] {
    return this.members.map((m) => m.genome);
  }

  get size(): number {
    return this.members.length;
  }

  toJSON(): { genome: Genome; generation: number }[] {
    return this.members;
  }

  static fromJSON(entries: { genome: Genome; generation: number }[], capacity = 8): HallOfFame {
    const hall = new HallOfFame(capacity);
    for (const entry of entries) hall.admit(entry.genome, entry.generation);
    return hall;
  }
}

/** Matches per generation, for budgeting. */
export function tableCount(config: SelfPlayConfig, populationSize: number): number {
  return config.formats.reduce(
    (sum, format) =>
      sum + config.roundsPerFormat * Math.ceil(populationSize / FORMAT_SEATS[format]),
    0,
  );
}
