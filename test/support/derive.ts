import assert from "node:assert/strict";
import { resolveAbility, type AbilityDefinition } from "../../src/engine/abilities.js";

/**
 * Expectations derived from the ability data, instead of typed into the test.
 *
 * ⚠️ WHY THIS EXISTS. The kingdom test-suites asserted concrete damage figures —
 * `maxHp - 250`, `5 hits of 100` — which made every one of them a test of the
 * BALANCE DATA as much as of the mechanic it was named for. The CMA-ES balance
 * search rewrites that data wholesale: one apply moved A Light Breeze 250 -> 170
 * -> 238 and Meteor Shower 100 -> 85 per hit, and ninety-six tests failed at
 * once without a single mechanical fault among them.
 *
 * Ninety-six red tests that mean nothing are worse than no tests, because the
 * real regression they were meant to catch now hides in the noise.
 *
 * So: read the figure from the definition, and assert the MECHANIC around it —
 * that damage splits across targets, that five hits land rather than one, that
 * a tier override actually applies. Those claims are what the files are named
 * for, and they survive the next balance apply.
 */

/** The damage an ability's damage effect carries as shipped. */
export function baseDamage(ability: AbilityDefinition): number {
  const effect = ability.effects.find((e) => e.type === "damage");
  assert.ok(effect, `${ability.id} has no damage effect to read`);
  return effect.params.amount as number;
}

/**
 * The damage the upgrade path DECLARES at `level` — the latest tier at or below
 * it that overrides the damage effect, or the base figure if none does.
 *
 * Asserting against this is what keeps an upgrade test about RESOLUTION: that
 * `resolveAbility` applies the override at all, not which number it lands on.
 */
export function declaredDamage(ability: AbilityDefinition, level: number): number {
  let amount = baseDamage(ability);
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) break;
    const override = tier.changes.effectParams?.[0]?.amount;
    if (typeof override === "number") amount = override;
  }
  return amount;
}

/** As `declaredDamage`, for a cooldown a tier overrides. */
export function declaredCooldown(ability: AbilityDefinition, level: number): number {
  let ticks = ability.cooldownTicks;
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) break;
    if (typeof tier.changes.cooldownTicks === "number") ticks = tier.changes.cooldownTicks;
  }
  return ticks;
}

/**
 * What each of `n` kingdoms takes when a multi-target attack spreads over them.
 *
 * The engine divides the LISTED damage before resolving and rounds once, so the
 * order is reproduced here rather than dividing an already-rounded total.
 */
export function spread(ability: AbilityDefinition, n: number): number {
  return Math.round(baseDamage(ability) / n);
}

/** The value a named param of an ability's first matching effect carries. */
export function effectParam<T = number>(
  ability: AbilityDefinition,
  key: string,
  level = 0,
): T {
  const resolved = level > 0 ? resolveAbility(ability, level) : ability;
  for (const e of resolved.effects) {
    const v = (e.params as Record<string, unknown>)?.[key];
    if (v !== undefined) return v as T;
  }
  throw new Error(`${ability.id} has no effect carrying "${key}"`);
}

/**
 * The amount the upgrade path declares at `level` for the FIRST effect,
 * whatever its type.
 *
 * `declaredDamage` deliberately refuses an ability with no damage effect, which
 * catches a test reaching for the wrong ability. Shields, heals and buffs still
 * carry an `amount` a tier can override, and Brick Wall is one — so they need a
 * reader that does not insist on damage.
 */
export function declaredAmount(ability: AbilityDefinition, level: number): number {
  let amount = ability.effects[0]?.params?.amount as number;
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) break;
    const override = tier.changes.effectParams?.[0]?.amount;
    if (typeof override === "number") amount = override;
  }
  return amount;
}
