import type { KingdomId } from "../data/kingdoms.js";
import type { PerkId } from "../data/perks.js";

/** Lifecycle phase of a match (see DATA_MODELS.md → Match). */
export type MatchPhase = "lobby" | "starting" | "active" | "ended";

/**
 * A participant as tracked by the Match at the room/connection level.
 *
 * This is intentionally lightweight — the full gameplay Player model (castle,
 * economy, abilities, statuses…) is layered on separately as those systems land
 * (see DATA_MODELS.md → Player and the `player/` folder).
 */
export interface MatchPlayer {
  /** Stable player id (persists across reconnects within a match). */
  id: string;
  /** Current transport connection; null while disconnected. */
  socketId: string | null;
  /** Display name. */
  name: string;
  /** Selected kingdom, or null until chosen in the lobby. */
  kingdomId: KingdomId | null;
  /**
   * The player's chosen perks — distinct ids, up to `PERKS_PER_PLAYER`. Empty
   * until they start picking; a full selection is required to ready up.
   * Optional so lightweight fixtures need not spell it out.
   */
  perks?: PerkId[];
  /** Lobby ready state. */
  ready: boolean;
  /** Whether the player currently has a live connection. */
  connected: boolean;
  /** A spectator watches the match without a kingdom/castle — never gets a
   *  gameplay PlayerState, doesn't count toward the active-player cap or the
   *  start requirements. The 8th seat can only ever be a spectator. */
  spectator?: boolean;
}
