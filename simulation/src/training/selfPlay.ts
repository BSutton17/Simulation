import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
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

/**
 * How a table's opponents are chosen. All three seat DISTINCT genomes.
 *
 *  - "shuffle"  partition a per-round shuffle. Every genome plays exactly the
 *               same number of matches, against uniformly-drawn peers.
 *  - "banded"   partition the previous generation's fitness ORDER, with local
 *               jitter. Still equal match counts, but a genome mostly meets
 *               opponents of its own strength — a Swiss pairing. Narrows the
 *               spread that comes from who you were drawn against, which is
 *               self-play's main source of fitness noise.
 *  - "random"   sample each table independently. Match counts then vary between
 *               genomes, which is why it is not the default; kept because it is
 *               the unbiased reference the other two are measured against.
 */
export type OpponentSelection = "shuffle" | "banded" | "random";

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
  opponentSelection: OpponentSelection;
}

export const DEFAULT_SELF_PLAY: SelfPlayConfig = {
  formats: ["duel", "ffa4", "ffa7"],
  roundsPerFormat: 2,
  hallOfFameShare: 0.15,
  maxTicks: 12_000,
  opponentSelection: "shuffle",
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
  /** Genome indices ordered strongest-first. Only "banded" reads it. */
  ranking?: readonly number[],
): SelfPlayTable[] {
  const tables: SelfPlayTable[] = [];

  for (const format of config.formats) {
    const seats = FORMAT_SEATS[format];
    // A genome may never face a copy of itself, so a table needs as many
    // distinct genomes as it has seats. Refuse loudly rather than quietly seat
    // someone twice: a population that cannot fill a format is a configuration
    // mistake, and silently playing mirror matches would corrupt every fitness
    // reading in the run.
    if (populationSize < seats) {
      throw new Error(
        `population ${populationSize} cannot fill a ${seats}-seat ${format} table ` +
          `without seating a genome against itself; raise --population or drop the format`,
      );
    }
    for (let round = 0; round < config.roundsPerFormat; round++) {
      const seed = hash(`${generation}:${format}:${round}`);
      const order = orderFor(config.opponentSelection, seed, populationSize, seats, ranking);
      for (let start = 0; start < order.length; start += seats) {
        const seatGenomes =
          config.opponentSelection === "random"
            ? distinctSeats(shuffled(populationSize, hash(`${seed}:${start}`)), 0, seats)
            : distinctSeats(order, start, seats);

        // Offer some seats to past champions, so a generation cannot drift away
        // from everything that came before it and call that progress.
        if (hallOfFameSize > 0 && config.hallOfFameShare > 0) {
          // Never more entries than the hall holds (which would seat the same
          // champion twice) and never the whole table (which would leave no
          // living genome to score).
          const slots = Math.min(
            Math.floor(seats * config.hallOfFameShare),
            hallOfFameSize,
            seats - 1,
          );
          for (let s = 0; s < slots; s++) {
            const which = (generation + round + start + s) % hallOfFameSize;
            seatGenomes[seats - 1 - s] = -(which + 1);
          }
        }
        assertDistinct(seatGenomes, format, generation, round, start);

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

/**
 * Takes `seats` DISTINCT indices from `order`, starting at `start`.
 *
 * The tail of a population that does not divide evenly still wraps to the front
 * — dropping it would leave those genomes unevaluated in that format — but a
 * wrap that lands on someone already seated walks forward instead of seating
 * them twice. That is the whole difference between self-play and a genome
 * playing a mirror of itself, which scores nothing and teaches nothing.
 */
function distinctSeats(order: readonly number[], start: number, seats: number): number[] {
  const chosen: number[] = [];
  const used = new Set<number>();
  let cursor = start;
  while (chosen.length < seats) {
    const candidate = order[cursor % order.length]!;
    cursor += 1;
    if (used.has(candidate)) continue;
    used.add(candidate);
    chosen.push(candidate);
  }
  return chosen;
}

/**
 * Orders the population for one round's partition.
 *
 * "banded" keeps the previous generation's ranking but jitters within a small
 * window, so a genome meets opponents near its own strength without meeting the
 * identical set every round.
 */
function orderFor(
  mode: OpponentSelection,
  seed: number,
  populationSize: number,
  seats: number,
  ranking?: readonly number[],
): number[] {
  if (mode === "banded" && ranking && ranking.length === populationSize) {
    const order = [...ranking];
    const rng = mulberry32(seed);
    // Shuffle WITHIN contiguous bands rather than swapping neighbours. A
    // neighbour swap looks local but is not: an element swapped forward can be
    // swapped forward again when the loop reaches its new position, so it random
    // walks arbitrarily far and the pairing degenerates to uniform. Measured —
    // the top-ranked genome came out facing rank 15 of 24.
    const band = Math.min(order.length, seats * 2);
    for (let base = 0; base < order.length; base += band) {
      const end = Math.min(order.length, base + band);
      for (let i = end - 1; i > base; i--) {
        const j = base + Math.floor(rng() * (i - base + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    }
    return order;
  }
  return shuffled(populationSize, seed);
}

/** The invariant this whole module rests on: no genome faces a copy of itself. */
function assertDistinct(
  seatGenomes: readonly number[],
  format: MatchFormat,
  generation: number,
  round: number,
  start: number,
): void {
  if (new Set(seatGenomes).size === seatGenomes.length) return;
  throw new Error(
    `${format} g${generation} r${round} t${start} seated a genome against itself: ` +
      `[${seatGenomes.join(", ")}]`,
  );
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
  actionSwitches: 0, distinctActions: 0, legalOffered: 0,
  castLegal: [0, 0, 0, 0, 0], castChosen: [0, 0, 0, 0, 0],
  castBlockedNotUnlocked: [0, 0, 0, 0, 0],
  castBlockedNotAffordable: [0, 0, 0, 0, 0],
  castBlockedOther: [0, 0, 0, 0, 0],
  investAffordable: [0, 0, 0, 0, 0], investChosen: [0, 0, 0, 0, 0],
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
            // From the EVENT STREAM, not the controller: only the network
            // controller keeps stats, so a heuristic would otherwise look like
            // it used nothing at all.
            distinctAbilities: combat.abilitiesUsed.size,
            kitSize: abilitiesForKingdom(table.kingdoms[seat]!).filter(
              (a) => a.kind !== "passive",
            ).length,
          },
        },
        config,
      ),
    };
  });
}

/**
 * Removes mirror matches that distinct INDICES cannot catch.
 *
 * A Hall-of-Fame entry is a clone of a past champion, and an elite carried
 * unchanged through reproduction still holds that champion's id — so a table can
 * seat index 4 and hall entry 2 and have them be the same player. Distinct
 * indices are not distinct genomes. Walks to the next hall member that does not
 * collide; if the hall offers none, the seat falls back to the living genome
 * rather than mirroring.
 */
export function deconflict(
  table: SelfPlayTable,
  resolve: (index: number) => Genome,
  populationSize: number,
  hallSize: number,
): SelfPlayTable {
  const ids = table.seatGenomes.map((index) => resolve(index).id);
  if (new Set(ids).size === ids.length) return table;

  const seatGenomes = [...table.seatGenomes];
  const seen = new Set<string>();
  const seated = new Set<number>(seatGenomes);
  for (let seat = 0; seat < seatGenomes.length; seat++) {
    const index = seatGenomes[seat]!;
    const id = resolve(index).id;
    if (!seen.has(id)) {
      seen.add(id);
      continue;
    }
    // Only a Hall-of-Fame seat can collide: living indices are distinct by
    // construction, so a repeated id means a hall clone met its own elite.
    let replacement: number | null = null;
    for (let step = 1; step < hallSize && replacement === null; step++) {
      const which = (-(index + 1) + step) % hallSize;
      if (!seen.has(resolve(-(which + 1)).id)) replacement = -(which + 1);
    }
    // Hall exhausted: fall back to any unseated living genome, so the table
    // never plays a mirror even in the corner case.
    for (let i = 0; i < populationSize && replacement === null; i++) {
      if (!seated.has(i) && !seen.has(resolve(i).id)) replacement = i;
    }
    if (replacement === null) {
      seen.add(id);
      continue;
    }
    seatGenomes[seat] = replacement;
    seated.add(replacement);
    seen.add(resolve(replacement).id);
  }
  return { ...table, seatGenomes };
}

/** Evaluates a whole population by self-play, returning one result per genome. */
export function evaluatePopulation(
  genomes: readonly Genome[],
  hallOfFame: readonly Genome[],
  tables: readonly SelfPlayTable[],
  config: FitnessConfig,
): TrainingResult[] {
  const resolve = (index: number): Genome =>
    index >= 0 ? genomes[index]! : hallOfFame[-(index + 1)]!;

  const seated = seatTables(tables, genomes, hallOfFame);
  return collectResults(
    seated.map((table) => playTable(table, resolve, config)),
    genomes.length,
  );
}

/**
 * Deconflicts every table once, on the parent.
 *
 * Split out because the parallel runner needs the tables settled BEFORE they are
 * dispatched: deconfliction compares genome ids across a table, which a worker
 * holding only a snapshot could also do, but doing it in one place keeps the
 * seating decision identical whichever runner plays the match.
 */
export function seatTables(
  tables: readonly SelfPlayTable[],
  genomes: readonly Genome[],
  hallOfFame: readonly Genome[],
): SelfPlayTable[] {
  const resolve = (index: number): Genome =>
    index >= 0 ? genomes[index]! : hallOfFame[-(index + 1)]!;
  return tables.map((table) => deconflict(table, resolve, genomes.length, hallOfFame.length));
}

/**
 * Collects seat rows into per-genome results.
 *
 * Takes rows ALREADY IN TABLE ORDER. The order matters beyond tidiness: this
 * pushes into per-genome arrays that `aggregate` then sums, and floating-point
 * addition is not associative, so a different arrival order would produce
 * fitnesses that differ in the last bits. The parallel runner restores order
 * before calling this, which is what makes the two paths byte-identical.
 */
export function collectResults(
  rowsPerTable: readonly (readonly SeatRow[])[],
  genomeCount: number,
): TrainingResult[] {
  const collected: ScenarioResult[][] = Array.from({ length: genomeCount }, () => []);
  for (const rows of rowsPerTable) {
    for (const entry of rows) {
      // Hall-of-Fame seats are opposition, not candidates: they are scored so
      // the match resolves, but their results belong to no living genome.
      if (entry.genomeIndex >= 0) collected[entry.genomeIndex]!.push(entry.result);
    }
  }
  return collected.map((scenarios) => aggregate(scenarios));
}

/** One seat's outcome. Mirrors `playTable`'s row so the two paths agree. */
export interface SeatRow {
  seat: number;
  genomeIndex: number;
  result: ScenarioResult;
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
