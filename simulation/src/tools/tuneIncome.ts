import { readFileSync } from "node:fs";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { withParameterSet } from "../../../src/engine/parameters.js";
import { runHeadlessMatch } from "../headless.js";
import { NetworkController } from "../ai/index.js";
import { buildNetwork } from "../neat/index.js";
import { buildValidationSlate, type SlateScenario } from "../training/slate.js";
import { personalityAI } from "../personality.js";
import { PERSONALITIES } from "../personalities.js";
import type { PlayerSpec } from "../types.js";

/**
 * What income makes the price table affordable?
 *
 *   npx tsx simulation/src/tools/tuneIncome.ts <champion.json> [matches] [values...]
 *
 * ⚠️ ONE PARAMETER, NOT EIGHTY. Measured over 100 matches, EIGHT of sixteen
 * kingdoms cannot afford their own CHEAPEST ability at median holdings, and the
 * healthy eight sit at 0.65-0.94x of it. That is not sixteen mispriced kits; it
 * is an income curve too tight for the whole table.
 *
 * Rescaling prices to fit the current income was the obvious alternative and it
 * collapses: Fire's dearest ability at its p75 implies a factor of 0.06, which
 * would put Fireball at 7 gold. That deletes the economy rather than balancing
 * it, and it also moves abilities relative to citizens, shields and repairs,
 * which are priced separately and would not move.
 *
 * So this sweeps `economy.incomePerCitizen` and reports, per candidate value,
 * how many kingdoms clear their cheapest ability with real headroom. Nothing is
 * written; it prints what each value would do.
 */

const [, , modelPath, matchesArg, ...valueArgs] = process.argv;
if (!modelPath) {
  console.error("usage: tuneIncome <champion.json> [matches] [values...]");
  process.exit(1);
}

const MATCHES = Number(matchesArg ?? 100);
const VALUES = valueArgs.length > 0
  ? valueArgs.map(Number)
  : [0.06, 0.12, 0.18, 0.24, 0.3];

/** Headroom a kingdom needs over its cheapest ability to be playable. */
const HEADROOM = 2;

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

const seedsPerScenario = Math.max(1, Math.ceil(MATCHES / 48));
const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
  maxTicks: 6000,
  seedsPerScenario,
});
const scenarios = (slate.scenarios as SlateScenario[]).slice(0, MATCHES);

function measure(): Map<string, number[]> {
  const byKingdom = new Map<string, number[]>();
  for (const s of scenarios) {
    let self: { economy: { currency: number } } | null = null;
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
    const samples = byKingdom.get(s.candidateKingdom) ?? [];
    runHeadlessMatch({
      players: seats, seed: s.seed, maxTicks: s.maxTicks,
      createAI: seats[0]!.ai!, telemetry: false,
      observers: [{ onEvent: () => { if (self) samples.push(self.economy.currency); } } as never],
    });
    byKingdom.set(s.candidateKingdom, samples);
  }
  return byKingdom;
}

const median = (sorted: number[]): number =>
  sorted.length === 0 ? 0 : sorted[Math.floor(0.5 * sorted.length)]!;

const cheapest = new Map<string, number>();
for (const k of KINGDOM_IDS) {
  const kit = abilitiesForKingdom(k).filter((a) => a.kind !== "passive");
  cheapest.set(k, Math.min(...kit.map((a) => a.cost)));
}

console.log(`INCOME SWEEP — ${modelPath}`);
console.log(`  ${scenarios.length} matches per value, headroom target ${HEADROOM}x over the cheapest ability\n`);
console.log(
  `  ${"income".padStart(7)}  ${"comfortable".padStart(11)}  ${"can afford".padStart(10)}  ${"starved".padStart(7)}   worst kingdom`,
);

for (const value of VALUES) {
  const byKingdom = withParameterSet({ "economy.incomePerCitizen": value }, () => measure());

  let comfortable = 0;
  let afford = 0;
  let starved = 0;
  let worst: [string, number] = ["—", Infinity];

  for (const k of KINGDOM_IDS) {
    const samples = (byKingdom.get(k) ?? []).slice().sort((a, b) => a - b);
    if (samples.length === 0) continue;
    const p50 = median(samples);
    const min = cheapest.get(k)!;
    const ratio = min > 0 ? p50 / min : Infinity;
    if (ratio >= HEADROOM) comfortable += 1;
    else if (ratio >= 1) afford += 1;
    else starved += 1;
    if (ratio < worst[1]) worst = [k, ratio];
  }

  console.log(
    `  ${value.toFixed(3).padStart(7)}  ${String(comfortable).padStart(11)}  ${String(afford).padStart(10)}  ` +
      `${String(starved).padStart(7)}   ${worst[0]} at ${worst[1].toFixed(2)}x`,
  );
}

console.log(
  `\n  comfortable = median holding is ${HEADROOM}x its cheapest ability or better`,
);
console.log(`  starved     = cannot afford its cheapest ability at all`);
