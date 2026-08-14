import { DARK } from "../data/balance.js";
import { param } from "./parameters.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Damage application pipeline (tickets #65–#66). Takes an already-computed
 * incoming damage amount (see the damage engine, `computeIncomingDamage`) and
 * applies it to a target castle in the authoritative order:
 *
 *   1. Shields absorb first (#65) — the castle's shield pool soaks damage before
 *      any reaches HP, unless the hit explicitly `ignoreShields`.
 *   2. Overflow hits castle HP (#66) — whatever the shields did not absorb
 *      reduces `castle.hp`, clamped at 0. Reaching 0 eliminates the castle
 *      (DATA_MODELS.md §9: hp is clamped to [0, maxHp]; 0 ⇒ eliminated).
 *
 * Pure aside from mutating the target's castle/elimination state; returns a
 * breakdown so callers can drive sync/events. Already-eliminated castles and
 * non-positive damage are safe no-ops.
 */

export interface DamageOptions {
  /** If set, the hit bypasses shields and applies directly to castle HP. */
  ignoreShields?: boolean;
  /** Current match tick — recorded when this hit breaks the shield, so the
   *  buy-shield break cooldown can be enforced. */
  tick?: number;
  /**
   * The hit spends itself entirely on the shield: whatever the shield cannot
   * absorb is DISCARDED rather than carrying over to castle HP (Kitsune's "Old
   * Friends" against a shielded kingdom). With no shield up it does nothing at
   * all — which is what makes it a different move from an ordinary attack.
   */
  shieldOnly?: boolean;
}

export interface DamageApplication {
  /** Incoming damage after clamping to a non-negative integer. */
  incoming: number;
  /** How much the shield pool absorbed. */
  absorbedByShield: number;
  /** How much castle HP was actually lost. */
  dealtToHp: number;
  /** Shield pool remaining after absorption. */
  shieldRemaining: number;
  /** Castle HP remaining after the hit. */
  hpRemaining: number;
  /** True only if this hit reduced the castle from alive to 0 HP. */
  eliminated: boolean;
}

export function applyDamage(
  target: PlayerState,
  incoming: number,
  options: DamageOptions = {},
): DamageApplication {
  const amount = Math.max(0, Math.round(incoming));

  const noop = (): DamageApplication => ({
    incoming: amount,
    absorbedByShield: 0,
    dealtToHp: 0,
    shieldRemaining: target.castle.shield,
    hpRemaining: target.castle.hp,
    eliminated: false,
  });

  // Nothing to do for a dead castle or a harmless hit.
  if (target.eliminated || amount === 0) return noop();

  let remaining = amount;

  // 1. Shields absorb first (#65), unless the attack ignores them.
  let absorbedByShield = 0;
  if (!options.ignoreShields && target.castle.shield > 0) {
    absorbedByShield = Math.min(target.castle.shield, remaining);
    target.castle.shield -= absorbedByShield;
    remaining -= absorbedByShield;
    // Shield just shattered: start the buy-shield break cooldown.
    if (target.castle.shield === 0 && options.tick !== undefined) {
      target.castle.shieldBrokenAtTick = options.tick;
    }
  }

  // 2. Remaining damage hits castle HP (#66), clamped at 0 — unless the hit
  // was spent on the shield, in which case the remainder is simply lost.
  const dealtToHp = options.shieldOnly ? 0 : Math.min(target.castle.hp, remaining);
  target.castle.hp -= dealtToHp;

  // Rage (Dark's Unlimited Rage) charges off punishment taken, whatever its
  // source — attacks, DoT ticks, a Black Hole dump. This is the one place all
  // damage funnels through, so charging here catches every one of them without
  // each system having to remember. Tracked for everyone; only Dark reads it.
  const taken = absorbedByShield + dealtToHp;
  if (taken > 0) {
    // Read through the parameter gate, exactly as the cast check in
    // abilities.ts does. Capping with the raw constant while the cast gate
    // honoured an override meant a raised threshold could never be reached.
    const rageFull = param("dark.rageFull", DARK.RAGE_FULL);
    target.rageMeter = Math.min(rageFull, target.rageMeter + taken);
    // Insects' "Fruit Fly" heals only once this is far enough behind the
    // current tick. Stamped in the same place Rage charges, so EVERY source of
    // damage resets it — a DoT tick has to keep the regeneration suppressed
    // just as a direct hit does, or a burn would be free healing time.
    if (options.tick !== undefined) target.lastDamageTakenTick = options.tick;
  }

  // Kitsune's "Swift Tails" charges off damage DEALT. `applyDamage` only knows
  // the victim, so the attacker's share is credited by `creditAncientMemory`
  // from the call sites that know who swung — see resolveDamage.

  const eliminated = target.castle.hp <= 0;
  if (eliminated) {
    target.castle.hp = 0;
    target.eliminated = true;
  }

  return {
    incoming: amount,
    absorbedByShield,
    dealtToHp,
    shieldRemaining: target.castle.shield,
    hpRemaining: target.castle.hp,
    eliminated,
  };
}
