import type { GameState } from "../match/GameState.js";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Death detection and kingdom elimination (tickets #69–#70).
 *
 * Detection (#69): a kingdom dies when its castle HP reaches 0, whatever the
 * source (direct hits via `applyDamage`, and later damage-over-time statuses).
 * `eliminatedAtTick === null` marks a death not yet processed, so each castle
 * is eliminated exactly once even if the `eliminated` flag was already set at
 * the moment of the killing blow.
 *
 * Elimination (#70): removes the kingdom from *active gameplay* — pending
 * statuses, modifiers, cooldowns, and target are cleared, and every opponent
 * aiming at it loses their target (with an immediate re-target allowed, so the
 * switch cooldown never strands a player aiming at a corpse). The PlayerState
 * itself is retained with its economy and `eliminatedAtTick` intact, preserving
 * end-of-match statistics. All interaction paths (income, purchases, targeting,
 * ability activation) independently reject eliminated players.
 */

/** Finds castles at 0 HP whose elimination has not yet been processed (#69). */
export function detectDeaths(state: GameState): PlayerState[] {
  return state
    .getPlayers()
    .filter((p) => p.castle.hp <= 0 && p.eliminatedAtTick === null);
}

/** Runs the elimination process for one kingdom (#70). */
export function eliminatePlayer(
  state: GameState,
  player: PlayerState,
  tick: number,
): void {
  player.castle.hp = 0;
  player.eliminated = true;
  player.eliminatedAtTick = tick;

  // Out of active gameplay: nothing pending may keep acting for or on them.
  player.statuses = [];
  player.modifiers = [];
  player.cooldowns = {};
  player.target = null;

  // Opponents aiming at the dead kingdom lose their target; the switch
  // cooldown is waived so they can immediately choose a new one.
  for (const other of state.getPlayers()) {
    if (other.id !== player.id && other.target === player.id) {
      other.target = null;
      other.targetSwitchReadyTick = tick;
    }
  }
}

/**
 * Tick-loop entry point: detects and processes all deaths this tick. Returns
 * the newly eliminated players so callers can emit events / end the match.
 */
export function processDeaths(match: Match): PlayerState[] {
  const state = match.gameState;
  if (!state) return [];
  const dead = detectDeaths(state);
  for (const player of dead) {
    eliminatePlayer(state, player, match.tick);
    // Gameplay event (#204): a kingdom has fallen.
    if (state.events.enabled) {
      state.events.emit({
        type: "eliminated",
        tick: match.tick,
        playerId: player.id,
      });
    }
  }
  return dead;
}
