import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import { KINGDOM_PASSIVES } from "../../src/data/kingdoms.js";

/**
 * Human-readable names for balance-parameter ids (reporting only). The optimizer
 * still works on opaque ids from the catalog; this purely turns
 * `ability.fireball.effects.0.amount` into "Fireball Damage" for the progress
 * console and reports. It stays kingdom/ability-agnostic by reading display
 * names from the same data registries the engine uses — nothing is hardcoded
 * per kingdom.
 */

/** Fixed labels for the global engine constants (data/balance.ts). */
const GLOBAL_LABELS: Record<string, string> = {
  "economy.incomePerCitizen": "Income per Citizen",
  "economy.citizenCost": "Citizen Cost",
  "economy.citizenCostGrowth": "Citizen Cost Growth",
  "citizens.startingCount": "Starting Citizens",
  "castle.startingHp": "Castle Starting HP",
  "castle.repairAmount": "Repair Heal",
  "castle.repairCost": "Repair Cost",
  "castle.repairCostGrowth": "Repair Cost Growth",
  "castle.maxRepairs": "Max Repairs",
  "shield.cost": "Shield Cost",
  "shield.standardHp": "Shield HP",
  "combat.baseCritChance": "Crit Chance",
  "combat.baseCritMultiplier": "Crit Multiplier",
  "targeting.switchCooldownTicks": "Target Switch Cooldown",
};

/** Friendly names for an ability effect's numeric fields. */
const EFFECT_FIELD_LABELS: Record<string, string> = {
  amount: "Damage",
  chance: "Chance",
  durationTicks: "Duration",
  percentMaxHp: "Heal %",
  citizensPercent: "Citizen Gain %",
  citizensFlat: "Citizen Gain",
  modifierTicks: "Effect Duration",
  extraAmount: "Bonus Damage",
};

/** "camelCase.dotted_id" → "Camel Case Dotted Id". */
function titleCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function abilityName(id: string): string {
  return ALL_ABILITIES[id]?.name ?? titleCase(id);
}

/** Turns a catalog parameter id into a short designer-facing label. */
export function describeParameter(id: string): string {
  const global = GLOBAL_LABELS[id];
  if (global) return global;

  const parts = id.split(".");

  if (parts[0] === "ability") {
    const name = abilityName(parts[1] ?? "");
    const rest = parts.slice(2);
    switch (rest[0]) {
      case "cost":
        return `${name} Cost`;
      case "cooldownTicks":
        return `${name} Cooldown`;
      case "unlockCost":
        return `${name} Unlock Cost`;
      case "charge":
        if (rest[1] === "max") return `${name} Max Charges`;
        if (rest[1] === "rechargeTicks") return `${name} Charge Recharge`;
        if (rest[1] === "costPerCharge") return `${name} Cost per Charge`;
        if (rest[1] === "damage") return `${name} Charge ${Number(rest[2]) + 1} Damage`;
        return `${name} ${titleCase(rest.slice(1).join(" "))}`;
      case "effects": {
        const field = rest[2] ?? "";
        return `${name} ${EFFECT_FIELD_LABELS[field] ?? titleCase(field)}`;
      }
      case "upgrade":
        return `${name} Upgrade ${rest[1]} Cost`;
      default:
        return `${name} ${titleCase(rest.join(" "))}`;
    }
  }

  if (parts[0] === "passive") {
    const kingdomId = parts[1] ?? "";
    const passive = KINGDOM_PASSIVES[kingdomId as keyof typeof KINGDOM_PASSIVES]?.[
      Number(parts[2])
    ];
    const kingdom = titleCase(kingdomId);
    // The passive's `type` carries the meaning (e.g. incomePerCitizen); the
    // numeric field is usually just "amount"/"pct", so only append a field
    // name when it adds information.
    const typeLabel = passive ? titleCase(passive.type) : "Passive";
    const field = parts[3] ?? "";
    if (field === "amount" || field === "pct") return `${kingdom} ${typeLabel}`;
    return `${kingdom} ${typeLabel} ${titleCase(field)}`;
  }

  return titleCase(id);
}
