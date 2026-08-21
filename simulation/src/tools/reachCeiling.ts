import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { resolveAbility } from "../../../src/engine/abilities.js";

/**
 * The ceiling on ability coverage, before a single match is played.
 *
 *   npx tsx simulation/src/tools/reachCeiling.ts
 *
 * ⚠️ 80/80 IS NOT NECESSARILY AVAILABLE, and that has to be established before a
 * search is pointed at it. `legality.ts` refuses a cast whose payload the 22
 * action heads cannot express — `targeting.secondTarget`, or a `choices` menu.
 * That refusal is structural. It does not consult cost, damage, or cooldown, so
 * no balance candidate can lift it and a fitness term that rewards casting such
 * an ability is rewarding something unattainable.
 *
 * Everything else is gated by things a balance search DOES control — price,
 * cooldown, charge rate — or by a meter or a board slot that play can satisfy.
 *
 * The split gives the real target. Aiming a campaign at 80/80 when the action
 * space caps it lower means burning the whole budget on the gap.
 */

type Bucket = "unsupported" | "meter" | "charges" | "centrepiece" | "economic";

const reasons = new Map<Bucket, string[]>([
  ["unsupported", []],
  ["meter", []],
  ["charges", []],
  ["centrepiece", []],
  ["economic", []],
]);

let total = 0;

for (const kingdomId of KINGDOM_IDS) {
  for (const ability of abilitiesForKingdom(kingdomId)) {
    total += 1;
    // Resolved at tier 0: the shipped shape, which is what legality sees for an
    // ability nobody has upgraded.
    const a = resolveAbility(ability, 0) as unknown as {
      id: string;
      targeting?: { secondTarget?: boolean; choices?: unknown };
      chargeSystem?: unknown;
      meter?: unknown;
      requiresMeter?: unknown;
      centrepiece?: unknown;
    };
    const label = `${kingdomId}/${a.id}`;

    if (a.targeting?.secondTarget === true || a.targeting?.choices !== undefined) {
      reasons.get("unsupported")!.push(
        `${label}  (${a.targeting?.secondTarget === true ? "needs a second target" : "needs a declared choice"})`,
      );
      continue;
    }
    if (a.meter !== undefined || a.requiresMeter !== undefined) {
      reasons.get("meter")!.push(label);
      continue;
    }
    if (a.centrepiece !== undefined) {
      reasons.get("centrepiece")!.push(label);
      continue;
    }
    if (a.chargeSystem !== undefined) {
      reasons.get("charges")!.push(label);
      continue;
    }
    reasons.get("economic")!.push(label);
  }
}

const unsupported = reasons.get("unsupported")!;
console.log(`ABILITY REACH CEILING — ${total} abilities\n`);
console.log(
  `  reachable by a balance change   ${total - unsupported.length}/${total}`,
);
console.log(
  `  structurally out of reach       ${unsupported.length}  (the action space cannot express the cast)\n`,
);

if (unsupported.length > 0) {
  console.log(`  The action space refuses these regardless of balance:`);
  for (const line of unsupported) console.log(`    ${line}`);
}

for (const [bucket, list] of reasons) {
  if (bucket === "unsupported" || list.length === 0) continue;
  console.log(`\n  gated by ${bucket} (${list.length}) — play can satisfy these:`);
  for (const line of list.slice(0, 12)) console.log(`    ${line}`);
  if (list.length > 12) console.log(`    …and ${list.length - 12} more`);
}

console.log(
  `\n  => the honest target for a usage campaign is ` +
    `${total - unsupported.length}/${total}, not ${total}/${total}.`,
);
