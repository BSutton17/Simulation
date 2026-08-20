import { readFileSync } from "node:fs";
import { evaluate } from "../evaluation/index.js";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { withParameterSet, type ParameterSet } from "../../../src/engine/parameters.js";
import { listParameters } from "../../../src/engine/parameterCatalog.js";
import { runHeadlessMatch } from "../headless.js";
import { NetworkController } from "../ai/index.js";
import { buildNetwork } from "../neat/index.js";
import { buildValidationSlate, type SlateScenario } from "../training/slate.js";
import { personalityAI } from "../personality.js";
import { PERSONALITIES } from "../personalities.js";
import type { PlayerSpec } from "../types.js";
import type { GameplayEvent } from "../../../src/engine/events.js";

/**
 * Compares a balance candidate against the current defaults.
 *
 *   npx tsx simulation/src/tools/compareBalance.ts <candidate.json> [modelPath]
 *
 * Accepts either a bare parameter map or the coordinator's `candidate.json`
 * (which nests them under `parameters`).
 *
 * Two questions, deliberately answered with two different instruments:
 *
 *  1. PARITY — is the game fairer? Measured with the search's OWN evaluator over
 *     all three formats and the active strategy population. An earlier duel-only
 *     read with a single model in both seats reversed the sign of this answer,
 *     which is why it uses `evaluate()` and not a hand-rolled loop.
 *
 *  2. ABILITY USAGE — is more of each kingdom's kit actually reachable? Nothing
 *     in the balance fitness rewards this, so it has to be measured separately
 *     or it is invisible.
 *
 * Every number is exact. Rounding hid real movement once already.
 */

const [, , candidatePath, modelPath = "runs/neat/v1/hard.json"] = process.argv;
if (!candidatePath) {
  console.error("usage: compareBalance <candidate.json> [model.json]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(candidatePath, "utf8")) as
  | ParameterSet
  | { parameters: ParameterSet };
const candidate: ParameterSet =
  "parameters" in raw && typeof raw.parameters === "object"
    ? (raw as { parameters: ParameterSet }).parameters
    : (raw as ParameterSet);

// ---------------------------------------------------------------------------
// 0. Completeness. A partial set silently leaves the rest of the game on
//    defaults, which produces a confident and wrong comparison.
// ---------------------------------------------------------------------------
const catalog = new Map(listParameters().map((p) => [p.id, p.base]));
const supplied = Object.keys(candidate);
const unknown = supplied.filter((id) => !catalog.has(id));
const covered = new Set(supplied.map((id) => id.split(".")[1]));
const kits = new Map(
  KINGDOM_IDS.map((k) => [k, abilitiesForKingdom(k).filter((a) => a.kind !== "passive").map((a) => a.id)]),
);
const missing: string[] = [];
for (const [k, ids] of kits) {
  const absent = ids.filter((id) => !covered.has(id));
  if (absent.length > 0) missing.push(`${k} (${absent.length}/${ids.length} abilities untouched)`);
}

let moved = 0;
const drift: { id: string; from: number; to: number; pct: number }[] = [];
for (const [id, v] of Object.entries(candidate)) {
  const b = catalog.get(id);
  if (b === undefined || Math.abs(v - b) < 1e-9) continue;
  moved += 1;
  drift.push({ id, from: b, to: v, pct: (100 * (v - b)) / (b === 0 ? 1 : b) });
}
drift.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

console.log(`CANDIDATE ${candidatePath}`);
console.log(`  parameters supplied ${supplied.length}   changed from default ${moved}   unrecognised ${unknown.length}`);
if (unknown.length > 0) console.log(`  ⚠ unrecognised ids: ${unknown.slice(0, 5).join(", ")}`);
if (missing.length > 0) {
  console.log(`  ⚠ INCOMPLETE — these kingdoms have abilities with no parameters supplied:`);
  for (const m of missing) console.log(`      ${m}`);
  console.log(`    They will play on DEFAULTS, so the comparison understates the candidate.`);
} else {
  console.log(`  complete: every kingdom's kit is represented`);
}
if (drift.length > 0) {
  const abs = drift.map((d) => Math.abs(d.pct)).sort((a, b) => a - b);
  console.log(`  median move ${abs[Math.floor(abs.length / 2)]!.toFixed(1)}%   max ${abs[abs.length - 1]!.toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 1. Parity, via the search's own evaluator.
// ---------------------------------------------------------------------------
const evalConfig = {
  pool: "validation" as const,
  maxTicks: 6000,
  workers: 8,
  duel: { enabled: true, seedsPerPairing: 1 },
  ffa4: { enabled: true, seedsPerPairing: 1, compositions: 24, sampler: "coverage" as const },
  ffa7: { enabled: true, seedsPerPairing: 1, compositions: 16, sampler: "coverage" as const },
};

console.log("\nevaluating baseline...");
const A = await evaluate({ ...evalConfig, balance: null });
console.log("evaluating candidate...");
const B = await evaluate({ ...evalConfig, balance: candidate });

const stats = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    min: s[0]!, max: s[s.length - 1]!, spread: s[s.length - 1]! - s[0]!,
    sd: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length),
  };
};
const duelRate = (r: typeof A) => KINGDOM_IDS.map((k) => 100 * (r.duel!.kingdoms[k]?.rate ?? 0));
const ffaFirst = (r: typeof A.ffa4) => KINGDOM_IDS.map((k) => 100 * (r!.kingdoms[k]?.placement.first.rate ?? 0));
const ffaPlace = (r: typeof A.ffa4) => KINGDOM_IDS.map((k) => r!.kingdoms[k]?.placement.average ?? 0);

console.log(`\nmatches ${A.totals.matches} per side   timeouts ${A.totals.timeouts} -> ${B.totals.timeouts}`);
console.log("\n=== PARITY (smaller spread / sd = fairer) ===");
console.log("  metric                          baseline      candidate      change");
const cmp = (name: string, a: number, b: number, dp = 4) => {
  const d = b - a;
  const pct = a === 0 ? 0 : (100 * d) / a;
  console.log(
    `  ${name.padEnd(30)} ${a.toFixed(dp).padStart(10)} ${b.toFixed(dp).padStart(14)}` +
      `  ${(d >= 0 ? "+" : "") + d.toFixed(dp)} (${(pct >= 0 ? "+" : "") + pct.toFixed(1)}%)`,
  );
};
for (const [label, a, b] of [
  ["DUEL win-rate spread", stats(duelRate(A)).spread, stats(duelRate(B)).spread],
  ["DUEL std deviation", stats(duelRate(A)).sd, stats(duelRate(B)).sd],
  ["FFA4 first-place spread", stats(ffaFirst(A.ffa4)).spread, stats(ffaFirst(B.ffa4)).spread],
  ["FFA4 std deviation", stats(ffaFirst(A.ffa4)).sd, stats(ffaFirst(B.ffa4)).sd],
  ["FFA7 first-place spread", stats(ffaFirst(A.ffa7)).spread, stats(ffaFirst(B.ffa7)).spread],
  ["FFA7 std deviation", stats(ffaFirst(A.ffa7)).sd, stats(ffaFirst(B.ffa7)).sd],
  ["FFA4 mean-placement spread", stats(ffaPlace(A.ffa4)).spread, stats(ffaPlace(B.ffa4)).spread],
  ["FFA7 mean-placement spread", stats(ffaPlace(A.ffa7)).spread, stats(ffaPlace(B.ffa7)).spread],
] as const) cmp(label, a, b);

console.log("\n=== PER KINGDOM: duel win% | ffa4 first% | ffa7 first% ===");
const dA = duelRate(A), dB = duelRate(B);
const f4A = ffaFirst(A.ffa4), f4B = ffaFirst(B.ffa4);
const f7A = ffaFirst(A.ffa7), f7B = ffaFirst(B.ffa7);
const cell = (a: number, b: number) =>
  `${a.toFixed(1).padStart(5)}->${b.toFixed(1).padStart(5)}${((b - a >= 0 ? "+" : "") + (b - a).toFixed(1)).padStart(7)}`;
const order = KINGDOM_IDS.map((k, i) => ({ k, i })).sort((x, y) => dB[y.i]! - dB[x.i]!);
console.log("  kingdom              DUEL                    FFA4                    FFA7");
for (const { k, i } of order) {
  console.log(`  ${k.padEnd(13)} ${cell(dA[i]!, dB[i]!)}  ${cell(f4A[i]!, f4B[i]!)}  ${cell(f7A[i]!, f7B[i]!)}`);
}

// ---------------------------------------------------------------------------
// 2. Ability usage — what the balance fitness does not measure.
// ---------------------------------------------------------------------------
const genome = JSON.parse(readFileSync(modelPath, "utf8")).genome;
const network = buildNetwork(genome);
const slate = buildValidationSlate(KINGDOM_IDS, "baseline", { maxTicks: 6000, seedsPerScenario: 2 });

class Usage {
  readonly byPlayer = new Map<string, Map<string, number>>();
  onEvent(e: GameplayEvent): void {
    if (e.type !== "abilityCast") return;
    const c = e as unknown as { casterId: string; abilityId: string };
    let m = this.byPlayer.get(c.casterId);
    if (!m) { m = new Map(); this.byPlayer.set(c.casterId, m); }
    m.set(c.abilityId, (m.get(c.abilityId) ?? 0) + 1);
  }
}

function usageFor(params: ParameterSet | null): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  withParameterSet(params, () => {
    for (const s of slate.scenarios as SlateScenario[]) {
      const seats: PlayerSpec[] = [];
      let opp = 0;
      for (let i = 0; i < s.seats; i++) {
        if (i === s.candidateSeat) {
          seats.push({
            kingdomId: s.candidateKingdom, name: "cand",
            ai: (p, rng) => new NetworkController(p, { network, rng, difficulty: "hard" }),
          });
        } else {
          const prof = PERSONALITIES[s.opponentProfiles[opp]! as keyof typeof PERSONALITIES];
          seats.push({ kingdomId: s.opponentKingdoms[opp]!, name: `o${opp}`, ai: personalityAI(prof as never) });
          opp += 1;
        }
      }
      const obs = new Usage();
      runHeadlessMatch({
        players: seats, seed: s.seed, maxTicks: s.maxTicks,
        createAI: seats[0]!.ai!, observers: [obs as never], telemetry: false,
      });
      const mine = obs.byPlayer.get(`p${s.candidateSeat}`) ?? new Map<string, number>();
      let kd = out.get(s.candidateKingdom);
      if (!kd) { kd = new Map(); out.set(s.candidateKingdom, kd); }
      for (const [id, n] of mine) kd.set(id, (kd.get(id) ?? 0) + n);
    }
  });
  return out;
}

console.log("\nmeasuring ability usage...");
const uA = usageFor(null);
const uB = usageFor(candidate);

const total = [...kits.values()].reduce((s, ids) => s + ids.length, 0);
const distinct = (u: Map<string, Map<string, number>>) => {
  let n = 0;
  for (const [k, ids] of kits) {
    const m = u.get(k);
    if (m) n += ids.filter((id) => (m.get(id) ?? 0) > 0).length;
  }
  return n;
};
const casts = (u: Map<string, Map<string, number>>) => {
  let n = 0;
  for (const m of u.values()) for (const v of m.values()) n += v;
  return n;
};

console.log("\n=== ABILITY USAGE (the balance fitness does not measure this) ===");
cmp("distinct abilities used", distinct(uA), distinct(uB), 0);
cmp("  out of", total, total, 0);
cmp("total casts", casts(uA), casts(uB), 0);

console.log("\n  kingdom        baseline        candidate      casts");
for (const [k, ids] of kits) {
  const a = uA.get(k) ?? new Map<string, number>();
  const b = uB.get(k) ?? new Map<string, number>();
  const mark = (m: Map<string, number>) => ids.map((id) => ((m.get(id) ?? 0) > 0 ? "#" : ".")).join("");
  const cnt = (m: Map<string, number>) => ids.filter((id) => (m.get(id) ?? 0) > 0).length;
  const sum = (m: Map<string, number>) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  console.log(
    `  ${k.padEnd(13)} ${mark(a)} ${cnt(a)}/${ids.length}      ${mark(b)} ${cnt(b)}/${ids.length}   ` +
      `${String(sum(a)).padStart(5)} -> ${String(sum(b)).padStart(5)}`,
  );
}

const gained: string[] = [], lost: string[] = [], dead: string[] = [];
for (const [k, ids] of kits) {
  const a = uA.get(k) ?? new Map<string, number>();
  const b = uB.get(k) ?? new Map<string, number>();
  for (const id of ids) {
    const x = a.get(id) ?? 0, y = b.get(id) ?? 0;
    if (x === 0 && y > 0) gained.push(`${k}/${id}`);
    else if (x > 0 && y === 0) lost.push(`${k}/${id}`);
    else if (x === 0 && y === 0) dead.push(`${k}/${id}`);
  }
}
console.log(`\n  newly used (${gained.length}): ${gained.join(", ") || "none"}`);
console.log(`  no longer used (${lost.length}): ${lost.join(", ") || "none"}`);
console.log(`  never used in either (${dead.length}/${total}): ${dead.join(", ") || "none"}`);
