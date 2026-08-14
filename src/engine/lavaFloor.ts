import type { GameState } from "../match/GameState.js";

/**
 * Magma's "Floor is Lava".
 *
 * A field-wide condition rather than a status on anyone: while it holds, every
 * burn on the battlefield hits harder — Fire's Burn, Magma's own, Kitsune's
 * foxfire. Other kingdoms' burns are fanned too, which is the point: setting
 * the floor alight is not a targeted attack, it changes the weather.
 *
 * The one exception is the kingdom that lit it, which is immune to its own
 * floor.
 *
 * Lives on GameState because it belongs to the MATCH, not to a player. A status
 * would have to be applied to every kingdom and kept in sync as they join, die,
 * or are added — and would wrongly disappear if its bearer did.
 */
export function lavaFloorMultiplier(state: GameState, bearerId: string): number {
  const lava = state.lavaFloor;
  if (!lava || state.tick >= lava.endTick) return 1;
  // The kingdom that set the floor alight walks on it unburned. Without this,
  // lighting it while carrying a burn is self-harm, and Magma would be
  // punished for using its own ability at the moment it matters most.
  if (bearerId === lava.ownerId) return 1;
  return lava.multiplier;
}
