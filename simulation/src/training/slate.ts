import type { KingdomId } from "../../../src/data/kingdoms.js";
import { deriveSeed, hashSeed } from "../rng.js";
import type { SlateConfig } from "./config.js";

/**
 * The matches a genome is judged on.
 *
 * ⚠️ THE CONSTRAINT THIS MODULE EXISTS FOR: a NEAT phenotype is a
 * DETERMINISTIC policy. Evaluating one on thirty seeds of the same matchup
 * replays essentially the same match thirty times — which is exactly how this
 * project's earlier balance readings came to be booleans wearing a decimal
 * point, with matchups reading 40/40 or 0/40 and flipping wholesale on a small
 * change. Variance has to come from the MATCHUP: which kingdom the genome
 * plays, which strategy it faces, which seat it sits in.
 *
 * Two further rules, both about fairness rather than variance:
 *
 *   - every genome in a generation plays the IDENTICAL slate (common random
 *     numbers), so fitness differences are differences in play rather than in
 *     luck of the draw;
 *   - the slate rotates each generation, so the population cannot overfit to
 *     one fixed set of matchups.
 */

export interface SlateEntry {
  kingdom: KingdomId;
  /** Kingdoms of the other seats, in seat order. */
  opponentKingdoms: KingdomId[];
  /** Heuristic profile id per opposing seat. */
  opponentProfiles: string[];
  /** Which seat index the genome occupies. */
  seat: number;
  seed: number;
}

/**
 * Builds one generation's slate.
 *
 * Kingdom selection walks the roster with a per-generation offset rather than
 * sampling randomly, so across a run every kingdom is seen an equal number of
 * times instead of merely an expected-equal number.
 */
export function buildSlate(
  generation: number,
  config: SlateConfig,
  kingdoms: readonly KingdomId[],
  runSeed: number,
): SlateEntry[] {
  const entries: SlateEntry[] = [];
  const count = Math.min(config.kingdomsPerGenome, kingdoms.length);
  const offset = (generation * count) % kingdoms.length;

  for (let k = 0; k < count; k++) {
    const kingdom = kingdoms[(offset + k) % kingdoms.length]!;
    for (const profile of config.opponents) {
      for (let rotation = 0; rotation < config.seatRotations; rotation++) {
        const seat = rotation % config.seats;
        // Opponents are drawn from the far side of the roster so a genome is
        // rarely handed its own mirror, which teaches little.
        const opponentKingdoms: KingdomId[] = [];
        const opponentProfiles: string[] = [];
        for (let s = 0; s < config.seats - 1; s++) {
          opponentKingdoms.push(
            kingdoms[(offset + k + 1 + s + rotation) % kingdoms.length]!,
          );
          opponentProfiles.push(profile);
        }
        entries.push({
          kingdom,
          opponentKingdoms,
          opponentProfiles,
          seat,
          seed: deriveSeed(
            hashSeed(`${runSeed}:${generation}:${kingdom}:${profile}:${rotation}`),
            entries.length,
          ),
        });
      }
    }
  }
  return entries;
}

/** Matches per genome for a given slate configuration. */
export function slateSize(config: SlateConfig, kingdomCount: number): number {
  return (
    Math.min(config.kingdomsPerGenome, kingdomCount) *
    config.opponents.length *
    config.seatRotations
  );
}
