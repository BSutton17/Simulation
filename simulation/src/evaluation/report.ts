import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import type { EvaluationResult, MatchupResult } from "./evaluator.js";
import type { Comparison } from "./compare.js";
import { uncertainty, type Rate } from "./stats.js";

/**
 * Reporting for a balance reading.
 *
 * Two consumers with different needs: an optimizer, which needs the whole
 * reading as JSON and must never scrape console output, and a designer, who
 * needs to see what the game currently looks like.
 *
 * The language here is deliberately neutral — "high observed win rate", never
 * "overpowered". The evaluator measures; whether a number is a problem depends
 * on intent it has no access to.
 */

/** Serialisable form of a reading. Structure is the contract for the optimizer. */
export function toJson(result: EvaluationResult): string {
  return JSON.stringify(result, null, 2);
}

/** How uncertain a rate is, in plain words — drives the "uncertain" callouts. */
function confidenceNote(r: Rate): string {
  const w = uncertainty(r) * 100;
  if (r.total === 0) return "no data";
  if (w > 30) return "very uncertain";
  if (w > 15) return "uncertain";
  return "";
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

/** The 16×16 duel matrix as text. Rows are the attacker; cells are row-vs-column
 *  win rate. The diagonal is blank — a kingdom is not evaluated against itself. */
export function matrixText(result: EvaluationResult): string {
  if (!result.duel) return "";
  const cell = new Map<string, MatchupResult>();
  for (const m of result.duel.matchups) cell.set(`${m.a}|${m.b}`, m);

  const short = (k: string) => k.slice(0, 4);
  const lines: string[] = [];
  lines.push(`${pad("", 12)}${KINGDOM_IDS.map((k) => num(short(k), 6)).join("")}`);
  for (const a of KINGDOM_IDS) {
    const row: string[] = [];
    for (const b of KINGDOM_IDS) {
      if (a === b) {
        row.push(num("--", 6));
        continue;
      }
      const forward = cell.get(`${a}|${b}`);
      const reverse = cell.get(`${b}|${a}`);
      const r = forward
        ? forward.aggregate.rate
        : reverse
          ? 1 - reverse.aggregate.rate
          : null;
      row.push(num(r === null ? "." : (r * 100).toFixed(0), 6));
    }
    lines.push(`${pad(a, 12)}${row.join("")}`);
  }
  return lines.join("\n");
}

export function reportText(result: EvaluationResult): string {
  const L: string[] = [];
  const p = result.provenance;

  L.push("=".repeat(78));
  L.push("ELEMENTALS — BALANCE EVALUATION");
  L.push("=".repeat(78));
  L.push(`  config          ${p.balanceConfigId} (${p.balanceConfigHash})`);
  L.push(`  engine          ${p.engineSha.slice(0, 10)}${p.engineDirty ? " (DIRTY WORKING TREE)" : ""}`);
  L.push(`  balance data    ${p.balanceBaselineHash}`);
  L.push(`  population      ${result.population.version} — ${result.population.profiles.join(", ")}`);
  L.push(`  seed pool       ${result.pool}`);
  L.push(`  kingdoms        ${p.kingdomCount}`);
  L.push(
    `  matches         ${result.totals.matches.toLocaleString()} in ${(result.totals.durationMs / 1000).toFixed(1)}s ` +
      `(${(result.totals.matches / (result.totals.durationMs / 1000)).toFixed(1)}/s), ` +
      `${result.totals.timeouts} timed out`,
  );

  if (result.duel) {
    const d = result.duel;
    L.push("");
    L.push("-".repeat(78));
    L.push(`1v1 — ${d.pairings} matchups, ${d.matches.toLocaleString()} matches`);
    L.push("-".repeat(78));
    L.push("");
    L.push("  Observed win rate by kingdom (pooled over all matchups and strategies)");
    const ranked = Object.entries(d.kingdoms).sort((x, y) => y[1].rate - x[1].rate);
    for (const [k, r] of ranked) {
      const note = confidenceNote(r);
      L.push(
        `    ${pad(k, 13)} ${num(pct(r.rate), 7)}  ` +
          `[${pct(r.ci95[0])} – ${pct(r.ci95[1])}]  n=${num(r.total, 5)}${note ? `  ${note}` : ""}`,
      );
    }

    L.push("");
    L.push("  Matchup matrix — row kingdom's win rate vs column (%)");
    L.push("");
    for (const line of matrixText(result).split("\n")) L.push(`  ${line}`);

    // Extremes, stated neutrally.
    const extreme = [...d.matchups]
      .filter((m) => m.aggregate.total > 0)
      .sort(
        (x, y) =>
          Math.abs(y.aggregate.rate - 0.5) - Math.abs(x.aggregate.rate - 0.5),
      )
      .slice(0, 10);
    L.push("");
    L.push("  Most one-sided matchups observed");
    for (const m of extreme) {
      L.push(
        `    ${pad(`${m.a} vs ${m.b}`, 26)} ${num(pct(m.aggregate.rate), 7)}  ` +
          `n=${num(m.aggregate.total, 4)}  ${confidenceNote(m.aggregate)}`,
      );
    }

    // Strategy sensitivity — diagnostic, explicitly not a fitness input.
    const sensitive = [...d.matchups]
      .sort((x, y) => y.profileSpread.spread - x.profileSpread.spread)
      .slice(0, 8);
    L.push("");
    L.push("  Most strategy-sensitive matchups (spread across ordered pairings)");
    L.push("  Diagnostic only: a wide spread means the outcome depends on how it is played.");
    for (const m of sensitive) {
      L.push(
        `    ${pad(`${m.a} vs ${m.b}`, 26)} spread ${num((m.profileSpread.spread * 100).toFixed(0), 4)}pp  ` +
          `min ${num((m.profileSpread.min * 100).toFixed(0), 3)}%  max ${num((m.profileSpread.max * 100).toFixed(0), 3)}%`,
      );
    }

    L.push("");
    L.push("  Strategy performance (win rate across every matchup it played)");
    for (const [id, r] of Object.entries(d.profiles).sort((x, y) => y[1].rate - x[1].rate)) {
      L.push(`    ${pad(id, 15)} ${num(pct(r.rate), 7)}  n=${num(r.total, 6)}`);
    }

    if (Object.keys(d.mirrors).length > 0) {
      L.push("");
      L.push("  Mirror pairings — seat-0 win rate (0.5 is neutral; diagnostic only)");
      for (const [id, r] of Object.entries(d.mirrors)) {
        const skew = Math.abs(r.rate - 0.5) * 100;
        L.push(
          `    ${pad(id, 15)} ${num(pct(r.rate), 7)}  n=${num(r.total, 5)}` +
            `${skew > 15 ? `  seat skew ${skew.toFixed(0)}pp` : ""}`,
        );
      }
    }
  }

  for (const [label, ffa] of [
    ["4-player FFA", result.ffa4],
    ["7-player FFA", result.ffa7],
  ] as const) {
    if (!ffa) continue;
    L.push("");
    L.push("-".repeat(78));
    L.push(
      `${label} — ${ffa.compositions.length} compositions (${ffa.sampler}), ` +
        `${ffa.matches.toLocaleString()} matches`,
    );
    L.push("-".repeat(78));
    const fair = (ffa.seats + 1) / 2;
    L.push(`  Fair average placement is ${fair.toFixed(1)}; fair first-place rate is ${pct(1 / ffa.seats)}.`);
    L.push("");
    L.push(`    ${pad("kingdom", 13)} ${num("avg pl", 7)} ${num("1st", 7)} ${num("last", 7)} ${num("n", 6)}  appearances`);
    const rows = Object.values(ffa.kingdoms).sort(
      (x, y) => x.placement.average - y.placement.average,
    );
    for (const row of rows) {
      const s = row.placement;
      L.push(
        `    ${pad(row.kingdom, 13)} ${num(s.average.toFixed(2), 7)} ${num(pct(s.first.rate), 7)} ` +
          `${num(pct(s.last.rate), 7)} ${num(s.matches, 6)}  ${ffa.coverage[row.kingdom] ?? 0}`,
      );
    }
    const counts = Object.values(ffa.coverage);
    if (counts.length > 0) {
      L.push(
        `    coverage spread: ${Math.min(...counts)}–${Math.max(...counts)} appearances per kingdom`,
      );
    }
  }

  L.push("");
  L.push("=".repeat(78));
  L.push("Observations are descriptive. Whether any figure is a problem depends on");
  L.push("design intent, which this evaluator does not model.");
  L.push("=".repeat(78));
  return L.join("\n");
}

/** Human-readable baseline-vs-candidate comparison. */
export function comparisonText(c: Comparison): string {
  const L: string[] = [];
  L.push("=".repeat(78));
  L.push(`COMPARISON — ${c.baselineId} → ${c.candidateId}`);
  L.push("=".repeat(78));
  if (c.incomparable) {
    L.push("");
    L.push(`  REFUSED: these readings are not comparable — ${c.incomparable}`);
    L.push("  A balance result is only valid for the engine that produced it.");
    return L.join("\n");
  }

  if (c.duel) {
    L.push("");
    L.push("  Kingdom 1v1 win rate");
    const rows = Object.entries(c.duel.kingdoms).sort(
      (x, y) => Math.abs(y[1].deltaPp) - Math.abs(x[1].deltaPp),
    );
    for (const [k, d] of rows) {
      const arrow = d.deltaPp > 0 ? "+" : "";
      L.push(
        `    ${pad(k, 13)} ${num(pct(d.baseline), 7)} → ${num(pct(d.candidate), 7)}  ` +
          `${num(`${arrow}${d.deltaPp.toFixed(1)}pp`, 9)}${d.separated ? "  *" : ""}`,
      );
    }
    L.push("");
    L.push(`  ${c.duel.significant.length} matchup(s) moved beyond sampling noise (*)`);
    for (const m of c.duel.significant.slice(0, 15)) {
      const arrow = m.deltaPp > 0 ? "+" : "";
      L.push(
        `    ${pad(`${m.a} vs ${m.b}`, 26)} ${num(pct(m.baseline), 7)} → ${num(pct(m.candidate), 7)}  ${arrow}${m.deltaPp.toFixed(1)}pp`,
      );
    }
  }

  for (const [label, f] of [["4-FFA", c.ffa4], ["7-FFA", c.ffa7]] as const) {
    if (!f) continue;
    L.push("");
    L.push(`  ${label} average placement (lower is better)`);
    const rows = [...f.kingdoms].sort(
      (x, y) => Math.abs(y.averagePlacement.delta) - Math.abs(x.averagePlacement.delta),
    );
    for (const r of rows.slice(0, 16)) {
      const d = r.averagePlacement;
      const arrow = d.delta > 0 ? "+" : "";
      L.push(
        `    ${pad(r.kingdom, 13)} ${num(d.baseline.toFixed(2), 6)} → ${num(d.candidate.toFixed(2), 6)}  ${arrow}${d.delta.toFixed(2)}`,
      );
    }
  }

  L.push("");
  L.push("  No judgement is made about whether this candidate is better.");
  return L.join("\n");
}
