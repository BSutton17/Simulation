import {
  CASTLE,
  CITIZENS,
  COMBAT,
  ECONOMY,
  SHIELD,
  TARGETING,
} from "../data/balance.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import { KINGDOM_PASSIVES } from "../data/kingdoms.js";
import type { AbilityDefinition } from "./abilities.js";
import type { StatusEffectDefinition } from "./status.js";

/**
 * Parameter catalog (ticket #202): enumerates every tunable gameplay value —
 * id plus its production base value — by walking the data registries. This is
 * how an optimizer discovers the search space WITHOUT knowing any kingdom or
 * ability by name: it sees opaque numeric parameters like
 * `ability.fireball.effects.0.amount`, never "Fire's damage".
 *
 * The ids here mirror the read sites exactly (parameters.ts documents the
 * scheme; abilities.ts / passives.ts / purchases.ts / economy.ts / damage.ts /
 * targeting.ts / matchConfig.ts consume them). New kingdoms, abilities, or
 * passives appear in the catalog automatically because this walks the same
 * data the engine executes.
 *
 * v1 scope note: upgrade-tier *effect* changes (a tier's effectParams deltas)
 * are not individually parameterized — base values are, and tiers layer on
 * top. Tier purchase costs ARE parameterized.
 */
export interface ParameterDescriptor {
  id: string;
  base: number;
}

function walkAbility(
  ability: AbilityDefinition,
  add: (id: string, base: number) => void,
): void {
  const id = ability.id;
  add(`ability.${id}.cost`, ability.cost);
  add(`ability.${id}.cooldownTicks`, ability.cooldownTicks);
  add(
    `ability.${id}.unlockCost`,
    ability.unlockCost ?? Math.ceil((ability.cost ?? 0) * 0.5),
  );

  if (ability.chargeSystem) {
    const c = ability.chargeSystem;
    add(`ability.${id}.charge.max`, c.max);
    add(`ability.${id}.charge.rechargeTicks`, c.rechargeTicks);
    add(`ability.${id}.charge.costPerCharge`, c.costPerCharge);
    c.damageByCharges.forEach((dmg, i) =>
      add(`ability.${id}.charge.damage.${i}`, dmg),
    );
  }

  ability.effects.forEach((effect, i) => {
    if (effect.chance !== undefined) {
      add(`ability.${id}.effects.${i}.chance`, effect.chance);
    }
    for (const [key, value] of Object.entries(effect.params)) {
      if (typeof value === "number") {
        add(`ability.${id}.effects.${i}.${key}`, value);
      }
    }
  });

  for (const tier of ability.upgradePath ?? []) {
    add(`ability.${id}.upgrade.${tier.level}.cost`, tier.cost);
  }
}

/** Every tunable parameter with its production base value. */
export function listParameters(): ParameterDescriptor[] {
  const out: ParameterDescriptor[] = [];
  const add = (id: string, base: number) => out.push({ id, base });

  // Global balance (data/balance.ts).
  add("economy.incomePerCitizen", ECONOMY.INCOME_PER_CITIZEN);
  add("economy.citizenCost", ECONOMY.CITIZEN_COST);
  add("economy.citizenCostGrowth", ECONOMY.CITIZEN_COST_GROWTH);
  add("citizens.startingCount", CITIZENS.STARTING_COUNT);
  add("castle.startingHp", CASTLE.STARTING_HP);
  add("castle.repairAmount", CASTLE.REPAIR_AMOUNT);
  add("castle.repairCost", CASTLE.REPAIR_COST);
  add("castle.repairCostGrowth", CASTLE.REPAIR_COST_GROWTH);
  add("castle.maxRepairs", CASTLE.MAX_REPAIRS);
  add("shield.cost", SHIELD.COST);
  add("shield.costGrowth", SHIELD.COST_GROWTH);
  add("shield.standardHp", SHIELD.STANDARD_HP);
  add("combat.baseCritChance", COMBAT.BASE_CRIT_CHANCE);
  add("combat.baseCritMultiplier", COMBAT.BASE_CRIT_MULTIPLIER);
  add("targeting.switchCooldownTicks", TARGETING.SWITCH_COOLDOWN_TICKS);

  // Every ability in the registry — damage, cooldowns, costs, durations,
  // healing, chances, charges, unlocks, upgrade prices.
  for (const ability of Object.values(ALL_ABILITIES)) {
    walkAbility(ability, add);
  }

  // Every kingdom passive's numeric fields.
  for (const [kingdomId, passives] of Object.entries(KINGDOM_PASSIVES)) {
    passives.forEach((passive, i) => {
      for (const [key, value] of Object.entries(passive)) {
        if (typeof value === "number") {
          add(`passive.${kingdomId}.${i}.${key}`, value);
        }
      }
    });
  }

  // Damage-over-time knobs: one tunable multiplier per status that ticks for
  // damage (Burn, Poison, …). A multiplier (default 1) so severity variants
  // that share a status id scale together. Reads through in status.ts.
  for (const id of statusesWithDoT()) {
    add(`status.${id}.tickDamage`, 1);
  }

  return out;
}

/** Ids of every status reachable from the ability/passive data that ticks for
 *  damage — the DoTs a designer can scale. Deduped by id (variants share it). */
function statusesWithDoT(): string[] {
  const seen = new Map<string, boolean>(); // id → has a damaging tickEffect
  const visit = (s: StatusEffectDefinition | undefined): void => {
    if (!s) return;
    const damages = (s.tickEffects ?? []).some((t) => t.type === "damage");
    // A variant with a DoT wins; never downgrade an already-flagged id.
    seen.set(s.id, (seen.get(s.id) ?? false) || damages);
    visit(s.onExpireStatus?.status);
    visit(s.onHitRetaliate?.status);
    for (const extra of s.onHitRetaliateExtra ?? []) visit(extra.status);
  };
  for (const ability of Object.values(ALL_ABILITIES)) {
    for (const effect of ability.effects) visit(effect.params.status);
    for (const tier of ability.upgradePath ?? []) {
      for (const ep of tier.changes.effectParams ?? []) visit(ep?.status ?? undefined);
      for (const ae of tier.changes.addEffects ?? []) visit(ae.params.status);
    }
  }
  for (const passives of Object.values(KINGDOM_PASSIVES)) {
    for (const p of passives) {
      if ("status" in p) visit(p.status as StatusEffectDefinition);
    }
  }
  return [...seen.entries()].filter(([, dot]) => dot).map(([id]) => id).sort();
}
