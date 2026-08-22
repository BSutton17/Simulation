import { readFileSync } from "node:fs";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { runHeadlessMatch } from "../headless.js";
import { NetworkController } from "../ai/index.js";
import { buildNetwork } from "../neat/index.js";
import { buildValidationSlate, type SlateScenario } from "../training/slate.js";
import { personalityAI } from "../personality.js";
import { PERSONALITIES } from "../personalities.js";
import type { PlayerSpec } from "../types.js";

/**
 * Why does an ability the seat OWNS never get cast?
 *
 *   npx tsx simulation/src/tools/whyUnused.ts <champion.json>
 *
 * ⚠️ FOUR PROBLEMS WEAR ONE LABEL, and each wants a different fix:
 *
 *   CANNOT AFFORD  — owned, but never enough gold at a decision. A cast-price
 *     change reaches this.
 *   ON COOLDOWN    — ready too rarely to matter. A cooldown change reaches it.
 *   GATED          — a meter, a charge, a status ban, the centrepiece. Play has
 *     to satisfy these; balance mostly cannot.
 *   DECLINED       — legal, affordable, ready, and passed over anyway. Nothing
 *     in the data files reaches this. It is the policy's judgement.
 *
 * The measurement exists because the last two diagnoses of this were guesses,
 * and both were wrong: the abilities turned out to be unlocked after all, and
 * the AI simply was not using them.
 */

const [, , modelPath] = process.argv;
if (!modelPath) {
  console.error("usage: whyUnused <champion.json>");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

interface Row {
  owned: number;
  cast: number;
  legal: number;
  declined: number;
  cannotAfford: number;
  cooldown: number;
  charges: number;
  meter: number;
  status: number;
  noTarget: number;
}

const rows = new Map<string, Row>();
const blank = (): Row => ({
  owned: 0, cast: 0, legal: 0, declined: 0, cannotAfford: 0,
  cooldown: 0, charges: 0, meter: 0, status: 0, noTarget: 0,
});

const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
  maxTicks: 6000,
  seedsPerScenario: 2,
});

for (const s of slate.scenarios as SlateScenario[]) {
  let controller: NetworkController | null = null;
  let self: { unlocked: Record<string, boolean> } | null = null;
  const seats: PlayerSpec[] = [];
  let opp = 0;
  for (let i = 0; i < s.seats; i++) {
    if (i === s.candidateSeat) {
      seats.push({
        kingdomId: s.candidateKingdom,
        name: "cand",
        ai: (p, rng) => {
          self = p as never;
          controller = new NetworkController(p, { network, rng, difficulty: "hard" });
          return controller;
        },
      });
    } else {
      const profile = PERSONALITIES[s.opponentProfiles[opp]! as keyof typeof PERSONALITIES];
      seats.push({
        kingdomId: s.opponentKingdoms[opp]!,
        name: `o${opp}`,
        ai: personalityAI(profile as never),
      });
      opp += 1;
    }
  }

  runHeadlessMatch({
    players: seats, seed: s.seed, maxTicks: s.maxTicks,
    createAI: seats[0]!.ai!, telemetry: false,
  });
  if (!controller || !self) continue;

  const kit = abilitiesForKingdom(s.candidateKingdom).filter((a) => a.kind !== "passive");
  const st = (controller as NetworkController).stats;
  const owner = self as { unlocked: Record<string, boolean> };

  for (let slot = 0; slot < kit.length; slot++) {
    const id = `${s.candidateKingdom}/${kit[slot]!.id}`;
    const r = rows.get(id) ?? blank();
    // Only matches where the seat actually ENDED UP owning it: an ability it
    // never bought is a different question, answered by whyLocked.ts.
    if (owner.unlocked[kit[slot]!.id]) r.owned += 1;
    r.cast += st.castChosen[slot] ?? 0;
    r.legal += st.castLegal[slot] ?? 0;
    r.declined += st.castDeclined[slot] ?? 0;
    r.cannotAfford += st.castBlockedNotAffordable[slot] ?? 0;
    r.cooldown += st.castBlockedCooldown[slot] ?? 0;
    r.charges += st.castBlockedCharges[slot] ?? 0;
    r.meter += st.castBlockedMeter[slot] ?? 0;
    r.status += st.castBlockedStatus[slot] ?? 0;
    r.noTarget += st.castBlockedNoTarget[slot] ?? 0;
    rows.set(id, r);
  }
}

/** The dominant reason this ability sat idle. */
function verdict(r: Row): string {
  if (r.owned === 0) return "never bought";
  // Legal and passed over is the finding that matters most, so it is tested
  // first: an ability can be blocked often AND still be declined whenever it is
  // available, and the second fact is the one balance cannot fix.
  if (r.legal > 0 && r.cast === 0) return "DECLINED (legal, never chosen)";
  const blocked: Array<[string, number]> = [
    ["cannot afford", r.cannotAfford],
    ["on cooldown", r.cooldown],
    ["no charges", r.charges],
    ["meter not ready", r.meter],
    ["status/centrepiece", r.status],
    ["no legal target", r.noTarget],
  ];
  blocked.sort((a, b) => b[1] - a[1]);
  if (r.legal === 0) return `never legal — ${blocked[0]![0]}`;
  return `used (${r.cast} casts)`;
}

const idle = [...rows.entries()].filter(([, r]) => r.owned > 0 && r.cast === 0);
const used = [...rows.entries()].filter(([, r]) => r.cast > 0);

console.log(`WHY OWNED ABILITIES GO UNUSED — ${modelPath}\n`);
console.log(`  owned and used     ${used.length}`);
console.log(`  owned and IDLE     ${idle.length}\n`);

const declined = idle.filter(([, r]) => r.legal > 0);
const blockedOut = idle.filter(([, r]) => r.legal === 0);

console.log(`  Of the idle ones:`);
console.log(`    DECLINED        ${declined.length}  legal at some point, never chosen — balance cannot fix these`);
console.log(`    NEVER LEGAL     ${blockedOut.length}  something kept them unavailable\n`);

if (declined.length > 0) {
  console.log(`  Declined despite being castable:`);
  console.log(`    ${"ability".padEnd(30)} ${"legal on".padStart(9)} ${"passed over".padStart(12)}`);
  for (const [id, r] of declined.sort((a, b) => b[1].legal - a[1].legal)) {
    console.log(`    ${id.padEnd(30)} ${String(r.legal).padStart(9)} ${String(r.declined).padStart(12)}`);
  }
}
if (blockedOut.length > 0) {
  console.log(`\n  Never legal while owned:`);
  for (const [id, r] of blockedOut) console.log(`    ${id.padEnd(30)} ${verdict(r)}`);
}

const totalDeclines = declined.reduce((n, [, r]) => n + r.legal, 0);
console.log(
  `\n  => ${
    declined.length >= blockedOut.length
      ? `THE POLICY'S JUDGEMENT. ${declined.length} owned abilities were castable ` +
        `${totalDeclines} times between them and never chosen once.`
      : "AVAILABILITY. Most idle abilities were never castable in the first place."
  }`,
);
