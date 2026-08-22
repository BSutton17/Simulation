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
 * How much gold does a seat actually HOLD, moment to moment?
 *
 *   npx tsx simulation/src/tools/liquidity.ts <champion.json>
 *
 * ⚠️ PEAK GOLD IS THE WRONG STATISTIC and it misled this investigation twice.
 * A seat that touches 1,259 once and spends most of the match under 200 cannot
 * cast a 699-gold ability, because the money has to be in hand at the MOMENT
 * the decision is made. Peak answers "was it ever rich"; what matters is "how
 * often was it rich enough".
 *
 * So this samples the balance at every tick and reports the distribution, then
 * asks the only question that decides a price: what fraction of the match could
 * this seat have afforded each of its own abilities?
 *
 * A price set at the 50th percentile is castable half the time. One set above
 * the 95th is castable almost never, however impressive the peak looks.
 */

const [, , modelPath, matchesArg] = process.argv;
const MATCHES = Number(matchesArg ?? 100);
if (!modelPath) {
  console.error("usage: liquidity <champion.json>");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

const samplesByKingdom = new Map<string, number[]>();

// ⚠️ THE SLATE HOLDS 48 SCENARIOS PER SEED, so asking for 100 matches with one
// seed each silently ran 48 and reported them as 100. Seeds are scaled to the
// request instead, and the actual count is printed — a sample size that quietly
// caps itself is worse than a small one, because nothing looks wrong.
const seedsPerScenario = Math.max(1, Math.ceil(MATCHES / 48));
const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
  maxTicks: 6000,
  seedsPerScenario,
});

for (const s of (slate.scenarios as SlateScenario[]).slice(0, MATCHES)) {
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

  const samples = samplesByKingdom.get(s.candidateKingdom) ?? [];
  runHeadlessMatch({
    players: seats,
    seed: s.seed,
    maxTicks: s.maxTicks,
    createAI: seats[0]!.ai!,
    telemetry: false,
    observers: [
      {
        // Every event is a sampling point. Not uniform in time, but dense and
        // concentrated where decisions actually happen, which is the moment a
        // price is tested.
        onEvent: () => {
          if (self) samples.push(self.economy.currency);
        },
      } as never,
    ],
  });
  samplesByKingdom.set(s.candidateKingdom, samples);
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

console.log(`LIQUIDITY — ${modelPath}\n`);
console.log(
  `  ${"kingdom".padEnd(13)} ${"p50".padStart(6)} ${"p75".padStart(6)} ${"p90".padStart(6)} ${"p99".padStart(6)}   dearest ability (affordable %)`,
);

const rows: Array<[string, number]> = [];
for (const kingdomId of KINGDOM_IDS) {
  const samples = (samplesByKingdom.get(kingdomId) ?? []).slice().sort((a, b) => a - b);
  if (samples.length === 0) continue;

  const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
  const dearest = kit.reduce((best, a) => (a.cost > best.cost ? a : best), kit[0]!);
  const affordable = samples.filter((v) => v >= dearest.cost).length / samples.length;
  rows.push([kingdomId, affordable]);

  console.log(
    `  ${kingdomId.padEnd(13)} ${String(pct(samples, 0.5)).padStart(6)} ${String(pct(samples, 0.75)).padStart(6)} ` +
      `${String(pct(samples, 0.9)).padStart(6)} ${String(pct(samples, 0.99)).padStart(6)}   ` +
      `${dearest.id} @ ${dearest.cost} (${(affordable * 100).toFixed(1)}%)`,
  );
}

// The recommendation: a price the seat can meet often enough to matter.
console.log(`\n  A price is castable in practice when the seat clears it often.`);
console.log(`  Suggested ceilings, from each kingdom's own p75 holding:\n`);
for (const kingdomId of KINGDOM_IDS) {
  const samples = (samplesByKingdom.get(kingdomId) ?? []).slice().sort((a, b) => a - b);
  if (samples.length === 0) continue;
  const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
  const over = kit.filter((a) => a.cost > pct(samples, 0.75));
  if (over.length === 0) continue;
  console.log(
    `  ${kingdomId.padEnd(13)} p75=${String(pct(samples, 0.75)).padStart(5)}  above it: ` +
      over.map((a) => `${a.id}(${a.cost})`).join(", "),
  );
}


// ── the plan, as data ────────────────────────────────────────────────────────
//
// Written alongside the table so the tool that CHANGES prices reads the same
// numbers a person just read. A second measurement pass could disagree with
// this one through nothing but seed choice, and then the printed rationale and
// the applied prices would quietly describe different games.
import { writeFileSync } from "node:fs";
const plan: Record<string, { p75: number; p50: number }> = {};
for (const kingdomId of KINGDOM_IDS) {
  const samples = (samplesByKingdom.get(kingdomId) ?? []).slice().sort((a, b) => a - b);
  if (samples.length === 0) continue;
  plan[kingdomId] = { p75: pct(samples, 0.75), p50: pct(samples, 0.5) };
}
writeFileSync("runs/liquidity.json", JSON.stringify(plan, null, 2));
console.log(`
  wrote runs/liquidity.json (${Object.keys(plan).length} kingdoms)`);
