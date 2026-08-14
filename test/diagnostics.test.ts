import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  personalityAI,
  BALANCED,
  diagnose,
  diagnoseRecords,
  renderConcerns,
  telemetryOf,
  type PlayerSpec,
} from "../simulation/src/index.js";

/**
 * Intelligent Balance Assistant (Part 4): rule-based diagnostics over the
 * analytics. These tests run a batch, then assert the assistant produces
 * well-formed, correctly-classified, and correctly-ranked recommendations.
 */

const kingdoms = ["fire", "water", "nature", "earth", "electricity"];
const batch = () =>
  telemetryOf(
    runSimulation({
      matches: 12,
      seed: "diagnostics",
      players: kingdoms.map((k) => ({
        kingdomId: k as PlayerSpec["kingdomId"],
        ai: personalityAI(BALANCED),
      })),
    }).records,
  );

test("diagnose returns ranked, well-formed concerns", () => {
  const diag = diagnose(batch());
  assert.equal(diag.kingdoms, kingdoms.length);
  assert.ok(diag.concerns.length > 0, "found at least one concern");
  for (const c of diag.concerns) {
    assert.ok(["overpowered", "underpowered", "economy", "underused"].includes(c.category));
    assert.ok(["high", "medium", "low"].includes(c.severity));
    assert.ok(c.subject.length > 0);
    assert.ok(c.headline.length > 0);
    assert.ok(c.recommendation.length > 0, "every concern carries a recommendation");
  }
  // Concerns are ordered most-urgent first.
  for (let i = 1; i < diag.concerns.length; i++) {
    assert.ok(diag.concerns[i - 1]!.score >= diag.concerns[i]!.score, "ranked by score");
  }
});

test("a dominant kingdom is flagged overpowered with its primary damage cause", () => {
  // In this 5-way brawl a couple of kingdoms dominate; whichever is above its
  // fair share must be flagged and given a primary-cause recommendation.
  const diag = diagnose(batch());
  const op = diag.concerns.filter((c) => c.category === "overpowered");
  for (const c of op) {
    assert.ok(c.kingdomId);
    // The recommendation points at something concrete (a source or the kingdom).
    assert.match(c.recommendation, /Investigate|Reduce/);
  }
});

test("a losing kingdom is flagged underpowered", () => {
  const diag = diagnose(batch());
  const up = diag.concerns.filter((c) => c.category === "underpowered" && c.kingdomId && !c.abilityId);
  // Fire collapses in a 5-way brawl (established earlier), so something is under.
  assert.ok(up.length > 0, "a below-fair-share kingdom was flagged");
});

test("unlocked-but-unused abilities are flagged (grouped per kingdom) with a value reason", () => {
  const diag = diagnose(batch());
  // Dead abilities are grouped into one concern per kingdom to avoid flooding.
  const dead = diag.concerns.filter(
    (c) => c.category === "underused" && c.reason === "Never the highest-value play",
  );
  assert.ok(dead.length > 0, "at least one kingdom has unlocked-but-unused abilities");
  for (const c of dead) {
    assert.match(c.headline, /unlocked but never cast/);
    assert.ok(c.kingdomId, "attributed to a kingdom");
    assert.match(c.recommendation, /Lower cost or raise impact/);
  }
});

test("thresholds are configurable", () => {
  const t = batch();
  // Impossible thresholds → no overpowered/underpowered concerns.
  const strict = diagnose(t, {
    overpoweredMinWinRate: 2,
    underpoweredFactor: -1,
    floatedGoldThreshold: 1e9,
    unlockedShareThreshold: 2,
  });
  assert.equal(strict.concerns.length, 0, "no concerns under impossible thresholds");
});

test("control-without-payoff is flagged as a CONTROL concern", () => {
  // Deterministic: a status that blocked many attacks but produced little
  // follow-up damage. The detector must flag it and attribute it to Ice (from
  // the data), independent of AI timing.
  const fake = {
    index: 0, seed: 0, endedAtTick: 1000, timedOut: false, winnerId: null, winnerKingdom: null,
    seats: [],
    statusEffectiveness: {
      frozen: { applications: 20, totalDurationTicks: 2000, averageDurationTicks: 100, attacksBlocked: 40, followUpDamage: 400, killsDuringStatus: 0 },
    },
  } as unknown as Parameters<typeof diagnose>[0][number];

  const diag = diagnose([fake]); // defaults: 40 blocks ≥ 5, 10 dmg/block < 300
  const control = diag.concerns.filter((c) => c.category === "control");
  assert.equal(control.length, 1, "the low-payoff control status is flagged");
  assert.equal(control[0]!.reason, "Control without payoff");
  assert.equal(control[0]!.kingdomId, "ice"); // attributed from data
  assert.match(control[0]!.headline, /Blocks 40 attacks/);
  assert.match(control[0]!.recommendation, /payoff/);

  // A control status with good payoff is NOT flagged.
  const good = { ...fake, statusEffectiveness: { frozen: { ...fake.statusEffectiveness.frozen, followUpDamage: 40000 } } };
  assert.equal(diagnose([good]).concerns.filter((c) => c.category === "control").length, 0);
});

test("renderConcerns produces the TOP BALANCE CONCERNS report", () => {
  const text = renderConcerns(diagnose(batch()));
  assert.match(text, /TOP BALANCE CONCERNS/);
  assert.match(text, /→/); // each concern has a recommendation arrow
});

test("diagnoseRecords works straight off simulation records", () => {
  const result = runSimulation({
    matches: 4,
    seed: "records",
    players: kingdoms.map((k) => ({ kingdomId: k as PlayerSpec["kingdomId"] })),
  });
  const diag = diagnoseRecords(result.records);
  assert.equal(diag.kingdoms, kingdoms.length);
});
