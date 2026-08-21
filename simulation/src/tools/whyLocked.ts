import { readFileSync } from "node:fs";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { withParameterSet, type ParameterSet } from "../../../src/engine/parameters.js";
import { runHeadlessMatch } from "../headless.js";
import { NetworkController } from "../ai/index.js";
import { buildNetwork } from "../neat/index.js";
import { buildValidationSlate, type SlateScenario } from "../training/slate.js";
import { personalityAI } from "../personality.js";
import { PERSONALITIES } from "../personalities.js";
import type { PlayerSpec } from "../types.js";

/**
 * Why is an ability never cast? Three answers, and only one of them is price.
 *
 *   npx tsx simulation/src/tools/whyLocked.ts <model.json> [candidate.json]
 *
 * ⚠️ FORTY GENERATIONS OF PRICE SEARCH MADE COVERAGE WORSE (64/80 -> 62/80), so
 * the assumption underneath that campaign is the thing to test. It assumed dead
 * abilities are TOO EXPENSIVE TO CAST. There are two other possibilities that
 * look identical from outside:
 *
 *   NEVER BOUGHT — the policy never spends gold to unlock the ability at all.
 *     No cast price can fix this, because the ability is not in the player's
 *     hands to cast. It is an INVESTMENT decision, and the network makes it by
 *     choosing an `invest` head over a `cast`, a citizen, or a shield.
 *
 *   BOUGHT, NEVER AFFORDABLE — owned, but the caster never holds enough gold at
 *     a decision point. This is the one a cast-cost change actually reaches.
 *
 *   BLOCKED — cooldown, charges, a meter, a status, the centrepiece, or a
 *     payload the 22 action heads cannot express.
 *
 * The report also shows how often BUYING each ability was affordable but not
 * chosen, which separates "the AI cannot afford to unlock it" from "the AI can
 * afford it and would rather buy something else". Those demand opposite fixes:
 * the first is balance, the second is the policy's valuation.
 */

const [, , modelPath, candidatePath] = process.argv;
if (!modelPath) {
  console.error("usage: whyLocked <model.json> [candidate.json]");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

function loadCandidate(path: string): ParameterSet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as
    | ParameterSet | { parameters: ParameterSet } | Array<{ parameters: ParameterSet }>;
  if (Array.isArray(raw)) return raw[0]!.parameters;
  if ("parameters" in raw && typeof raw.parameters === "object") {
    return (raw as { parameters: ParameterSet }).parameters;
  }
  return raw as ParameterSet;
}

interface Row {
  cast: number;
  legal: number;
  notUnlocked: number;
  notAffordable: number;
  otherBlocked: number;
  investAffordable: number;
  investChosen: number;
}

function measure(): Map<string, Row> {
  const rows = new Map<string, Row>();
  const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
    maxTicks: 6000,
    seedsPerScenario: 2,
  });

  for (const s of slate.scenarios as SlateScenario[]) {
    let controller: NetworkController | null = null;
    const seats: PlayerSpec[] = [];
    let opp = 0;
    for (let i = 0; i < s.seats; i++) {
      if (i === s.candidateSeat) {
        seats.push({
          kingdomId: s.candidateKingdom,
          name: "cand",
          ai: (p, rng) => {
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

    if (!controller) continue;
    const kit = abilitiesForKingdom(s.candidateKingdom);
    const st = (controller as NetworkController).stats;
    for (let slot = 0; slot < kit.length; slot++) {
      const id = `${s.candidateKingdom}/${kit[slot]!.id}`;
      const r = rows.get(id) ?? {
        cast: 0, legal: 0, notUnlocked: 0, notAffordable: 0,
        otherBlocked: 0, investAffordable: 0, investChosen: 0,
      };
      r.cast += st.castChosen[slot] ?? 0;
      r.legal += st.castLegal[slot] ?? 0;
      r.notUnlocked += st.castBlockedNotUnlocked[slot] ?? 0;
      r.notAffordable += st.castBlockedNotAffordable[slot] ?? 0;
      r.otherBlocked += st.castBlockedOther[slot] ?? 0;
      r.investAffordable += st.investAffordable[slot] ?? 0;
      r.investChosen += st.investChosen[slot] ?? 0;
      rows.set(id, r);
    }
  }
  return rows;
}

function report(label: string, rows: Map<string, Row>): void {
  const dead = [...rows.entries()].filter(([, r]) => r.cast === 0);

  const byCause = { neverBought: [], neverAffordable: [], blocked: [] } as
    Record<string, Array<[string, Row]>>;
  for (const entry of dead) {
    const r = entry[1];
    const top = Math.max(r.notUnlocked, r.notAffordable, r.otherBlocked);
    if (top === r.notUnlocked) byCause.neverBought!.push(entry);
    else if (top === r.notAffordable) byCause.neverAffordable!.push(entry);
    else byCause.blocked!.push(entry);
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  abilities never cast   ${dead.length}/${rows.size}\n`);
  console.log(`  NEVER BOUGHT        ${byCause.neverBought!.length}  — price of casting is irrelevant; the AI never unlocks it`);
  console.log(`  NEVER AFFORDABLE    ${byCause.neverAffordable!.length}  — owned but never enough gold; a cost change reaches these`);
  console.log(`  BLOCKED             ${byCause.blocked!.length}  — cooldown, meter, status, centrepiece, or unexpressable`);

  if (byCause.neverBought!.length > 0) {
    console.log(`\n  Never bought — and how often buying WAS affordable:`);
    console.log(`    ${"ability".padEnd(32)} ${"locked on".padStart(9)} ${"could afford".padStart(12)} ${"chose to buy".padStart(12)}`);
    for (const [id, r] of byCause.neverBought!.sort((a, b) => b[1].investAffordable - a[1].investAffordable)) {
      console.log(
        `    ${id.padEnd(32)} ${String(r.notUnlocked).padStart(9)} ${String(r.investAffordable).padStart(12)} ${String(r.investChosen).padStart(12)}`,
      );
    }
  }
  if (byCause.neverAffordable!.length > 0) {
    console.log(`\n  Owned but never affordable:`);
    for (const [id, r] of byCause.neverAffordable!) {
      console.log(`    ${id.padEnd(32)} short on ${r.notAffordable} decisions`);
    }
  }
  if (byCause.blocked!.length > 0) {
    console.log(`\n  Blocked for other reasons:`);
    for (const [id, r] of byCause.blocked!) {
      console.log(`    ${id.padEnd(32)} blocked on ${r.otherBlocked} decisions`);
    }
  }

  // The headline: could the AI have bought these, and simply preferred not to?
  const affordableButUnbought = byCause.neverBought!.filter(([, r]) => r.investAffordable > 0);
  console.log(
    `\n  => ${affordableButUnbought.length} of ${byCause.neverBought!.length} never-bought abilities WERE affordable to unlock ` +
      `at some point and the AI still did not buy them.`,
  );
}

report("BASELINE", measure());

if (candidatePath) {
  const candidate = loadCandidate(candidatePath);
  report(`CANDIDATE ${candidatePath}`, withParameterSet(candidate, () => measure()));
}
