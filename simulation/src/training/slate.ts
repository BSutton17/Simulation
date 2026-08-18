import type { KingdomId } from "../../../src/data/kingdoms.js";
import { deriveSeed, hashSeed } from "../rng.js";

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
 * Two further rules, both about fairness rather than variance:
 *
 *   - every genome in a generation plays the IDENTICAL slate (common random
 *     numbers), so a fitness difference is a difference in play rather than in
 *     which matchups were drawn;
 *   - the slate rotates between generations, so a population cannot overfit to
 *     one fixed set of matchups.
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
 * A generation's slate, with the identity that makes results comparable.
 *
 * A genome's fitness only means something next to the matches that produced it,
 * so the slate carries a hash and the checkpoint pins it.
 */
export interface Slate {
  version: string;
  generation: number;
  /** Which balance configuration these matches are played under. */
  balanceConfigId: string;
  scenarios: SlateScenario[];
  hash: string;
}

export const SLATE_VERSION = "v2";

export interface SlateConfig {
  /** Formats to sample. */
  formats: MatchFormat[];
  /** Distinct kingdoms the genome plays per generation. */
  kingdomsPerGenome: number;
  /** Heuristic profiles it faces. */
  opponents: string[];
  /** Seat positions tried per (format, kingdom, opponent) combination. */
  seatRotations: number;
  maxTicks: number;
}

export const DEFAULT_SLATE: SlateConfig = {
  // Duels dominate the default because they are the cheapest signal per match
  // and the least confounded: in a free-for-all a genome's placement depends
  // heavily on what the other six seats do to each other.
  formats: ["duel"],
  kingdomsPerGenome: 4,
  // A fixed, versioned opponent slate rather than self-play. Pure self-play
  // against a moving population invites cyclic dominance, and the measured
  // 89.6% duel win rate of the economic profile makes convergence on one
  // degenerate meta the likely outcome.
  opponents: ["balanced", "economic", "aggressive"],
  seatRotations: 2,
  maxTicks: 12_000,
};

/** FNV-1a, used for every fingerprint here so they stay dependency-free. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Builds one generation's slate.
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
  const scenarios: SlateScenario[] = [];
  const kingdomCount = Math.min(config.kingdomsPerGenome, kingdoms.length);
  const offset = (generation * kingdomCount) % kingdoms.length;

  for (const format of config.formats) {
    const seats = FORMAT_SEATS[format];
    for (let k = 0; k < kingdomCount; k++) {
      const candidateKingdom = kingdoms[(offset + k) % kingdoms.length]!;
      for (const profile of config.opponents) {
        for (let rotation = 0; rotation < config.seatRotations; rotation++) {
          // Rotating the seat matters: there is a measured seat gradient in this
          // simulation (mean 7-FFA placement runs 4.50 at seat 0 to 3.42 at seat
          // 6), so a genome pinned to one seat is scored partly on position
          // rather than on play.
          const candidateSeat = rotation % seats;
          const opponentKingdoms: KingdomId[] = [];
          const opponentProfiles: string[] = [];
          for (let s = 0; s < seats - 1; s++) {
            // Drawn from further along the roster so the genome rarely faces its
            // own mirror, which teaches little.
            opponentKingdoms.push(
              kingdoms[(offset + k + 1 + s + rotation) % kingdoms.length]!,
            );
            opponentProfiles.push(profile);
          }
          const id = `${format}:${candidateKingdom}:${profile}:s${candidateSeat}:r${rotation}`;
          scenarios.push({
            id,
            format,
            seats,
            candidateKingdom,
            opponentKingdoms,
            opponentProfiles,
            candidateSeat,
            seed: deriveSeed(hashSeed(`${runSeed}:${generation}:${id}`), scenarios.length),
            maxTicks: config.maxTicks,
          });
        }
      }
    }
  }

  const slate: Slate = {
    version: SLATE_VERSION,
    generation,
    balanceConfigId,
    scenarios,
    hash: "",
  };
  slate.hash = hashSlate(slate);
  return slate;
}

/** Fingerprint of a built slate, covering every scenario field. */
export function hashSlate(slate: Slate): string {
  return fnv1a(
    [
      slate.version,
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
    config.seatRotations
  );
}
