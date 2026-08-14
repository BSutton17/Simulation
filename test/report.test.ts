import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSimulation,
  AnalyticsCollector,
  buildReport,
  runMatchupMatrix,
  renderText,
  renderHtml,
  toJson,
  toCsv,
  saveRun,
  listRuns,
  locateParameter,
  optimize,
  matchDurationObjective,
  listParameters,
  diagnose,
  telemetryOf,
} from "../simulation/src/index.js";

/**
 * Ticket #210 — the reporting suite: reports accurately reflect simulation
 * results and generated candidates, exports round-trip, run history persists,
 * and every recommendation points at the live production source (file:line).
 */

function batch(seed: string, matches = 4) {
  const collector = new AnalyticsCollector();
  runSimulation({
    matches,
    seed,
    players: [{ kingdomId: "fire" }, { kingdomId: "water" }, { kingdomId: "ice" }],
    observers: [collector],
  });
  return collector.snapshot();
}

test("the report mirrors the analytics snapshot exactly", () => {
  const analytics = batch("report-accuracy");
  const report = buildReport({ title: "t", analytics });

  assert.equal(report.matches, analytics.matches);
  assert.equal(report.averageDurationTicks, analytics.averageDurationTicks);
  for (const row of report.kingdoms) {
    const k = analytics.kingdoms[row.kingdomId]!;
    assert.equal(row.winRate, k.winRate);
    assert.equal(row.averagePlacement, k.averagePlacement);
    assert.equal(row.damageDealtPerMatch, k.damageDealt / k.matches);
    assert.equal(row.upgradesPurchased, k.upgradesPurchased);
  }
  // Ability usage totals equal the per-kingdom sums.
  const totalCasts = report.abilityUsage.reduce((s, u) => s + u.casts, 0);
  const expected = Object.values(analytics.kingdoms).reduce(
    (s, k) => s + Object.values(k.abilityUsage).reduce((x, n) => x + n, 0),
    0,
  );
  assert.equal(totalCasts, expected);
});

test("the matchup matrix is complete and consistent", () => {
  const matrix = runMatchupMatrix({
    kingdoms: ["fire", "water"],
    matchesPerPair: 3,
    seed: "matrix-test",
  });
  assert.deepEqual(matrix.kingdoms, ["fire", "water"]);
  // Without timeouts, a duel's win rates are complementary.
  if (matrix.timeouts === 0) {
    assert.equal(
      matrix.winRates["fire"]!["water"]! + matrix.winRates["water"]!["fire"]!,
      1,
    );
  }
  // Mirror diagonal exists and is a valid rate.
  const mirror = matrix.winRates["fire"]!["fire"]!;
  assert.ok(mirror >= 0 && mirror <= 1);
});

test("matrix threads telemetry through its duels for unified diagnostics", () => {
  const collector = new AnalyticsCollector();
  const matrix = runMatchupMatrix({
    kingdoms: ["fire", "nature", "earth"],
    matchesPerPair: 4,
    seed: "unified-test",
    observers: [collector],
  });
  // Competitive (non-mirror) duels carry telemetry and are returned; mirrors
  // are excluded (degenerate), so 3 kingdoms → 3 cross pairings × 4 = 12.
  assert.equal(matrix.records.length, 12);
  assert.ok(matrix.records.every((r) => r.telemetry), "every duel carries telemetry");
  // The same duels feed the analytics collector — one shared data source.
  assert.ok(collector.snapshot().matches === 12);

  // Diagnostics driven by those exact duels, with the 1v1 fair baseline (0.5).
  const diag = diagnose(telemetryOf(matrix.records), { fairWinRate: 0.5 });
  assert.equal(diag.fairWinRate, 0.5);
  assert.equal(diag.kingdoms, 3);
});

test("recommendations carry production source locations (file + line)", () => {
  const result = optimize({
    seed: "report-opt",
    iterations: 4,
    matchesPerBatch: 2,
    players: [{ kingdomId: "fire" }, { kingdomId: "fire" }],
    maxTicks: 20_000,
    objective: matchDurationObjective(6_000),
    parameterIds: ["castle.startingHp", "economy.incomePerCitizen"],
    mutationScale: 0.5,
  });
  const report = buildReport({
    title: "opt",
    analytics: result.analytics,
    optimization: result,
    objectiveName: "test objective",
  });

  assert.ok(report.optimization);
  assert.equal(report.optimization!.bestScore, result.bestScore);

  const bases = new Map(listParameters().map((p) => [p.id, p.base]));
  assert.ok(report.recommendations.length > 0, "expected recommendations");
  for (const rec of report.recommendations) {
    // Values mirror the candidate + catalog exactly.
    assert.equal(rec.recommended, result.best[rec.id]);
    assert.equal(rec.base, bases.get(rec.id));
    // And each points at a real line in the live data sources.
    assert.ok(rec.location, `${rec.id}: no location`);
    const abs = fileURLToPath(
      new URL(`../${rec.location!.file.replace("Server/", "")}`, import.meta.url),
    );
    const line = readFileSync(abs, "utf8").split(/\r?\n/)[rec.location!.line - 1]!;
    assert.equal(line.trim(), rec.location!.snippet, `${rec.id}: stale location`);
  }
});

test("the locator stays synchronized with the production engine's data", () => {
  const checks: Array<[string, RegExp]> = [
    ["castle.startingHp", /STARTING_HP:\s*10_000/],
    ["castle.repairCost", /REPAIR_COST:\s*500/],
    ["economy.incomePerCitizen", /INCOME_PER_CITIZEN:\s*0\.06/],
    ["ability.fireball.effects.0.amount", /amount:\s*250/],
    ["ability.lightningBarrage.charge.damage.1", /damageByCharges:\s*\[230, 475, 800\]/],
    ["passive.water.0.amount", /amount:\s*0\.0675/],
  ];
  for (const [id, pattern] of checks) {
    const loc = locateParameter(id);
    assert.ok(loc, `${id}: not located`);
    assert.match(loc!.snippet, pattern, `${id}: located "${loc!.snippet}"`);
  }
});

test("JSON, CSV, HTML, and text exports carry the report", () => {
  const analytics = batch("export-test", 2);
  const report = buildReport({ title: "Export Test", analytics });

  const json = JSON.parse(toJson(report));
  assert.equal(json.title, "Export Test");
  assert.equal(json.kingdoms.length, report.kingdoms.length);

  const csv = toCsv(report);
  assert.match(csv, /^kingdom,matches,winRate/);
  assert.ok(csv.includes("fire,"));

  const html = renderHtml(report);
  assert.ok(html.includes("Export Test"));
  assert.ok(html.includes("fire"));
  assert.ok(html.startsWith("<!doctype html>"));

  const text = renderText(report);
  assert.ok(text.includes("KINGDOM WIN RATES"));
  assert.ok(text.includes("ECONOMY"));
});

test("runs persist to history with all artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kingdoms-runs-"));
  try {
    const analytics = batch("history-test", 2);
    const report = buildReport({ title: "History Test", analytics });
    const runDir = saveRun(report, {
      dir,
      candidate: { "castle.startingHp": 9_000 },
    });

    for (const artifact of ["report.txt", "report.json", "report.csv", "report.html", "candidate.json"]) {
      assert.ok(existsSync(path.join(runDir, artifact)), `missing ${artifact}`);
    }
    const candidate = JSON.parse(readFileSync(path.join(runDir, "candidate.json"), "utf8"));
    assert.deepEqual(candidate, { "castle.startingHp": 9_000 });

    const runs = listRuns(dir);
    assert.equal(runs.length, 1);
    assert.ok(runDir.endsWith(runs[0]!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
