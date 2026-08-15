import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Summarises a V8 .cpuprofile into "where did the time go".
 *
 * A .cpuprofile is a call tree plus a flat sample list. Self time per function
 * is what identifies a hot spot; total time mostly re-tells the call structure.
 * This reports self time grouped three ways — by file, by function, and by the
 * AI decision phases named in the brief — because a single view hides things:
 * a cost spread thinly over twenty small functions in one file is invisible in
 * a per-function table and obvious in a per-file one.
 *
 *   node --import tsx simulation/src/perf/analyseProfile.ts runs/prof
 */

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

const dir = process.argv[2] ?? "runs/prof";
const candidates = readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));
if (candidates.length === 0) {
  console.error(`no .cpuprofile in ${dir}`);
  process.exit(1);
}

/**
 * Picks the thread that did the work.
 *
 * `--cpu-prof` writes one profile per thread, and running under tsx means the
 * loader thread gets one too. Taking the last filename gave a profile that was
 * 98.3% idle and attributed everything to module loading — a completely
 * misleading picture of a run that was in fact CPU-bound in the simulation.
 * Choose by measured busy time instead of by name.
 */
function busyMicroseconds(profile: CpuProfile): number {
  const idle = new Set(
    profile.nodes
      .filter((n) => ["(idle)", "(program)", "(root)"].includes(n.callFrame.functionName))
      .map((n) => n.id),
  );
  let busy = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    if (!idle.has(profile.samples[i]!)) busy += profile.timeDeltas[i] ?? 0;
  }
  return busy;
}

const loaded = candidates.map((f) => ({
  file: f,
  profile: JSON.parse(readFileSync(join(dir, f), "utf8")) as CpuProfile,
}));
loaded.sort((a, b) => busyMicroseconds(b.profile) - busyMicroseconds(a.profile));
const { file, profile } = loaded[0]!;
if (loaded.length > 1) {
  console.log(
    `threads: ${loaded
      .map((l) => `${l.file.split(".").slice(-3, -1).join(".")}=${(busyMicroseconds(l.profile) / 1e6).toFixed(1)}s busy`)
      .join(", ")}`,
  );
}

// Self time per node, from the sample stream rather than hitCount: timeDeltas
// give real microseconds, hitCount only gives sample counts.
const selfByNode = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i++) {
  const node = profile.samples[i]!;
  selfByNode.set(node, (selfByNode.get(node) ?? 0) + (profile.timeDeltas[i] ?? 0));
}

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const totalUs = [...selfByNode.values()].reduce((a, b) => a + b, 0);

const shorten = (url: string): string => {
  if (!url) return "(native)";
  const m = /(?:simulation\/src|src)\/.*$/.exec(url.replace(/\\/g, "/"));
  return m ? m[0] : url.replace(/\\/g, "/").split("/").slice(-2).join("/");
};

const add = (map: Map<string, number>, key: string, us: number) =>
  map.set(key, (map.get(key) ?? 0) + us);

const byFile = new Map<string, number>();
const byFunction = new Map<string, number>();

for (const [id, us] of selfByNode) {
  const node = byId.get(id);
  if (!node) continue;
  const url = shorten(node.callFrame.url);
  const name = node.callFrame.functionName || "(anonymous)";
  add(byFile, url, us);
  add(byFunction, `${name}  ${url}:${node.callFrame.lineNumber + 1}`, us);
}

const pct = (us: number) => `${((us / totalUs) * 100).toFixed(1)}%`;
const ms = (us: number) => `${(us / 1000).toFixed(0)}ms`;

function table(title: string, map: Map<string, number>, limit: number): void {
  console.log("");
  console.log(title);
  console.log("=".repeat(78));
  const rows = [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [key, us] of rows) {
    console.log(`  ${pct(us).padStart(6)}  ${ms(us).padStart(8)}  ${key}`);
  }
}

console.log(`profile ${file}`);
console.log(`total sampled ${(totalUs / 1e6).toFixed(1)}s`);

table("SELF TIME BY FILE", byFile, 20);
table("SELF TIME BY FUNCTION", byFunction, 30);

/**
 * The decision phases from the brief, matched by the functions that implement
 * them. Deliberately explicit: a regex over names would silently reclassify
 * things as the code changes, and a wrong attribution here sends optimisation
 * effort at the wrong target.
 */
const PHASES: { phase: string; functions: string[] }[] = [
  { phase: "ability resolution", functions: ["resolveAbility", "abilityById", "kitFor"] },
  { phase: "ability valuation", functions: ["abilityValue", "genericEffectValue", "effectValue"] },
  { phase: "target selection", functions: ["pickTarget", "chooseTarget", "targetsFor", "enemiesOf"] },
  { phase: "purchase decisions", functions: ["buyAbilities", "purchase", "spendable", "affordable"] },
  { phase: "reservation / savings", functions: ["reservation", "savings", "nextUnlockCost"] },
  { phase: "sorting / ranking", functions: ["sort", "rank", "compare"] },
  { phase: "state inspection", functions: ["snapshot", "aliveOf", "statusOf", "cooldownOf"] },
];

const byPhase = new Map<string, number>();
let attributed = 0;
for (const [id, us] of selfByNode) {
  const node = byId.get(id);
  if (!node) continue;
  const name = node.callFrame.functionName || "";
  const phase = PHASES.find((p) => p.functions.some((f) => name === f || name.endsWith(`.${f}`)));
  if (phase) {
    add(byPhase, phase.phase, us);
    attributed += us;
  }
}
if (byPhase.size > 0) {
  table("SELF TIME BY DECISION PHASE (named functions only)", byPhase, 20);
  console.log(`\n  attributed ${pct(attributed)} of total; the rest is inlined, anonymous or engine code.`);
}
