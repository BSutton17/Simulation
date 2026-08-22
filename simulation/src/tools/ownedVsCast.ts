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
 * Does the policy fail to BUY abilities, or fail to USE the ones it bought?
 *
 *   npx tsx simulation/src/tools/ownedVsCast.ts <champion.json>
 *
 * ⚠️ THE TWO ANSWERS DEMAND OPPOSITE FIXES, and they are indistinguishable in a
 * usage count. Kit reach has sat near 2.7 of 5 across four different fitness
 * designs — variety at 0.12, variety at 0.30, and now combo rewards — and the
 * reason decides what to do next:
 *
 *   OWNS FEW    — the ceiling is economic. Punishing repetition cannot produce
 *     variety when there is no second option to move to, and the unlock dials
 *     added to the balance search are the lever.
 *
 *   OWNS MANY, CASTS FEW — the ceiling is the policy's judgement. It has the
 *     abilities and prefers not to use them, and no price change reaches that.
 *
 * Reported per kingdom, because a single average hides the case where a few
 * kingdoms are broke and the rest are simply narrow.
 */

const [, , modelPath] = process.argv;
if (!modelPath) {
  console.error("usage: ownedVsCast <champion.json>");
  process.exit(1);
}

const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);

interface Row {
  matches: number;
  owned: number;
  cast: number;
  casts: number;
  kitSize: number;
}

const rows = new Map<string, Row>();
const slate = buildValidationSlate(KINGDOM_IDS, "baseline", {
  maxTicks: 6000,
  seedsPerScenario: 2,
});

for (const s of slate.scenarios as SlateScenario[]) {
  // ⚠️ CAPTURE THE PLAYER ID, not the display name. `abilityCast.casterId` is
  // the id; filtering on "cand" matched nothing and reported zero casts for a
  // champion that plainly casts ~52 times a match.
  let self: { id: string; unlocked: Record<string, boolean> } | null = null;
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

  const cast = new Set<string>();
  let casts = 0;
  runHeadlessMatch({
    players: seats,
    seed: s.seed,
    maxTicks: s.maxTicks,
    createAI: seats[0]!.ai!,
    telemetry: false,
    observers: [
      {
        onEvent: (e: { type: string; casterId?: string; abilityId?: string }) => {
          if (e.type !== "abilityCast") return;
          // Only the candidate seat: the opponents are heuristics.
          if (!self || e.casterId !== self.id) return;
          casts += 1;
          if (e.abilityId) cast.add(e.abilityId);
        },
      } as never,
    ],
  });

  const kit = abilitiesForKingdom(s.candidateKingdom).filter((a) => a.kind !== "passive");
  const owned = self
    ? kit.filter(
        (a) => (self as { unlocked: Record<string, boolean> }).unlocked[a.id],
      ).length
    : 0;

  const row = rows.get(s.candidateKingdom) ?? {
    matches: 0, owned: 0, cast: 0, casts: 0, kitSize: kit.length,
  };
  row.matches += 1;
  row.owned += owned;
  row.cast += cast.size;
  row.casts += casts;
  rows.set(s.candidateKingdom, row);
}

console.log(`OWNED vs CAST — ${modelPath}\n`);
console.log(
  `  ${"kingdom".padEnd(13)} ${"owned".padStart(6)} ${"cast".padStart(6)} ${"of".padStart(3)}  ${"casts".padStart(6)}  unused`,
);

let totalOwned = 0;
let totalCast = 0;
let totalKit = 0;
for (const [kingdomId, r] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
  const owned = r.owned / r.matches;
  const cast = r.cast / r.matches;
  totalOwned += owned;
  totalCast += cast;
  totalKit += r.kitSize;
  console.log(
    `  ${kingdomId.padEnd(13)} ${owned.toFixed(1).padStart(6)} ${cast.toFixed(1).padStart(6)} ${String(r.kitSize).padStart(3)}  ` +
      `${(r.casts / r.matches).toFixed(1).padStart(6)}  ${(owned - cast).toFixed(1)}`,
  );
}

const n = rows.size;
console.log(
  `\n  AVERAGE: owns ${(totalOwned / n).toFixed(2)} of ${(totalKit / n).toFixed(0)}, ` +
    `casts ${(totalCast / n).toFixed(2)} of them`,
);
console.log(
  `\n  => ${
    totalOwned / n < 3.2
      ? "OWNS FEW — the ceiling is economic; unlock prices are the lever."
      : "OWNS MANY, CASTS FEW — the ceiling is the policy's judgement, not price."
  }`,
);
console.log(
  `  ${(totalOwned - totalCast) / n >= 1
    ? `On average ${((totalOwned - totalCast) / n).toFixed(2)} owned abilities go UNUSED every match.`
    : "Almost everything owned is being used."}`,
);
