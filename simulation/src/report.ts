import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listParameters } from "../../src/engine/parameterCatalog.js";
import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import { AnalyticsCollector, type BatchAnalytics } from "./analytics.js";
import { runSimulation } from "./runner.js";
import { locateParameter, type SourceLocation } from "./sourceLocator.js";
import type { OptimizationResult } from "./optimizer.js";
import type { AIFactory, MatchRecord, PlayerSpec, SimulationObserver } from "./types.js";
import type { KingdomId } from "../../src/data/kingdoms.js";

/**
 * Balance reporting suite (ticket #210): turns analytics + optimization
 * output into designer-facing reports — win rates, matchup matrices, ability
 * and upgrade usage, economy summaries, and concrete recommendations that say
 * exactly WHERE to apply each change (file + line in the data sources).
 *
 * Everything here derives from the analytics framework; nothing recomputes
 * gameplay. Exports: text (console), HTML (self-contained), JSON, and CSV.
 * Runs are persisted under simulation/runs/ for history.
 */

// ---------------------------------------------------------------------------
// Matchup matrix
// ---------------------------------------------------------------------------

export interface MatchupMatrix {
  kingdoms: string[];
  /** winRates[a][b] = kingdom a's win rate in a-vs-b duels (row perspective). */
  winRates: Record<string, Record<string, number>>;
  matchesPerPair: number;
  timeouts: number;
}

/**
 * Runs a round-robin of 1v1 duels (mirrors included) and tabulates win rates.
 *
 * The competitive (non-mirror) duels also carry telemetry and feed any
 * `observers` (e.g. the kingdom-summary AnalyticsCollector), and their records
 * are returned — so the kingdom table AND the balance diagnostics are driven by
 * exactly the same matches that produce the matrix. Mirror duels only fill the
 * diagonal cell (they are degenerate — see the balance-objective guard).
 */
export function runMatchupMatrix(options: {
  kingdoms: KingdomId[];
  matchesPerPair: number;
  seed: number | string;
  maxTicks?: number;
  createAI?: AIFactory;
  /** Observers applied to the competitive duels (not the mirrors). */
  observers?: SimulationObserver[];
  /** Candidate balance overrides every duel runs under (optimizer matrix mode). */
  parameters?: Readonly<Record<string, number>>;
  /** Collect per-match telemetry on the competitive duels (default true). The
   *  optimizer disables it — it only needs win rates + aggregate analytics. */
  telemetry?: boolean;
}): MatchupMatrix & { records: MatchRecord[] } {
  const { kingdoms, matchesPerPair } = options;
  const winRates: Record<string, Record<string, number>> = {};
  let timeouts = 0;
  const records: MatchRecord[] = [];
  for (const k of kingdoms) winRates[k] = {};

  for (let i = 0; i < kingdoms.length; i++) {
    for (let j = i; j < kingdoms.length; j++) {
      const a = kingdoms[i]!;
      const b = kingdoms[j]!;
      const mirror = a === b;
      const result = runSimulation({
        matches: matchesPerPair,
        seed: `${options.seed}:${a}-vs-${b}`,
        players: [{ kingdomId: a }, { kingdomId: b }],
        maxTicks: options.maxTicks,
        createAI: options.createAI,
        observers: mirror ? undefined : options.observers,
        telemetry: mirror ? false : options.telemetry ?? true,
        parameters: options.parameters,
      });
      let aWins = 0;
      let bWins = 0;
      for (const record of result.records) {
        if (record.timedOut) timeouts += 1;
        if (record.winnerId === "p0") aWins += 1;
        if (record.winnerId === "p1") bWins += 1;
        if (!mirror) records.push(record);
      }
      winRates[a]![b] = aWins / matchesPerPair;
      if (!mirror) winRates[b]![a] = bWins / matchesPerPair;
    }
  }
  return { kingdoms: [...kingdoms], winRates, matchesPerPair, timeouts, records };
}

// ---------------------------------------------------------------------------
// Report structure
// ---------------------------------------------------------------------------

/** One concrete, reviewable change: what, how much, and exactly where. */
export interface Recommendation {
  id: string;
  base: number;
  recommended: number;
  deltaPct: number;
  location: SourceLocation | null;
}

export interface KingdomReportRow {
  kingdomId: string;
  matches: number;
  winRate: number;
  averagePlacement: number;
  eliminations: number;
  damageDealtPerMatch: number;
  damageTakenPerMatch: number;
  healingPerMatch: number;
  criticalHits: number;
  shieldGained: number;
  citizensBought: number;
  citizensFinalAvg: number;
  goldSpentOnCasts: number;
  goldSpentOnPurchases: number;
  upgradesPurchased: number;
  abilityCasts: number;
}

export interface BalanceReport {
  title: string;
  generatedAt: string;
  matches: number;
  timeouts: number;
  averageDurationTicks: number;
  minDurationTicks: number;
  maxDurationTicks: number;
  kingdoms: KingdomReportRow[];
  /** Casts per ability across the whole batch, with kind from metadata. */
  abilityUsage: { abilityId: string; kind: string; casts: number }[];
  matchup?: MatchupMatrix;
  optimization?: {
    algorithm: string;
    objective: string;
    baselineScore: number;
    bestScore: number;
    iterations: number;
    accepted: number;
  };
  /** Recommended balance changes, each with its production source location. */
  recommendations: Recommendation[];
}

export function buildReport(input: {
  title: string;
  analytics: BatchAnalytics;
  matchup?: MatchupMatrix;
  optimization?: OptimizationResult;
  objectiveName?: string;
}): BalanceReport {
  const a = input.analytics;

  const kingdoms: KingdomReportRow[] = Object.values(a.kingdoms)
    .map((k) => ({
      kingdomId: k.kingdomId,
      matches: k.matches,
      winRate: k.winRate,
      averagePlacement: k.averagePlacement,
      eliminations: k.eliminations,
      damageDealtPerMatch: k.matches ? k.damageDealt / k.matches : 0,
      damageTakenPerMatch: k.matches ? k.damageTaken / k.matches : 0,
      healingPerMatch: k.matches ? k.healingReceived / k.matches : 0,
      criticalHits: k.criticalHits,
      shieldGained: k.shieldGained,
      citizensBought: k.citizensBought,
      citizensFinalAvg: k.matches ? k.citizensFinal / k.matches : 0,
      goldSpentOnCasts: k.goldSpentOnCasts,
      goldSpentOnPurchases: k.goldSpentOnPurchases,
      upgradesPurchased: k.upgradesPurchased,
      abilityCasts: Object.values(k.abilityUsage).reduce((s, n) => s + n, 0),
    }))
    .sort((x, y) => y.winRate - x.winRate);

  const usage = new Map<string, number>();
  for (const k of Object.values(a.kingdoms)) {
    for (const [id, n] of Object.entries(k.abilityUsage)) {
      usage.set(id, (usage.get(id) ?? 0) + n);
    }
  }
  const abilityUsage = [...usage.entries()]
    .map(([abilityId, casts]) => ({
      abilityId,
      kind: ALL_ABILITIES[abilityId]?.kind ?? "unknown",
      casts,
    }))
    .sort((x, y) => y.casts - x.casts);

  // Recommendations: every parameter the optimizer's best candidate changes
  // from its production base, located in the data sources.
  const recommendations: Recommendation[] = [];
  if (input.optimization) {
    const baseById = new Map(listParameters().map((p) => [p.id, p.base]));
    for (const [id, recommended] of Object.entries(input.optimization.best)) {
      const base = baseById.get(id);
      if (base === undefined || recommended === base) continue;
      recommendations.push({
        id,
        base,
        recommended,
        deltaPct: base !== 0 ? ((recommended - base) / base) * 100 : 0,
        location: locateParameter(id),
      });
    }
    recommendations.sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct));
  }

  return {
    title: input.title,
    generatedAt: new Date().toISOString(),
    matches: a.matches,
    timeouts: a.timeouts,
    averageDurationTicks: a.averageDurationTicks,
    minDurationTicks: a.minDurationTicks,
    maxDurationTicks: a.maxDurationTicks,
    kingdoms,
    abilityUsage,
    matchup: input.matchup,
    optimization: input.optimization
      ? {
          algorithm: input.optimization.algorithm,
          objective: input.objectiveName ?? "custom",
          baselineScore: input.optimization.baselineScore,
          bestScore: input.optimization.bestScore,
          iterations: input.optimization.history.length,
          accepted: input.optimization.history.filter((h) => h.accepted).length,
        }
      : undefined,
    recommendations,
  };
}

/** Convenience: run one simulation batch and report it. */
export function simulateAndReport(options: {
  title: string;
  matches: number;
  seed: number | string;
  players: PlayerSpec[];
  maxTicks?: number;
  createAI?: AIFactory;
  parameters?: Readonly<Record<string, number>>;
}): { report: BalanceReport; analytics: BatchAnalytics } {
  const collector = new AnalyticsCollector();
  runSimulation({
    matches: options.matches,
    seed: options.seed,
    players: options.players,
    maxTicks: options.maxTicks,
    createAI: options.createAI,
    parameters: options.parameters,
    observers: [collector],
  });
  const analytics = collector.snapshot();
  return { report: buildReport({ title: options.title, analytics }), analytics };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const secs = (ticks: number) => (ticks / 20).toFixed(0) + "s";
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const bar = (fraction: number, width = 20) =>
  "█".repeat(Math.round(Math.max(0, Math.min(1, fraction)) * width)).padEnd(width, "·");

export function renderText(report: BalanceReport): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`═══ ${report.title} ═══`);
  push(`${report.matches} matches · avg ${secs(report.averageDurationTicks)} (min ${secs(report.minDurationTicks)}, max ${secs(report.maxDurationTicks)}) · timeouts ${report.timeouts}`);
  push();

  push("KINGDOM WIN RATES");
  for (const k of report.kingdoms) {
    push(
      `  ${k.kingdomId.padEnd(12)} ${bar(k.winRate)} ${pct(k.winRate).padStart(6)}  place ${k.averagePlacement.toFixed(2)}  dmg/match ${Math.round(k.damageDealtPerMatch)}`,
    );
  }
  push();

  if (report.matchup) {
    push("MATCHUP MATRIX (row's win rate vs column)");
    const ks = report.matchup.kingdoms;
    push("  " + "".padEnd(12) + ks.map((k) => k.slice(0, 6).padStart(7)).join(""));
    for (const row of ks) {
      push(
        "  " +
          row.padEnd(12) +
          ks
            .map((col) => pct(report.matchup!.winRates[row]?.[col] ?? 0).padStart(7))
            .join(""),
      );
    }
    push();
  }

  push("TOP ABILITY USAGE");
  for (const u of report.abilityUsage.slice(0, 10)) {
    push(`  ${u.abilityId.padEnd(22)} ${String(u.casts).padStart(6)} casts  (${u.kind})`);
  }
  push();

  push("ECONOMY");
  for (const k of report.kingdoms) {
    push(
      `  ${k.kingdomId.padEnd(12)} citizens ${k.citizensFinalAvg.toFixed(1).padStart(5)} (bought ${k.citizensBought})  gold→casts ${Math.round(k.goldSpentOnCasts)}  gold→shop ${Math.round(k.goldSpentOnPurchases)}  upgrades ${k.upgradesPurchased}`,
    );
  }
  push();

  if (report.optimization) {
    const o = report.optimization;
    push("OPTIMIZATION");
    push(`  algorithm ${o.algorithm} · objective "${o.objective}"`);
    push(`  score ${o.baselineScore.toFixed(4)} → ${o.bestScore.toFixed(4)} over ${o.iterations} iterations (${o.accepted} accepted)`);
    push();
  }

  if (report.recommendations.length > 0) {
    push("RECOMMENDED BALANCE CHANGES — review, then edit at the listed location");
    for (const r of report.recommendations) {
      const where = r.location ? `${r.location.file}:${r.location.line}` : "(location unknown)";
      push(`  ${r.id}`);
      push(`      ${r.base} → ${r.recommended}  (${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%)`);
      push(`      edit ${where}`);
      if (r.location) push(`      └─ ${r.location.snippet}`);
    }
    push();
  }

  return lines.join("\n");
}

export function toJson(report: BalanceReport): string {
  return JSON.stringify(report, null, 2);
}

export function toCsv(report: BalanceReport): string {
  const rows: string[] = [];
  rows.push(
    "kingdom,matches,winRate,avgPlacement,eliminations,damageDealtPerMatch,damageTakenPerMatch,healingPerMatch,criticalHits,shieldGained,citizensBought,citizensFinalAvg,goldSpentOnCasts,goldSpentOnPurchases,upgradesPurchased,abilityCasts",
  );
  for (const k of report.kingdoms) {
    rows.push(
      [
        k.kingdomId, k.matches, k.winRate, k.averagePlacement, k.eliminations,
        k.damageDealtPerMatch, k.damageTakenPerMatch, k.healingPerMatch,
        k.criticalHits, k.shieldGained, k.citizensBought, k.citizensFinalAvg,
        k.goldSpentOnCasts, k.goldSpentOnPurchases, k.upgradesPurchased, k.abilityCasts,
      ].join(","),
    );
  }
  if (report.recommendations.length > 0) {
    rows.push("");
    rows.push("parameter,base,recommended,deltaPct,file,line");
    for (const r of report.recommendations) {
      rows.push(
        [r.id, r.base, r.recommended, r.deltaPct.toFixed(2), r.location?.file ?? "", r.location?.line ?? ""].join(","),
      );
    }
  }
  return rows.join("\n");
}

export function renderHtml(report: BalanceReport): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const barDiv = (fraction: number, color = "#4aa3ff") =>
    `<div style="background:#1c2233;border-radius:4px;height:14px;width:160px"><div style="background:${color};height:14px;border-radius:4px;width:${Math.round(Math.max(0, Math.min(1, fraction)) * 160)}px"></div></div>`;

  const kingdomRows = report.kingdoms
    .map(
      (k) => `<tr><td>${esc(k.kingdomId)}</td><td>${barDiv(k.winRate)}</td><td>${pct(k.winRate)}</td><td>${k.averagePlacement.toFixed(2)}</td><td>${Math.round(k.damageDealtPerMatch)}</td><td>${Math.round(k.healingPerMatch)}</td><td>${k.citizensFinalAvg.toFixed(1)}</td><td>${k.upgradesPurchased}</td></tr>`,
    )
    .join("");

  const matchupHtml = report.matchup
    ? `<h2>Matchup Matrix</h2><table><tr><th></th>${report.matchup.kingdoms.map((k) => `<th>${esc(k)}</th>`).join("")}</tr>${report.matchup.kingdoms
        .map(
          (row) =>
            `<tr><th>${esc(row)}</th>${report
              .matchup!.kingdoms.map((col) => {
                const w = report.matchup!.winRates[row]?.[col] ?? 0;
                const hue = Math.round(w * 120);
                return `<td style="background:hsl(${hue},45%,22%)">${pct(w)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</table>`
    : "";

  const usageRows = report.abilityUsage
    .map((u) => {
      const max = report.abilityUsage[0]?.casts || 1;
      return `<tr><td>${esc(u.abilityId)}</td><td>${esc(u.kind)}</td><td>${barDiv(u.casts / max, "#6bd88a")}</td><td>${u.casts}</td></tr>`;
    })
    .join("");

  const economyRows = report.kingdoms
    .map((k) => {
      const total = k.goldSpentOnCasts + k.goldSpentOnPurchases || 1;
      return `<tr><td>${esc(k.kingdomId)}</td><td>${k.citizensBought}</td><td>${k.citizensFinalAvg.toFixed(1)}</td><td>${barDiv(k.goldSpentOnCasts / total, "#ffd24a")}</td><td>${Math.round(k.goldSpentOnCasts)}</td><td>${Math.round(k.goldSpentOnPurchases)}</td></tr>`;
    })
    .join("");

  const recRows = report.recommendations
    .map(
      (r) =>
        `<tr><td><code>${esc(r.id)}</code></td><td>${r.base}</td><td><strong>${r.recommended}</strong></td><td>${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%</td><td><code>${esc(r.location ? `${r.location.file}:${r.location.line}` : "unknown")}</code></td><td><code>${esc(r.location?.snippet ?? "")}</code></td></tr>`,
    )
    .join("");

  const optHtml = report.optimization
    ? `<h2>Optimization</h2><p>Algorithm <strong>${esc(report.optimization.algorithm)}</strong> · objective "${esc(report.optimization.objective)}" · score ${report.optimization.baselineScore.toFixed(4)} → <strong>${report.optimization.bestScore.toFixed(4)}</strong> over ${report.optimization.iterations} iterations (${report.optimization.accepted} accepted)</p>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(report.title)}</title>
<style>
body{background:#0b0e17;color:#e8ecf5;font-family:system-ui,sans-serif;padding:2rem;max-width:1100px;margin:auto}
table{border-collapse:collapse;margin:0.75rem 0;width:100%}
th,td{border:1px solid #2a3147;padding:6px 10px;text-align:left;font-size:14px}
th{background:#141928}
h1{color:#ffd24a}h2{color:#8fb7ff;margin-top:2rem}
code{color:#ffd24a}
.meta{color:#8fa0b0}
</style></head><body>
<h1>${esc(report.title)}</h1>
<p class="meta">${esc(report.generatedAt)} · ${report.matches} matches · avg ${secs(report.averageDurationTicks)} (min ${secs(report.minDurationTicks)}, max ${secs(report.maxDurationTicks)}) · timeouts ${report.timeouts}</p>
<h2>Kingdom Win Rates</h2>
<table><tr><th>Kingdom</th><th></th><th>Win rate</th><th>Avg place</th><th>Dmg/match</th><th>Heal/match</th><th>Citizens</th><th>Upgrades</th></tr>${kingdomRows}</table>
${matchupHtml}
<h2>Ability Usage</h2>
<table><tr><th>Ability</th><th>Kind</th><th></th><th>Casts</th></tr>${usageRows}</table>
<h2>Economy</h2>
<table><tr><th>Kingdom</th><th>Citizens bought</th><th>Citizens final (avg)</th><th>Cast/shop split</th><th>Gold→casts</th><th>Gold→shop</th></tr>${economyRows}</table>
${optHtml}
${report.recommendations.length > 0 ? `<h2>Recommended Balance Changes</h2><p class="meta">Review each change, then edit the production value at the listed location.</p><table><tr><th>Parameter</th><th>Base</th><th>Recommended</th><th>Δ</th><th>Edit at</th><th>Current line</th></tr>${recRows}</table>` : ""}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

const RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

/** Persists a report (txt/json/csv/html + candidate.json) for history. */
export function saveRun(
  report: BalanceReport,
  options?: { name?: string; candidate?: Readonly<Record<string, number>>; dir?: string },
): string {
  const base = options?.dir ?? RUNS_DIR;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = (options?.name ?? report.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const dir = path.join(base, `${stamp}-${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.txt"), renderText(report));
  writeFileSync(path.join(dir, "report.json"), toJson(report));
  writeFileSync(path.join(dir, "report.csv"), toCsv(report));
  writeFileSync(path.join(dir, "report.html"), renderHtml(report));
  if (options?.candidate) {
    writeFileSync(
      path.join(dir, "candidate.json"),
      JSON.stringify(options.candidate, null, 2),
    );
  }
  return dir;
}

/** Lists persisted runs, newest first. */
export function listRuns(dir?: string): string[] {
  const base = dir ?? RUNS_DIR;
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((f) => !f.startsWith("."))
    .sort()
    .reverse();
}
