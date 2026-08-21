import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_ABILITIES } from "../src/data/abilitiesRegistry.js";

/**
 * An upgrade must never be a downgrade.
 *
 * ⚠️ THIS IS THE ONE PLACE THAT ASSERTS IT, deliberately. The per-kingdom suites
 * check that a tier RESOLVES — that `resolveAbility` applies the override at
 * all — because that is a mechanism each of them owns. Whether the resulting
 * number is an improvement is a property of the whole ability table, and
 * scattering it across sixteen files meant it was checked for whichever
 * abilities someone happened to think of.
 *
 * It was worth having in one place: at the time of writing, 43 of 80 abilities
 * fail it.
 *
 * HOW IT BREAKS. The CMA-ES balance search tunes base figures and upgrade-tier
 * overrides as INDEPENDENT parameters. Nothing in the search space ties a tier
 * to the value it replaces, so a base can be optimised straight past its own
 * upgrade — Fireball's damage tier resolves to 380 against a base of 441, and
 * its cooldown tier to 54 ticks against a base of 43. Both are worse. A player
 * who buys either has paid gold to weaken their ability.
 *
 * The durable fix belongs in the search, not here: tier parameters should be
 * expressed as deltas against their base, or clamped at decode so no candidate
 * can express an incoherent path. Until then this test is the alarm.
 *
 * `scripts/auditUpgrades.mjs` prints the same finding as a table.
 */

interface Offender {
  ability: string;
  level: number;
  field: "amount" | "cooldown";
  from: number;
  to: number;
}

function findDowngrades(): Offender[] {
  const offenders: Offender[] = [];

  for (const ability of Object.values(ALL_ABILITIES)) {
    const path = ability.upgradePath ?? [];
    if (path.length === 0) continue;

    // Each tier is judged against what it actually replaces — the value as of
    // the previous tier — rather than against the base, so a path that improves
    // in steps is not reported for its later steps.
    let amount = ability.effects?.[0]?.params?.amount as number | undefined;
    let cooldown: number | undefined = ability.cooldownTicks;

    for (const tier of path) {
      const nextAmount = tier.changes?.effectParams?.[0]?.amount;
      if (typeof nextAmount === "number" && typeof amount === "number") {
        if (nextAmount <= amount) {
          offenders.push({
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
          offenders.push({
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

  return offenders;
}

test("no upgrade tier is worse than the value it replaces", () => {
  const offenders = findDowngrades();

  const detail = offenders
    .map(
      (o) =>
        `  ${o.ability} Lv${o.level} ${o.field}: ${o.from} -> ${o.to}` +
        (o.field === "cooldown" ? " (longer)" : " (weaker)"),
    )
    .join("\n");

  assert.equal(
    offenders.length,
    0,
    `${offenders.length} upgrade tier(s) make the ability WORSE — gold spent to ` +
      `weaken it. This is balance data, not test drift; fix the ability tables ` +
      `or constrain the search that writes them.\n${detail}`,
  );
});

test("every ability that offers upgrades actually changes something per tier", () => {
  // A tier that overrides nothing is gold for no effect. Distinct from the
  // check above, which is about the DIRECTION of a change that does happen.
  const inert: string[] = [];

  for (const ability of Object.values(ALL_ABILITIES)) {
    for (const tier of ability.upgradePath ?? []) {
      const changes = tier.changes ?? {};
      const touchesSomething = Object.keys(changes).length > 0;
      if (!touchesSomething) inert.push(`${ability.id} Lv${tier.level}`);
    }
  }

  assert.deepEqual(inert, [], `tiers that change nothing: ${inert.join(", ")}`);
});
