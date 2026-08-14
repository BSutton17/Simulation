import type { Match } from "../match/Match.js";
import { idleRegenSpec } from "./passives.js";
import { healCastle } from "./abilities.js";
import { TICK } from "../data/balance.js";
import { param } from "./parameters.js";

/**
 * Insects' "Fruit Fly".
 *
 * A kingdom that nobody has touched for a while starts closing its own wounds.
 * It is a reward for being nobody's problem — and, read the other way, a reason
 * to spend an attack on the kingdom quietly sitting in the corner rather than
 * letting it heal back to full for free.
 *
 * Deliberately keyed off damage TAKEN rather than off combat generally: an
 * Insects player can attack all it likes and keep healing. What stops the
 * regeneration is being hit, from any source — a burn tick suppresses it
 * exactly as a direct hit does (see `applyDamage`, which stamps the marker for
 * every kind of damage there is).
 */
export function regenerateIdleKingdoms(match: Match): void {
  const state = match.gameState;
  if (!state) return;

  for (const player of state.getPlayers()) {
    if (player.eliminated) continue;
    const spec = idleRegenSpec(player);
    if (!spec) continue;

    // Never hit yet (-1) counts as idle since the match began: a kingdom left
    // alone from the opening bell should not have to be hit once to unlock it.
    const since = state.tick - (player.lastDamageTakenTick >= 0 ? player.lastDamageTakenTick : 0);
    if (since < spec.idleTicks) continue;

    // Already whole — nothing to do, and no rounding to burn.
    if (player.castle.hp >= player.castle.maxHp) continue;

    // A per-SECOND rate spread across the tick, so the heal is smooth rather
    // than a visible pulse once a second.
    const perTick =
      (player.castle.maxHp * spec.pctPerSecond) / param("tick.rate", TICK.RATE);
    // Fractions are carried between ticks; without this a small per-tick figure
    // would round to zero every tick and the passive would do nothing at all.
    player.regenCarry += perTick;
    const whole = Math.floor(player.regenCarry);
    if (whole <= 0) continue;
    player.regenCarry -= whole;

    const healed = healCastle(player, whole);
    if (healed > 0 && state.events.enabled) {
      state.events.emit({
        type: "heal",
        tick: state.tick,
        targetId: player.id,
        amount: healed,
        overheal: whole - healed,
        cause: "passive:fruitFly",
      });
    }
  }
}
