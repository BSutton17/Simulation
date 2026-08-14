import { computeStat } from "./modifiers.js";
import { perkCooldownMultiplier } from "./perks.js";
import type { GameState } from "../match/GameState.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Reusable cooldown engine (ticket #46). Each ability's cooldown is tracked
 * independently in a player's `cooldowns` map (remaining ticks). Any ability can
 * be put on cooldown, queried, and every cooldown is advanced together each
 * tick — with each ability decremented independently.
 */

/** Puts an ability on cooldown for `ticks`. A value ≤ 0 clears it (ready). */
export function setCooldown(
  player: PlayerState,
  abilityId: string,
  ticks: number,
): void {
  if (ticks <= 0) {
    delete player.cooldowns[abilityId];
    return;
  }

  // Apply cooldown modifiers via computeStat (ticket #107): the global
  // "cooldown" stat, then the per-ability "cooldown:<id>" stat (Epic 10,
  // e.g. Thundering Fate zeroing Zap's cooldown for a window).
  // "Extra Repairs" shortens every cooldown, stacking with the modifier chain
  // and with Electricity's "Don't Blink" attack-cooldown passive.
  let effectiveTicks = Math.round(
    computeStat(player, `cooldown:${abilityId}`, computeStat(player, "cooldown", ticks)) *
      perkCooldownMultiplier(player),
  );

  // Cooldown reduction immunity (ticket #107)
  if (effectiveTicks < ticks) {
    const isImmune = computeStat(player, "cooldownReductionImmune", 0) > 0;
    if (isImmune) {
      effectiveTicks = ticks;
    }
  }

  if (effectiveTicks <= 0) {
    delete player.cooldowns[abilityId];
  } else {
    player.cooldowns[abilityId] = effectiveTicks;
  }
}

/** Remaining cooldown ticks for an ability (0 if ready). */
export function getCooldown(player: PlayerState, abilityId: string): number {
  return player.cooldowns[abilityId] ?? 0;
}

/** Whether an ability is off cooldown and usable. */
export function isReady(player: PlayerState, abilityId: string): boolean {
  return getCooldown(player, abilityId) <= 0;
}

/**
 * Advances every player's ability cooldowns by one tick, decrementing each
 * independently and clearing any that reach zero.
 */
export function tickCooldowns(state: GameState): void {
  const bus = state.events;
  for (const player of state.getPlayers()) {
    // Kitsune Rush runs every cooldown at double speed, INCLUDING ones already
    // counting down — "twice as fast" would be a hollow promise if it only
    // applied to cooldowns armed after the cast. A rate of 0.5 means each tick
    // burns two ticks of cooldown.
    const rate = Math.max(0.01, computeStat(player, "cooldownRate", 1));
    const step = 1 / rate;
    for (const abilityId of Object.keys(player.cooldowns)) {
      const remaining = player.cooldowns[abilityId] - step;
      if (remaining <= 0) {
        delete player.cooldowns[abilityId];
        // Gameplay event (#204): the ability is ready again.
        if (bus.enabled) {
          bus.emit({
            type: "cooldownReady",
            tick: state.tick,
            playerId: player.id,
            abilityId,
          });
        }
      } else {
        player.cooldowns[abilityId] = remaining;
      }
    }
  }
}

/**
 * Advances charge regeneration (Lightning Barrage, Epic 10). Each spent
 * charge is an independent countdown in `player.recharges[abilityId]`; when
 * a timer reaches zero that charge is available again.
 */
export function tickRecharges(state: GameState): void {
  const bus = state.events;
  for (const player of state.getPlayers()) {
    for (const abilityId of Object.keys(player.recharges)) {
      const timers = player.recharges[abilityId]!;
      const remaining = timers.map((t) => t - 1).filter((t) => t > 0);
      const regenerated = timers.length - remaining.length;
      if (remaining.length === 0) {
        delete player.recharges[abilityId];
      } else {
        player.recharges[abilityId] = remaining;
      }
      // Gameplay event (#204): charges finished regenerating this tick.
      if (regenerated > 0 && bus.enabled) {
        bus.emit({
          type: "chargeReady",
          tick: state.tick,
          playerId: player.id,
          abilityId,
          regenerated,
        });
      }
    }
  }
}
