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
 * Can a balance change reach 80/80, or are some abilities out of reach entirely?
 *
 *   npx tsx simulation/src/tools/abilityReach.ts <model.json> [candidate.json]
 *
 * ⚠️ THIS IS THE QUESTION TO SETTLE BEFORE SPENDING A SEARCH ON IT. Fourteen of
 * eighty abilities are never cast, and "make the game fairer" is only a route to
 * casting them if the reason they are skipped is one that prices and damage
 * figures control. Two reasons look identical in a usage count and are not:
 *
 *   REJECTED — the ability was legal, repeatedly, and the policy chose something
 *     else every time. That is a VALUE judgement: it is beaten on damage per
 *     gold, or on tempo. Retuning its cost or its damage changes the judgement,
 *     so a balance search can reach it.
 *
 *   UNREACHABLE — the ability was never legal at all. Unaffordable at every
 *     decision, or gated behind a meter, a status, a unique board slot. No
 *     damage figure fixes that, because the choice is never offered. A search
 *     told to raise its usage will spend its whole budget failing.
 *
 * The split decides whether 80/80 is a target or a fantasy. Run it on the
 * baseline, and on a candidate, to see whether a fairer game moves the line.
 */

const [, , modelPath, candidatePath] = process.argv;
if (!modelPath) {
  console.error("usage: abilityReach <model.json> [candidate.json]");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

function loadCandidate(path: string): ParameterSet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as
    | ParameterSet
    | { parameters: ParameterSet }
    | Array<{ parameters: ParameterSet }>;
  if (Array.isArray(raw)) return raw[0]!.parameters;
  if ("parameters" in raw && typeof raw.parameters === "object") {
    return (raw as { parameters: ParameterSet }).parameters;
  }
  return raw as ParameterSet;
}

interface Reach {
  /** Decisions on which casting this ability was legal. */
  legal: number;
  /** Decisions on which it was chosen. */
  chosen: number;
}

function measure(): Map<string, Reach> {
  const reach = new Map<string, Reach>();
  const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
    maxTicks: 6000,
    seedsPerScenario: 2,
  });

  for (const s of slate.scenarios as SlateScenario[]) {
    // Only the candidate seat is driven by the network; the rest are the
    // slate's heuristic opponents. That seat rotates through all sixteen
    // kingdoms across the slate, so every kit is measured — but each is
    // measured as the TRAINED policy plays it, which is the population whose
    // choices the balance search is meant to serve.
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
        const profile = PERSONALITIES[
          s.opponentProfiles[opp]! as keyof typeof PERSONALITIES
        ];
        seats.push({
          kingdomId: s.opponentKingdoms[opp]!,
          name: `o${opp}`,
          ai: personalityAI(profile as never),
        });
        opp += 1;
      }
    }

    runHeadlessMatch({
      players: seats,
      seed: s.seed,
      maxTicks: s.maxTicks,
      createAI: seats[0]!.ai!,
      telemetry: false,
    });

    if (!controller) continue;
    const kit = abilitiesForKingdom(s.candidateKingdom);
    const stats = (controller as NetworkController).stats;
    for (let slot = 0; slot < kit.length; slot++) {
      const id = `${s.candidateKingdom}/${kit[slot]!.id}`;
      const entry = reach.get(id) ?? { legal: 0, chosen: 0 };
      entry.legal += stats.castLegal[slot] ?? 0;
      entry.chosen += stats.castChosen[slot] ?? 0;
      reach.set(id, entry);
    }
  }
  return reach;
}

function report(label: string, reach: Map<string, Reach>): void {
  const rows = [...reach.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dead = rows.filter(([, r]) => r.chosen === 0);
  const rejected = dead.filter(([, r]) => r.legal > 0);
  const unreachable = dead.filter(([, r]) => r.legal === 0);

  console.log(`\n=== ${label} ===`);
  console.log(`  abilities cast        ${rows.length - dead.length}/${rows.length}`);
  console.log(`  never cast            ${dead.length}`);
  console.log(`    REJECTED on value   ${rejected.length}  (legal, never chosen — balance CAN move these)`);
  console.log(`    UNREACHABLE         ${unreachable.length}  (never legal — balance CANNOT move these)`);

  if (rejected.length > 0) {
    console.log(`\n  Rejected despite being available:`);
    for (const [id, r] of rejected.sort((a, b) => b[1].legal - a[1].legal)) {
      console.log(`    ${id.padEnd(34)} legal on ${String(r.legal).padStart(6)} decisions, chosen 0`);
    }
  }
  if (unreachable.length > 0) {
    console.log(`\n  Never even offered:`);
    for (const [id] of unreachable) console.log(`    ${id}`);
  }
  return;
}

const baseline = measure();
report("BASELINE", baseline);

if (candidatePath) {
  const candidate = loadCandidate(candidatePath);
  const after = withParameterSet(candidate, () => measure());
  report(`CANDIDATE ${candidatePath}`, after);

  // The comparison that actually answers the question: did making the game
  // fairer convert any REJECTED ability into a cast one, and did it convert any
  // UNREACHABLE one into merely rejected?
  console.log(`\n=== DID A FAIRER GAME WIDEN THE KIT? ===`);
  let revived = 0;
  let killed = 0;
  let offered = 0;
  for (const [id, b] of baseline) {
    const a = after.get(id);
    if (!a) continue;
    if (b.chosen === 0 && a.chosen > 0) { revived += 1; console.log(`  REVIVED    ${id}`); }
    if (b.chosen > 0 && a.chosen === 0) { killed += 1; console.log(`  KILLED     ${id}`); }
    if (b.legal === 0 && a.legal > 0) { offered += 1; console.log(`  NOW LEGAL  ${id}`); }
  }
  console.log(`\n  revived ${revived}   killed ${killed}   newly offered ${offered}`);
}
