import type { KingdomId } from "../../../src/data/kingdoms.js";
import { seedFor, type SeedPoolName } from "../evaluation/seeds.js";

/**
 * The evaluation slate: the exact set of matches a genome is judged on.
 *
 * ⚠️ THE CONSTRAINT THIS MODULE EXISTS FOR. A NEAT phenotype is a DETERMINISTIC
 * policy. Evaluating one on thirty seeds of the same matchup replays essentially
 * the same match thirty times — which is how this project's earlier balance
 * readings became booleans wearing a decimal point, reading 40/40 or 0/40 and
 * flipping wholesale on a small change. Diversity has to come from the SCENARIO:
 * format, kingdom, opponents, seat. Reseeding alone is not diversity.
 *
 * Three rules, the first two about fairness and the third about honesty:
 *
 *   - every genome in a generation plays the IDENTICAL training slate (common
 *     random numbers), so a fitness difference is a difference in play rather
 *     than in which matchups were drawn;
 *   - the training slate rotates between generations, so a population cannot
 *     overfit to one fixed set of matchups;
 *   - a FROZEN validation slate, drawn from a provably disjoint seed pool and
 *     never trained against, is the only way to tell "learned to play" from
 *     "learned these matches". See `buildValidationSlate`.
 */

export type MatchFormat = "duel" | "ffa4" | "ffa7";

/** Seats per format. Seven is the engine's MAX_ACTIVE_PLAYERS. */
export const FORMAT_SEATS: Readonly<Record<MatchFormat, number>> = {
  duel: 2,
  ffa4: 4,
  ffa7: 7,
};

/** One fully-specified, reproducible evaluation match. */
export interface SlateScenario {
  /** Deterministic, human-readable — also the aggregation key. */
  id: string;
  format: MatchFormat;
  seats: number;
  /** The kingdom the genome plays. */
  candidateKingdom: KingdomId;
  /** Kingdoms of the other seats, filling the remaining seats in order. */
  opponentKingdoms: KingdomId[];
  /** Heuristic profile id per opposing seat. */
  opponentProfiles: string[];
  /** Seat index the genome occupies. */
  candidateSeat: number;
  seed: number;
  maxTicks: number;
}

/**
 * A slate, with the identity that makes results comparable.
 *
 * A genome's fitness only means something next to the matches that produced it,
 * so the slate carries a hash and the checkpoint pins its shape.
 */
export interface Slate {
  version: string;
  /** Which seed pool the matches were drawn from. */
  pool: SeedPoolName;
  /** Generation this was built for; -1 for the frozen validation slate. */
  generation: number;
  /** Which balance configuration these matches are played under. */
  balanceConfigId: string;
  scenarios: SlateScenario[];
  hash: string;
}

export const SLATE_VERSION = "v3";

export interface SlateConfig {
  /** Formats to sample. */
  formats: MatchFormat[];
  /** Distinct kingdoms the genome plays per generation. */
  kingdomsPerGenome: number;
  /** Heuristic profiles it faces. */
  opponents: string[];
  /** Seat positions tried per (format, kingdom, opponent) combination. */
  seatRotations: number;
  /**
   * Repeats per scenario, on different seeds.
   *
   * Deliberately the LAST lever. Extra seeds on an identical matchup buy very
   * little against a deterministic policy; a second kingdom or a second format
   * buys a great deal. Kept configurable because a little seed repetition does
   * damp the luck in chance-heavy kits (Joker's wagers, Ice's proc gates).
   */
  seedsPerScenario: number;
  maxTicks: number;
}

/**
 * The default TRAINING slate: two formats, four kingdoms, two opponents.
 *
 * Duels carry most of the signal per second — they are the cheapest match and
 * the least confounded, since in a free-for-all a genome's placement depends
 * heavily on what the other seats do to each other. The 4-FFA is there because
 * placement in a crowd is a different skill and the format inversion measured in
 * this project (Earth 13th in duels, best at 7 seats) says a duel-only reading
 * would be a partial view. 7-FFA is left to validation, where its cost is paid
 * once rather than every generation.
 */
export const DEFAULT_SLATE: SlateConfig = {
  formats: ["duel", "ffa4"],
  kingdomsPerGenome: 4,
  opponents: ["balanced", "aggressive"],
  seatRotations: 2,
  seedsPerScenario: 1,
  maxTicks: 12_000,
};

/** FNV-1a, so every fingerprint here stays dependency-free. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface BuildOptions {
  pool: SeedPoolName;
  generation: number;
  config: SlateConfig;
  kingdoms: readonly KingdomId[];
  /** Offset into the kingdom roster; drives per-generation rotation. */
  kingdomOffset: number;
  balanceConfigId: string;
}

function buildScenarios(options: BuildOptions): SlateScenario[] {
  const { config, kingdoms, kingdomOffset, pool } = options;
  const scenarios: SlateScenario[] = [];
  const kingdomCount = Math.min(config.kingdomsPerGenome, kingdoms.length);

  for (const format of config.formats) {
    const seats = FORMAT_SEATS[format];
    for (let k = 0; k < kingdomCount; k++) {
      const candidateKingdom = kingdoms[(kingdomOffset + k) % kingdoms.length]!;
      for (const profile of config.opponents) {
        for (let rotation = 0; rotation < config.seatRotations; rotation++) {
          // Rotating the seat matters: there is a measured seat gradient in this
          // simulation (mean 7-FFA placement runs 4.50 at seat 0 to 3.42 at seat
          // 6), so a genome pinned to one seat is scored partly on position.
          const candidateSeat = rotation % seats;
          const opponentKingdoms: KingdomId[] = [];
          const opponentProfiles: string[] = [];
          for (let s = 0; s < seats - 1; s++) {
            // Drawn from further along the roster so the genome rarely faces its
            // own mirror, which teaches little.
            opponentKingdoms.push(
              kingdoms[(kingdomOffset + k + 1 + s + rotation) % kingdoms.length]!,
            );
            opponentProfiles.push(profile);
          }
          for (let repeat = 0; repeat < config.seedsPerScenario; repeat++) {
            const label = `${format}:${candidateKingdom}:${profile}:s${candidateSeat}:r${rotation}`;
            scenarios.push({
              id: config.seedsPerScenario > 1 ? `${label}#${repeat}` : label,
              format,
              seats,
              candidateKingdom,
              opponentKingdoms,
              opponentProfiles,
              candidateSeat,
              // The repository's existing pool machinery: training, validation
              // and final occupy separate regions of the seed space and cannot
              // collide by construction, which is the only version of this rule
              // that survives an unattended run.
              seed: seedFor(pool, label, `gen${options.generation}`, repeat),
              maxTicks: config.maxTicks,
            });
          }
        }
      }
    }
  }
  return scenarios;
}

function finish(options: BuildOptions, scenarios: SlateScenario[]): Slate {
  const slate: Slate = {
    version: SLATE_VERSION,
    pool: options.pool,
    generation: options.generation,
    balanceConfigId: options.balanceConfigId,
    scenarios,
    hash: "",
  };
  slate.hash = hashSlate(slate);
  return slate;
}

/**
 * The training slate for one generation.
 *
 * Kingdom selection walks the roster with a per-generation offset rather than
 * sampling randomly, so across a run every kingdom is played an equal number of
 * times instead of merely an expected-equal number.
 */
export function buildSlate(
  generation: number,
  config: SlateConfig,
  kingdoms: readonly KingdomId[],
  runSeed: number,
  balanceConfigId = "baseline",
): Slate {
  void runSeed; // seeds now come from the pool machinery, not the run seed
  const kingdomCount = Math.min(config.kingdomsPerGenome, kingdoms.length);
  const options: BuildOptions = {
    pool: "training",
    generation,
    config,
    kingdoms,
    kingdomOffset: (generation * kingdomCount) % kingdoms.length,
    balanceConfigId,
  };
  return finish(options, buildScenarios(options));
}

/**
 * The frozen validation slate.
 *
 * Never trained against, drawn from a disjoint seed pool, and identical in every
 * generation — that is what makes it a measurement rather than another training
 * signal. It exists to separate two outcomes that look the same on a training
 * curve:
 *
 *     training ↑ and validation ↑   the policy got better at Elementals
 *     training ↑ and validation flat the policy memorised its slate
 *
 * Deliberately BROADER than the training slate: every kingdom, all three
 * formats, and an opponent the training slate never uses. A validation set that
 * samples the same narrow corner as training cannot detect overfitting to that
 * corner.
 */
export function buildValidationSlate(
  kingdoms: readonly KingdomId[],
  balanceConfigId = "baseline",
  overrides: Partial<SlateConfig> = {},
): Slate {
  const config: SlateConfig = {
    formats: ["duel", "ffa4", "ffa7"],
    // Every kingdom, so a champion cannot look good by being good at four.
    kingdomsPerGenome: kingdoms.length,
    // `economic` is held out of the default training slate on purpose: it is the
    // strongest heuristic measured (89.6% of duels) and makes the sharpest test
    // of whether a champion generalises past what it was trained on.
    opponents: ["economic"],
    seatRotations: 1,
    seedsPerScenario: 1,
    maxTicks: 12_000,
    ...overrides,
  };
  const options: BuildOptions = {
    pool: "validation",
    generation: -1, // frozen: not tied to any generation
    config,
    kingdoms,
    kingdomOffset: 0,
    balanceConfigId,
  };
  return finish(options, buildScenarios(options));
}

/** Fingerprint of a built slate, covering every scenario field. */
export function hashSlate(slate: Slate): string {
  return fnv1a(
    [
      slate.version,
      slate.pool,
      slate.balanceConfigId,
      ...slate.scenarios.map(
        (s) =>
          `${s.id}|${s.format}|${s.seats}|${s.candidateKingdom}|${s.opponentKingdoms.join(",")}|` +
          `${s.opponentProfiles.join(",")}|${s.candidateSeat}|${s.seed}|${s.maxTicks}`,
      ),
    ].join(";"),
  );
}

/**
 * The slate's SHAPE, independent of which generation it was built for.
 *
 * This is what a checkpoint pins. Resuming must refuse a changed evaluation
 * DESIGN — different formats, kingdoms, opponents, tick cap — but must not
 * refuse merely because generation 4's kingdoms differ from generation 0's by
 * exactly the rotation the design itself specifies.
 */
export function slateShapeHash(
  config: SlateConfig,
  kingdoms: readonly KingdomId[],
  runSeed: number,
  balanceConfigId = "baseline",
): string {
  return fnv1a(
    [
      SLATE_VERSION,
      balanceConfigId,
      runSeed,
      config.formats.join(","),
      config.kingdomsPerGenome,
      config.opponents.join(","),
      config.seatRotations,
      config.seedsPerScenario,
      config.maxTicks,
      kingdoms.join(","),
    ].join(";"),
  );
}

/** Matches per genome for a slate configuration. */
export function slateSize(config: SlateConfig, kingdomCount: number): number {
  return (
    config.formats.length *
    Math.min(config.kingdomsPerGenome, kingdomCount) *
    config.opponents.length *
    config.seatRotations *
    config.seedsPerScenario
  );
}

/** Seats summed across a slate — a better cost proxy than match count. */
export function slateSeatCost(slate: Slate): number {
  return slate.scenarios.reduce((sum, s) => sum + s.seats, 0);
}
