import type { FitnessComparison, FitnessResult } from "./fitness.js";

/**
 * Fitness reporting.
 *
 * A single number is useless for arguing with. Every report here shows the
 * component scores, the weights, the contributions and the penalties, so a
 * score can always be traced back to the measurement that produced it.
 */

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

export function fitnessText(f: FitnessResult): string {
  const L: string[] = [];
  L.push("=".repeat(78));
  L.push(`BALANCE FITNESS — ${f.provenance.balanceConfigId}`);
  L.push("=".repeat(78));
  L.push(`  fitness version  ${f.provenance.fitnessVersion}`);
  L.push(`  engine           ${f.provenance.engineSha.slice(0, 10)}${f.provenance.engineDirty ? " (DIRTY)" : ""}`);
  L.push(`  weights          ${f.provenance.weightsName} — 4FFA ${f.provenance.weights.ffa4}, 7FFA ${f.provenance.weights.ffa7}, 1v1 ${f.provenance.weights.duel}`);
  L.push(`  seed pool        ${f.provenance.seedPool}  ·  ${f.provenance.totalMatches.toLocaleString()} matches`);
  L.push("");

  for (const format of f.formats) {
    L.push(
      `  ${pad(format.format.toUpperCase(), 6)} score ${num(format.score.toFixed(3), 6)}` +
        `  × weight ${format.weight.toFixed(2)}` +
        `  = ${num(format.contribution.toFixed(3), 6)}` +
        `   (±${format.uncertaintyPp.toFixed(1)}pp, n=${format.matches.toLocaleString()})`,
    );
    for (const c of format.components) {
      const worst = c.fairness.worst[0];
      L.push(
        `      ${pad(c.name, 18)} ${num(c.score.toFixed(3), 6)}  w=${c.weight.toFixed(2)}` +
          (worst ? `   worst: ${worst.subject} (${worst.observed.toFixed(3)})` : ""),
      );
    }
    L.push("");
  }

  L.push(`  weighted score   ${f.weightedScore.toFixed(4)}`);
  if (f.penalty > 0) L.push(`  penalty          −${f.penalty.toFixed(4)}  (${f.violations.length} violation(s))`);
  if (f.capped) L.push(`  CAPPED           constraint violation limits the score`);
  L.push(`  OVERALL          ${f.overall.toFixed(4)}   (the verdict)`);
  L.push(`  search objective ${f.searchObjective.toFixed(4)}   (what an optimizer climbs — uncapped)`);

  if (f.violations.length > 0) {
    L.push("");
    L.push(`  Constraint violations (${f.violations.length}) — these cannot be averaged away`);
    for (const v of f.violations.slice(0, 12)) {
      L.push(`    [${pad(v.format, 5)}] ${pad(v.kind, 18)} ${v.detail}`);
    }
    if (f.violations.length > 12) L.push(`    … and ${f.violations.length - 12} more`);
  }

  L.push("");
  L.push("  Diagnostics — measured, never scored");
  const d = f.diagnostics;
  L.push(`    strategy first-place / win rate:`);
  for (const [id, s] of Object.entries(d.strategies)) {
    L.push(
      `      ${pad(id, 15)} 1v1 ${num(pct(s.duel), 7)}   4FFA ${num(pct(s.ffa4First), 7)}   7FFA ${num(pct(s.ffa7First), 7)}`,
    );
  }
  for (const [format, seats] of Object.entries(d.seatPlacement)) {
    L.push(`    ${format} mean placement by seat: ${seats.map((s) => s.toFixed(2)).join("  ")}`);
  }
  L.push(`    worst cross-strategy matchup swing: ${d.worstProfileSpreadPp.toFixed(0)}pp`);
  L.push(`    timeout rate: ${pct(d.timeoutRate)}`);
  return L.join("\n");
}

export function fitnessComparisonText(c: FitnessComparison): string {
  const L: string[] = [];
  L.push("=".repeat(78));
  L.push(`FITNESS COMPARISON — ${c.baselineId} → ${c.candidateId}`);
  L.push("=".repeat(78));
  if (c.incomparable) {
    L.push("");
    L.push(`  REFUSED: ${c.incomparable}`);
    L.push("  Scores are only comparable under identical fitness rules and engine.");
    return L.join("\n");
  }

  const arrow = c.overall.delta >= 0 ? "+" : "";
  L.push(
    `  OVERALL  ${c.overall.baseline.toFixed(4)} → ${c.overall.candidate.toFixed(4)}   ${arrow}${c.overall.delta.toFixed(4)}` +
      `${c.meaningful ? "" : "   (within noise)"}`,
  );
  L.push("");
  L.push("  By format (sorted by how much each drove the change)");
  for (const f of [...c.formats].sort(
    (x, y) => Math.abs(y.contributionDelta) - Math.abs(x.contributionDelta),
  )) {
    const a = f.delta >= 0 ? "+" : "";
    L.push(
      `    ${pad(f.format, 6)} ${f.baseline.toFixed(3)} → ${f.candidate.toFixed(3)}   ` +
        `${num(`${a}${f.delta.toFixed(3)}`, 7)}   drove ${num(f.contributionDelta.toFixed(4), 8)}`,
    );
  }

  if (c.violationsAdded.length > 0) {
    L.push("");
    L.push(`  New violations (${c.violationsAdded.length})`);
    for (const v of c.violationsAdded.slice(0, 8)) L.push(`    + ${v.detail}`);
  }
  if (c.violationsResolved.length > 0) {
    L.push("");
    L.push(`  Resolved (${c.violationsResolved.length})`);
    for (const v of c.violationsResolved.slice(0, 8)) L.push(`    − ${v.detail}`);
  }
  return L.join("\n");
}
