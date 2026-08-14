import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  personalityAI,
  BALANCED,
  abilityMetrics,
  kingdomMetrics,
  passiveMetrics,
  statusMetrics,
  matchTimelines,
  explainMatch,
  telemetryOf,
  type PlayerSpec,
} from "../simulation/src/index.js";

/**
 * Analytics engine (Part 2): telemetry → balance insight. Every metric is a
 * pure transform over the Part 1 telemetry, so these tests run a small batch
 * and assert the derived numbers are internally consistent and meaningful.
 */

const kingdoms = ["fire", "water", "nature", "earth", "electricity"];
const batch = () =>
  telemetryOf(
    runSimulation({
      matches: 6,
      seed: "metrics",
      players: kingdoms.map((k) => ({ kingdomId: k as PlayerSpec["kingdomId"], ai: personalityAI(BALANCED) })),
    }).records,
  );

test("ability metrics compute per-cast / per-gold / per-cooldown efficiency", () => {
  const metrics = abilityMetrics(batch());
  assert.ok(metrics.length > 0, "some abilities were used");
  for (const m of metrics) {
    assert.ok(m.casts >= 0);
    assert.equal(m.totalContribution, Math.round((m.totalDamage + m.totalHealing) * 100) / 100);
    // Derived rates are non-negative and consistent with the raw counts.
    assert.ok(m.damagePerCast >= 0 && m.damagePerGold >= 0 && m.damagePerCooldownSecond >= 0);
    assert.ok(m.averageTargetCount >= 0);
    assert.ok(m.killParticipation >= 0 && m.killParticipation <= 1 + 1e-9);
    assert.ok(m.kingdomId !== "unknown", `${m.abilityId} mapped to a kingdom`);
  }
  // The list is ranked by contribution.
  for (let i = 1; i < metrics.length; i++) {
    assert.ok(metrics[i - 1]!.totalContribution >= metrics[i]!.totalContribution);
  }
});

test("kingdom metrics break damage into sources that sum to 100%", () => {
  const metrics = kingdomMetrics(batch());
  assert.equal(metrics.length, kingdoms.length);
  for (const k of metrics) {
    const s = k.damageSources;
    const pct = s.ability.pct + s.ultimate.pct + s.status.pct + s.passive.pct + s.reflection.pct;
    // Either no damage (0) or shares sum to ~100%.
    assert.ok(pct === 0 || Math.abs(pct - 100) < 0.5, `${k.kingdomId} damage shares sum to ${pct}`);
    assert.ok(k.averageSurvivalSeconds > 0, `${k.kingdomId} has survival time`);
    assert.ok(k.averageCitizens > 0, `${k.kingdomId} has citizens`);
    assert.ok(k.economy.incomeEarnedAvg > 0);
    // Ability usage shares sum to ~100% when the kingdom cast anything.
    const usage = Object.values(k.abilityUsagePct).reduce((a, b) => a + b, 0);
    assert.ok(usage === 0 || Math.abs(usage - 100) < 0.5, `${k.kingdomId} usage sums to ${usage}`);
  }
});

test("passive metrics attribute contribution to the right kingdom", () => {
  const metrics = passiveMetrics(batch());
  // Nature's thorns and Electricity's AfterShock are damage passives that
  // should register in a fire/nature/electricity brawl.
  for (const p of metrics) {
    assert.ok(p.triggers > 0, `${p.cause} triggered`);
    assert.equal(
      p.contribution,
      Math.round((p.damageGained + p.healingGained + p.shieldGained) * 100) / 100,
    );
    assert.ok(p.kingdomId !== "unknown", `${p.cause} mapped to a kingdom`);
  }
  const thorns = metrics.find((p) => p.cause === "thorns");
  if (thorns) assert.equal(thorns.kingdomId, "nature");
});

test("match timelines expose parallel damage / economy / hp series and unlocks", () => {
  const tel = batch();
  const tl = matchTimelines(tel[0]!);
  assert.ok(tl.ticks.length > 0);
  for (const seat of tl.seats) {
    assert.equal(seat.damage.length, tl.ticks.length);
    assert.equal(seat.economy.length, tl.ticks.length);
    assert.equal(seat.hp.length, tl.ticks.length);
    // Cumulative damage never decreases.
    for (let i = 1; i < seat.damage.length; i++) {
      assert.ok(seat.damage[i]! >= seat.damage[i - 1]!);
    }
  }
});

test("status metrics aggregate effectiveness and attribute to the applying kingdom", () => {
  const metrics = statusMetrics(batch());
  assert.ok(metrics.length > 0, "some statuses were applied");
  for (const m of metrics) {
    assert.ok(m.applications > 0);
    assert.ok(m.averageDurationSeconds >= 0 && m.followUpDamage >= 0 && m.attacksBlocked >= 0);
    // Payoff-per-block is consistent with the raw totals.
    const expected = m.attacksBlocked > 0 ? Math.round((m.followUpDamage / m.attacksBlocked) * 100) / 100 : 0;
    assert.equal(m.followUpDamagePerBlock, expected);
  }
  // Poison is Nature's; Burn is Fire's — attributed from data, not hardcoded.
  const poison = metrics.find((m) => m.statusId === "poison");
  if (poison) assert.equal(poison.kingdomId, "nature");
  const burn = metrics.find((m) => m.statusId === "burn");
  if (burn) assert.equal(burn.kingdomId, "fire");
  // Ranked by follow-up damage (the headline "value" figure).
  for (let i = 1; i < metrics.length; i++) {
    assert.ok(metrics[i - 1]!.followUpDamage >= metrics[i]!.followUpDamage);
  }
});

test("explainMatch produces a non-empty narrative naming the winner", () => {
  const tel = batch();
  const text = explainMatch(tel[0]!);
  assert.ok(text.length > 0);
  if (tel[0]!.winnerKingdom) {
    assert.ok(text.includes(tel[0]!.winnerKingdom!), "names the winning kingdom");
  }
});
