import { rmSync } from "node:fs";
import { runSearch } from "./search/index.js";

/**
 * End-to-end proof that an interrupted search resumes to the same place an
 * uninterrupted one reaches.
 *
 * The unit tests cover the checkpoint file; this covers the LOOP — counters,
 * cache restoration, best-candidate carry-over and, most importantly, that the
 * CMA-ES state picks up mid-run rather than quietly restarting.
 */

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 60000).toFixed(1)}m]`;
const log = (m: string) => console.log(`${stamp()} ${m}`);

const CHECKPOINT = "artifacts/resume-check.json";
const COMMON = {
  seed: 20260813,
  populationSize: 4,
  promote: 1,
  validate: 0,
  workers: 8,
  sigma: 0.2,
} as const;

rmSync(CHECKPOINT, { force: true });

console.log("=".repeat(70));
console.log("RUN A — uninterrupted, 2 generations");
console.log("=".repeat(70));
const a = await runSearch({
  ...COMMON,
  generations: 2,
  onProgress: (e) => log(`  ${e.message}`),
});

console.log();
console.log("=".repeat(70));
console.log("RUN B — 1 generation, checkpointed, then resumed to 2");
console.log("=".repeat(70));
rmSync(CHECKPOINT, { force: true });
const b1 = await runSearch({
  ...COMMON,
  generations: 1,
  checkpointPath: CHECKPOINT,
  onProgress: (e) => log(`  [b1] ${e.message}`),
});
log(`  b1 stopped after ${b1.generations.length} generation(s)`);

// The interruption: a brand-new runSearch call, same config, longer horizon.
const b2 = await runSearch({
  ...COMMON,
  generations: 2,
  checkpointPath: CHECKPOINT,
  onProgress: (e) => log(`  [b2] ${e.message}`),
});

console.log();
console.log("=".repeat(70));
console.log("COMPARISON");
console.log("=".repeat(70));
console.log(`  resumedFrom            ${JSON.stringify(b2.resumedFrom)}`);
console.log(`  checkpointRejected     ${b2.checkpointRejected ?? "none"}`);
console.log();
const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(6));
for (let g = 0; g < a.generations.length; g++) {
  const ga = a.generations[g]!;
  const gb = b2.generations[g]!;
  const same =
    ga.bestScreen === gb?.bestScreen &&
    ga.meanScreen === gb?.meanScreen &&
    ga.worstScreen === gb?.worstScreen;
  console.log(
    `  gen ${g}  A best ${fmt(ga.bestScreen)} mean ${fmt(ga.meanScreen)}  |  ` +
      `B best ${fmt(gb?.bestScreen ?? null)} mean ${fmt(gb?.meanScreen ?? null)}  ${same ? "MATCH" : "DIFFER"}`,
  );
}
console.log();
console.log(`  A best candidate  ${a.best?.candidate.id}  full ${fmt(a.best?.full ?? null)}`);
console.log(`  B best candidate  ${b2.best?.candidate.id}  full ${fmt(b2.best?.full ?? null)}`);

const identical =
  a.generations.length === b2.generations.length &&
  a.generations.every((ga, i) => {
    const gb = b2.generations[i]!;
    return (
      ga.bestScreen === gb.bestScreen &&
      ga.meanScreen === gb.meanScreen &&
      ga.worstScreen === gb.worstScreen
    );
  }) &&
  a.best?.candidate.hash === b2.best?.candidate.hash &&
  a.best?.full === b2.best?.full;

console.log();
console.log(`  RESUMED RUN IDENTICAL TO UNINTERRUPTED RUN: ${identical ? "YES" : "NO"}`);
console.log();
console.log(`  A matches ${a.totals.matches}  |  B total matches ${b1.totals.matches + b2.totals.matches}`);
console.log(`  B re-used ${b2.resumedFrom?.cacheEntries ?? 0} cached evaluations on resume`);
console.log(`  A wall ${(a.totals.durationMs / 60000).toFixed(1)}m  |  B2 wall ${(b2.totals.durationMs / 60000).toFixed(1)}m`);

console.log();
console.log("=".repeat(70));
console.log("REFUSAL CHECK — a checkpoint from a different run must not resume");
console.log("=".repeat(70));
const c = await runSearch({
  ...COMMON,
  seed: 999999,
  generations: 1,
  checkpointPath: CHECKPOINT,
  onProgress: (e) => log(`  [c] ${e.message}`),
});
console.log(`  resumedFrom        ${JSON.stringify(c.resumedFrom)}`);
console.log(`  checkpointRejected ${c.checkpointRejected ?? "none"}`);
console.log(`  REFUSED AS EXPECTED: ${c.resumedFrom === null && c.checkpointRejected !== null ? "YES" : "NO"}`);

rmSync(CHECKPOINT, { force: true });
log("done");
