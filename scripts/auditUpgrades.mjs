import { register } from "tsx/esm/api";

/**
 * Finds upgrades that are DOWNGRADES.
 *
 *   node scripts/auditUpgrades.mjs
 *
 * An upgrade tier overrides a base value: more damage, a shorter cooldown, a
 * longer duration. The CMA-ES balance search rewrites the BASE figures but does
 * not touch the tier overrides, so a base can be pushed past the tier that was
 * meant to improve on it. The result is an ability you can pay gold to make
 * worse, which no test asserts globally and which reads as "balance" rather
 * than as the bug it is.
 *
 * Reports every tier whose override is not an improvement:
 *   - damage / shield / heal amounts that do not RISE above what they replace
 *   - cooldowns that do not FALL
 */

register();
const { ALL_ABILITIES } = await import("../src/data/abilitiesRegistry.ts");

const rows = [];

for (const ability of Object.values(ALL_ABILITIES)) {
  const path = ability.upgradePath ?? [];
  if (path.length === 0) continue;

  // Walk the tiers in order, tracking what each value currently is, so a tier
  // is judged against what it actually replaces rather than against the base.
  let amount = ability.effects?.[0]?.params?.amount;
  let cooldown = ability.cooldownTicks;

  for (const tier of path) {
    const nextAmount = tier.changes?.effectParams?.[0]?.amount;
    if (typeof nextAmount === "number" && typeof amount === "number") {
      if (nextAmount <= amount) {
        rows.push({
          ability: ability.id,
          level: tier.level,
          field: "amount",
          from: amount,
          to: nextAmount,
        });
      }
      amount = nextAmount;
    }

    const nextCd = tier.changes?.cooldownTicks;
    if (typeof nextCd === "number" && typeof cooldown === "number") {
      if (nextCd >= cooldown) {
        rows.push({
          ability: ability.id,
          level: tier.level,
          field: "cooldown",
          from: cooldown,
          to: nextCd,
        });
      }
      cooldown = nextCd;
    }
  }
}

const total = Object.values(ALL_ABILITIES).length;
console.log(`UPGRADE AUDIT — ${total} abilities\n`);

if (rows.length === 0) {
  console.log("  every upgrade tier improves on what it replaces");
  process.exit(0);
}

console.log(`  ${rows.length} tier(s) do NOT improve on what they replace:\n`);
console.log(
  `  ${"ability".padEnd(22)} ${"lv".padStart(2)}  ${"field".padEnd(8)} ${"replaces".padStart(9)} -> ${"becomes".padStart(9)}`,
);
for (const r of rows) {
  const worse = r.field === "cooldown" ? r.to > r.from : r.to < r.from;
  console.log(
    `  ${r.ability.padEnd(22)} ${String(r.level).padStart(2)}  ${r.field.padEnd(8)} ${String(r.from).padStart(9)} -> ${String(r.to).padStart(9)}  ${worse ? "WORSE" : "no change"}`,
  );
}

const strictlyWorse = rows.filter((r) =>
  r.field === "cooldown" ? r.to > r.from : r.to < r.from,
);
console.log(
  `\n  ${strictlyWorse.length} are strictly WORSE — gold spent to weaken the ability.`,
);
console.log(
  `  ${rows.length - strictlyWorse.length} are no-ops — gold spent for nothing.`,
);
process.exit(1);
