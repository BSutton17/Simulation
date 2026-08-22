import { readFileSync } from "node:fs";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { runHeadlessMatch } from "../headless.js";
import { NetworkController } from "../ai/index.js";
import { buildNetwork } from "../neat/index.js";
import { buildValidationSlate, type SlateScenario } from "../training/slate.js";
import { personalityAI } from "../personality.js";
import { PERSONALITIES } from "../personalities.js";
import type { PlayerSpec } from "../types.js";

/**
 * Where does the money go, and why is peak liquidity only ~253?
 *
 *   npx tsx simulation/src/tools/economyFlow.ts <champion.json>
 *
 * ⚠️ PEAK LIQUIDITY IS A BEHAVIOUR, NOT JUST AN INCOME RATE. A seat that spends
 * every coin the tick it arrives holds a low peak however fast gold comes in,
 * and a seat whose spending is capped by cooldowns banks the surplus whether it
 * means to or not. Those two want opposite fixes — the first needs the policy
 * to save, the second needs more income — and a single "peak gold" number
 * cannot tell them apart.
 *
 * So this reports the FLOW: what was earned, what was spent and on what, and
 * how much of the match was spent holding enough to afford the kit's dearest
 * ability. That last figure is the one that decides whether an expensive
 * ability is reachable at all.
 */

const [, , modelPath] = process.argv;
if (!modelPath) {
  console.error("usage: economyFlow <champion.json>");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

interface Flow {
  matches: number;
  earned: number;
  spentCitizens: number;
  spentAbilities: number;
  spentUnlocks: number;
  spentOther: number;
  peak: number;
  ticks: number;
}

const flow: Flow = {
  matches: 0, earned: 0, spentCitizens: 0, spentAbilities: 0,
  spentUnlocks: 0, spentOther: 0, peak: 0, ticks: 0,
};

const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
  maxTicks: 6000,
  seedsPerScenario: 1,
});

for (const s of (slate.scenarios as SlateScenario[]).slice(0, 80)) {
  let self: { id: string; economy: { currency: number } } | null = null;
  const seats: PlayerSpec[] = [];
  let opp = 0;
  for (let i = 0; i < s.seats; i++) {
    if (i === s.candidateSeat) {
      seats.push({
        kingdomId: s.candidateKingdom,
        name: "cand",
        ai: (p, rng) => {
          self = p as never;
          return new NetworkController(p, { network, rng, difficulty: "hard" });
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

  let peak = 0;
  let spentCitizens = 0;
  let spentAbilities = 0;
  let spentUnlocks = 0;
  let spentOther = 0;

  const record = runHeadlessMatch({
    players: seats,
    seed: s.seed,
    maxTicks: s.maxTicks,
    createAI: seats[0]!.ai!,
    telemetry: false,
    observers: [
      {
        onEvent: (e: {
          type: string;
          playerId?: string;
          casterId?: string;
          kind?: string;
          cost?: number;
        }) => {
          if (!self) return;
          peak = Math.max(peak, self.economy.currency);
          if (e.type === "purchase" && e.playerId === self.id) {
            const cost = e.cost ?? 0;
            if (e.kind === "citizen") spentCitizens += cost;
            else if (e.kind === "unlock" || e.kind === "upgrade") spentUnlocks += cost;
            else spentOther += cost;
          }
          if (e.type === "abilityCast" && e.casterId === self.id) {
            spentAbilities += e.cost ?? 0;
          }
        },
      } as never,
    ],
  });

  flow.matches += 1;
  flow.peak += peak;
  flow.spentCitizens += spentCitizens;
  flow.spentAbilities += spentAbilities;
  flow.spentUnlocks += spentUnlocks;
  flow.spentOther += spentOther;
  flow.ticks += record.endedAtTick;
}

const n = flow.matches;
const spent =
  flow.spentCitizens + flow.spentAbilities + flow.spentUnlocks + flow.spentOther;
const share = (x: number) => (spent > 0 ? `${((x / spent) * 100).toFixed(1)}%` : "—");

console.log(`ECONOMY FLOW — ${modelPath}`);
console.log(`  ${n} matches, average ${(flow.ticks / n).toFixed(0)} ticks\n`);
console.log(`  peak gold ever held      ${(flow.peak / n).toFixed(0)}`);
console.log(`  total spent per match    ${(spent / n).toFixed(0)}\n`);
console.log(`  on citizens              ${(flow.spentCitizens / n).toFixed(0).padStart(7)}   ${share(flow.spentCitizens)}`);
console.log(`  on casting abilities     ${(flow.spentAbilities / n).toFixed(0).padStart(7)}   ${share(flow.spentAbilities)}`);
console.log(`  on unlocks and upgrades  ${(flow.spentUnlocks / n).toFixed(0).padStart(7)}   ${share(flow.spentUnlocks)}`);
console.log(`  on shields and repairs   ${(flow.spentOther / n).toFixed(0).padStart(7)}   ${share(flow.spentOther)}`);

console.log(
  `\n  => spending is ${
    flow.spentCitizens > flow.spentAbilities
      ? "dominated by CITIZENS — the economy engine is eating the war chest"
      : "dominated by CASTING — gold leaves as fast as it arrives"
  }.`,
);
console.log(
  `  Raising peak liquidity means either earning faster than this drain, or ` +
    `giving the policy a reason to hold.`,
);
