import type { GameState } from "../match/GameState.js";
import type { Modifier, PlayerState } from "../match/playerState.js";
import { evaluateCondition } from "./conditions.js";

/**
 * Buff/debuff modifier system (ticket #48): temporary bonuses and penalties to
 * named player statistics. Reusable across systems — economy (income), combat
 * (damage), cooldowns, etc. compute effective values via `computeStat`.
 *
 * Effective stat = (base + Σ add) × Π mult.
 */

export function addModifier(player: PlayerState, modifier: Modifier): void {
  player.modifiers.push(modifier);
}

/** Removes a modifier by its instance id. Returns true if one was removed. */
export function removeModifier(player: PlayerState, id: string): boolean {
  const before = player.modifiers.length;
  player.modifiers = player.modifiers.filter((m) => m.id !== id);
  return player.modifiers.length < before;
}

/** Removes all modifiers applied by a given source (e.g. when it expires). */
export function removeModifiersFromSource(
  player: PlayerState,
  sourceId: string,
): number {
  const before = player.modifiers.length;
  player.modifiers = player.modifiers.filter((m) => m.sourceId !== sourceId);
  return before - player.modifiers.length;
}

/** Computes the effective value of a stat after applying its modifiers. */
export function computeStat(
  player: PlayerState,
  stat: string,
  base: number,
  opponent?: PlayerState,
  role: "caster" | "target" = "target",
  element?: string,
  // When false, do not spend usage-limited modifiers — for speculative reads
  // (e.g. the sim AI estimating a hit) that must not mutate game state.
  consume = true,
): number {
  let flat = base;
  let multiplier = 1;
  const expiredIds: string[] = [];

  for (const m of player.modifiers) {
    if (m.stat !== stat) continue;
    if (m.conditions) {
      const caster = role === "caster" ? player : (opponent ?? player);
      const target = role === "target" ? player : (opponent ?? player);
      const allMet = m.conditions.every((c) =>
        evaluateCondition(c, caster, target, element),
      );
      if (!allMet) continue;
    }

    if (m.op === "add") flat += m.value;
    else multiplier *= m.value;

    // Handle usage limits (ticket #103)
    if (consume && m.usageLimit !== undefined) {
      m.usageLimit -= 1;
      if (m.usageLimit <= 0) {
        expiredIds.push(m.id);
      }
    }
  }

  // Clean up usage-limited modifiers that expired (ticket #103)
  if (expiredIds.length > 0) {
    player.modifiers = player.modifiers.filter(
      (m) => !expiredIds.includes(m.id),
    );
  }

  return flat * multiplier;
}

/** Advances modifier durations by one tick, removing any that have expired. */
export function tickModifiers(state: GameState): void {
  for (const player of state.getPlayers()) {
    player.modifiers = player.modifiers.filter((m) => {
      if (m.remainingTicks === null) return true;
      m.remainingTicks -= 1;
      return m.remainingTicks > 0;
    });
  }
}

/** Resolves targeting redirection from modifiers (ticket #109). */
export function getTargetingRedirect(
  target: PlayerState,
  attacker: PlayerState,
): string | null {
  for (const m of target.modifiers) {
    if (m.stat === "redirectTarget") {
      if (m.conditions) {
        const allMet = m.conditions.every((c) =>
          evaluateCondition(c, target, target),
        );
        if (!allMet) continue;
      }
      if (m.stringValue === "attacker") {
        return attacker.id;
      }
      return m.stringValue ?? null;
    }
  }
  return null;
}
