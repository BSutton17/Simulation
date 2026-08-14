import { CASTLE, CITIZENS, DARK, KITSUNE, TICK } from "../data/balance.js";
import type { Match } from "./Match.js";
import { param } from "../engine/parameters.js";

/**
 * Immutable ruleset snapshot captured when a match starts, so live balance edits
 * never affect an in-progress game (see DATA_MODELS.md → MatchConfig).
 */
export interface MatchConfig {
  roomCode: string;
  maxPlayers: number;
  tickRate: number;
  startingCitizens: number;
  startingCastleHp: number;
  /**
   * Damage Dark must absorb to fill the Unlimited Rage meter. Sent so the
   * client's meter reads the real cap instead of keeping its own copy — a
   * duplicated constant here is exactly how the HUD ended up advertising a
   * number the engine had stopped using.
   */
  rageFull: number;
  /** What a full Ancient Memory meter is worth (Kitsune's "Swift Tails"). */
  memoryFull: number;
}

/** Builds the config snapshot for a match from the current balance values. */
export function createMatchConfig(match: Match): MatchConfig {
  return {
    roomCode: match.roomCode,
    maxPlayers: match.maxPlayers,
    tickRate: TICK.RATE,
    startingCitizens: param("citizens.startingCount", CITIZENS.STARTING_COUNT),
    startingCastleHp: param("castle.startingHp", CASTLE.STARTING_HP),
    rageFull: DARK.RAGE_FULL,
    memoryFull: KITSUNE.MEMORY_FULL,
  };
}
