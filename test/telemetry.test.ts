import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  personalityAI,
  AGGRESSIVE,
  type MatchTelemetry,
  type PlayerSpec,
} from "../simulation/src/index.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";

/**
 * Telemetry Foundation (Part 1): every simulated match carries a complete,
 * per-seat "what happened?" record, derived entirely from the event stream and
 * per-tick sampling.
 */

const brawl: PlayerSpec[] = ["fire", "water", "nature", "earth"].map((k) => ({
  kingdomId: k as PlayerSpec["kingdomId"],
  ai: personalityAI(AGGRESSIVE),
}));

function firstTelemetry(seed = "telemetry"): MatchTelemetry {
  const result = runSimulation({ matches: 1, seed, players: brawl });
  const tel = result.records[0]!.telemetry;
  assert.ok(tel, "telemetry attached to the record");
  return tel!;
}

test("telemetry is attached to every match by default", () => {
  const result = runSimulation({ matches: 3, seed: "attach", players: brawl });
  for (const record of result.records) {
    assert.ok(record.telemetry, `match ${record.index} has telemetry`);
    assert.equal(record.telemetry!.seats.length, brawl.length);
  }
});

test("telemetry can be disabled for throughput-critical runs", () => {
  const result = runSimulation({ matches: 1, seed: "off", players: brawl, telemetry: false });
  assert.equal(result.records[0]!.telemetry, undefined);
});

test("damage is broken down by source, shield vs castle, and overkill", () => {
  const tel = firstTelemetry();
  const totals = { ability: 0, ultimate: 0, status: 0, passive: 0, reflection: 0 };
  let toShield = 0;
  let toCastle = 0;
  let grand = 0;
  for (const seat of tel.seats) {
    const d = seat.damage;
    // The category buckets reconcile with the headline totals.
    const bucketed =
      sum(d.byAbility) + sum(d.byUltimate) + sum(d.byStatus) +
      sum(d.byPassive) + d.byReflection;
    assert.equal(bucketed, d.total, `${seat.kingdomId}: buckets sum to total`);
    assert.equal(d.toShield + d.toCastle, d.total, `${seat.kingdomId}: shield+castle = total`);
    assert.ok(d.overkill >= 0);
    totals.ability += sum(d.byAbility);
    totals.status += sum(d.byStatus);
    toShield += d.toShield;
    toCastle += d.toCastle;
    grand += d.total;
  }
  // A real fight happened: damage was dealt, some to shields, some to castles.
  assert.ok(grand > 0, "some damage dealt");
  assert.ok(toCastle > 0, "some castle damage");
  assert.ok(totals.ability > 0, "ability damage recorded");
  // Fire/Nature apply Burn/Poison, so status (DoT) damage should register.
  assert.ok(totals.status > 0, "status/DoT damage recorded");
});

test("healing separates effective from overheal, by cause", () => {
  const tel = firstTelemetry();
  for (const seat of tel.seats) {
    const h = seat.healing;
    assert.ok(h.effective >= 0 && h.overheal >= 0);
    assert.equal(sum(h.byCause), h.effective, `${seat.kingdomId}: heal causes sum to effective`);
  }
});

test("economy tracks income, gold-by-category, and floated gold", () => {
  const tel = firstTelemetry();
  for (const seat of tel.seats) {
    const e = seat.economy;
    assert.ok(e.incomeEarned > 0, `${seat.kingdomId} earned income`);
    assert.ok(e.incomeDenied >= 0);
    assert.ok(e.goldFloatedAvg >= 0);
    const s = e.spent;
    assert.equal(
      s.total,
      s.citizens + s.upgrades + s.unlocks + s.casts + s.repairs + s.shields,
      "spend categories sum to total",
    );
  }
});

test("ability usage tracks casts, timing, idle, and failures", () => {
  const tel = firstTelemetry();
  const anyCaster = tel.seats.find((s) => s.abilities.castCount > 0);
  assert.ok(anyCaster, "at least one seat cast an ability");
  const a = anyCaster!.abilities;
  assert.equal(sum(a.byAbility), a.castCount, "per-ability casts sum to castCount");
  assert.ok(a.firstCastTick !== null && a.firstCastTick > 0);
  assert.ok(a.failedCasts >= 0);
  assert.ok(a.cooldownIdleTicks >= 0);
});

test("combat records deaths, kills, shields, citizens, and time series", () => {
  const tel = firstTelemetry();
  let kills = 0;
  let deaths = 0;
  for (const seat of tel.seats) {
    const c = seat.combat;
    kills += c.kills;
    if (c.died) deaths += 1;
    // Parallel time series are sampled together (HP, cumulative damage, gold).
    const tl = seat.timeline;
    assert.ok(tl.hp.length > 0, `${seat.kingdomId} has an HP series`);
    assert.equal(tl.hp.length, tl.ticks.length);
    assert.equal(tl.damageDealt.length, tl.ticks.length);
    assert.equal(tl.currency.length, tl.ticks.length);
    assert.ok(c.citizensGained >= 0 && c.citizensLost >= 0);
    assert.equal(c.finalHp >= 0, true);
  }
  // A 4-player brawl ends with a winner: three seats died, and eliminations
  // were credited to killers.
  assert.ok(deaths >= 1, "at least one elimination");
  assert.ok(kills >= 1, "eliminations attributed to killers");
});

test("status effectiveness is tracked per status id, generically", () => {
  // Ice brings Freeze (a status that blocks attacks); Nature brings Poison.
  const result = runSimulation({
    matches: 6,
    seed: "status-eff",
    players: ["ice", "fire", "nature", "water"].map((k) => ({
      kingdomId: k as PlayerSpec["kingdomId"],
      ai: personalityAI(AGGRESSIVE),
    })),
  });
  const merged: Record<string, { applications: number; attacksBlocked: number; followUpDamage: number; kills: number; duration: number }> = {};
  for (const rec of result.records) {
    for (const [id, s] of Object.entries(rec.telemetry!.statusEffectiveness)) {
      const m = (merged[id] ??= { applications: 0, attacksBlocked: 0, followUpDamage: 0, kills: 0, duration: 0 });
      m.applications += s.applications;
      m.attacksBlocked += s.attacksBlocked;
      m.followUpDamage += s.followUpDamage;
      m.kills += s.killsDuringStatus;
      m.duration += s.totalDurationTicks;
      // Every field is an objective, non-negative count.
      assert.ok(s.applications >= 0 && s.attacksBlocked >= 0 && s.followUpDamage >= 0 && s.killsDuringStatus >= 0);
      assert.equal(s.averageDurationTicks, s.applications > 0 ? Math.round(s.totalDurationTicks / s.applications) : 0);
    }
  }
  // Both statuses appear automatically (no per-status code).
  assert.ok(merged.frozen?.applications > 0, "Freeze tracked");
  assert.ok(merged.poison?.applications > 0, "Poison tracked");
  // Damage lands on poisoned bearers → follow-up damage accrues to Poison.
  assert.ok(merged.poison.followUpDamage > 0, "Poison follow-up damage recorded");
});

test("attacks a status blocked are attributed to that status", () => {
  // `attacksBlocked` counts casts the engine REFUSED because the caster was
  // under crowd control — it is fed by `castFailed`, which only fires when a
  // player actually tries.
  //
  // The personality AIs never produce one. They spend their treasury on every
  // acting tick, so by the time a freeze lands there is nothing ready and
  // affordable left to attempt: measured over six matches, 623 ticks of someone
  // being attack-blocked yielded ZERO ticks where the bearer held a ready,
  // affordable attack, and zero failed casts of any kind. Asserting this metric
  // off a normal simulation therefore tests the AI's thrift, not the telemetry
  // — which is why it sat failing.
  //
  // A human absolutely does click while frozen, so the metric is real. It is
  // reproduced here with a controller that keeps swinging regardless, which
  // exercises the same end-to-end path the live game does: engine refusal →
  // `castFailed` with the responsible status → attribution.
  const stubborn: PlayerSpec["ai"] = () => ({
    act: ({ match, player }) => {
      if (match.phase !== "active" || player.eliminated) return;
      earn(player, 5000); // never broke, so the refusal is never about money
      for (const ability of abilitiesForKingdom(player.kingdomId)) {
        if (ability.kind !== "attack") continue;
        if (!player.unlocked[ability.id]) unlockOrUpgradeAbility(match, player, ability.id);
        activateAbility(match, player, ability, { targetId: player.target ?? undefined });
      }
    },
  });

  const result = runSimulation({
    matches: 2,
    seed: "status-blocks",
    players: [
      { kingdomId: "ice" as PlayerSpec["kingdomId"], ai: personalityAI(AGGRESSIVE) },
      { kingdomId: "water" as PlayerSpec["kingdomId"], ai: stubborn },
      { kingdomId: "fire" as PlayerSpec["kingdomId"], ai: stubborn },
    ],
  });

  let frozenApplications = 0;
  let frozenBlocks = 0;
  let blockedByAnythingElse = 0;
  for (const rec of result.records) {
    for (const [id, s] of Object.entries(rec.telemetry!.statusEffectiveness)) {
      if (id === "frozen") {
        frozenApplications += s.applications;
        frozenBlocks += s.attacksBlocked;
      } else {
        blockedByAnythingElse += s.attacksBlocked;
      }
    }
  }

  assert.ok(frozenApplications > 0, "Ice never froze anyone, so nothing was blocked");
  assert.ok(frozenBlocks > 0, "Freeze barred attacks but none were attributed to it");
  // And ONLY crowd control claims them: a burn or a poison must never be
  // credited with stopping an attack it had nothing to do with.
  assert.equal(
    blockedByAnythingElse,
    0,
    "a status that does not bar attacking was credited with blocking one",
  );
});

test("telemetry is deterministic under a fixed seed", () => {
  const a = firstTelemetry("determinism");
  const b = firstTelemetry("determinism");
  assert.deepEqual(a, b);
});

function sum(record: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(record)) total += v;
  return total;
}
