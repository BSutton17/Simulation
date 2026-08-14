import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  AnalyticsCollector,
  usageByKind,
  type GameplayEvent,
  type MatchRecord,
  type PlayerSpec,
  type SimulationObserver,
} from "../simulation/src/index.js";
import { activateAbility } from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { SCORCHING_SUN } from "../src/data/fireAbilities.js";
import { ALL_ABILITIES } from "../src/data/abilitiesRegistry.js";
import type { AIController } from "../simulation/src/index.js";

/**
 * Ticket #207 — the analytics framework: statistics derived from the gameplay
 * event stream must accurately match gameplay outcomes, and aggregate
 * automatically across matches and batches.
 */

const BRAWL: PlayerSpec[] = [
  { kingdomId: "fire" },
  { kingdomId: "water" },
  { kingdomId: "ice" },
];

test("aggregates exactly match an independent recount of the same gameplay", () => {
  // The collector and a raw recorder watch the SAME matches; every aggregate
  // must equal the recount from raw events + final records.
  const collector = new AnalyticsCollector();
  const raw: { events: GameplayEvent[]; records: MatchRecord[]; kingdomOf: Map<string, string> } = {
    events: [],
    records: [],
    kingdomOf: new Map(),
  };
  const recorder: SimulationObserver = {
    onMatchStart: (match) => {
      for (const p of match.gameState!.getPlayers()) {
        raw.kingdomOf.set(p.id, p.kingdomId ?? "unknown");
      }
    },
    onEvent: (e) => raw.events.push(structuredClone(e)),
    onMatchEnd: (record) => raw.records.push(structuredClone(record)),
  };

  const result = runSimulation({
    matches: 3,
    seed: "analytics-accuracy",
    players: BRAWL,
    observers: [collector, recorder],
  });
  const snapshot = collector.snapshot();

  // Match-level facts from records.
  assert.equal(snapshot.matches, 3);
  assert.equal(snapshot.timeouts, raw.records.filter((r) => r.timedOut).length);
  assert.equal(snapshot.totalTicks, result.totalTicks);
  assert.equal(
    snapshot.averageDurationTicks,
    raw.records.reduce((s, r) => s + r.endedAtTick, 0) / 3,
  );

  // Per-kingdom recounts (each kingdom has exactly one seat per match here).
  for (const kingdom of ["fire", "water", "ice"]) {
    const k = snapshot.kingdoms[kingdom]!;
    const seatIds = new Set(
      [...raw.kingdomOf.entries()].filter(([, kg]) => kg === kingdom).map(([id]) => id),
    );

    assert.equal(k.matches, 3);
    assert.equal(
      k.wins,
      raw.records.filter((r) => {
        const winner = r.players.find((p) => p.id === r.winnerId);
        return winner?.kingdomId === kingdom;
      }).length,
    );
    assert.equal(k.winRate, k.wins / 3);

    const damageDealt = raw.events
      .filter((e) => e.type === "damage" && seatIds.has(e.sourceId))
      .reduce((s, e) => s + (e as Extract<GameplayEvent, { type: "damage" }>).amount, 0);
    assert.equal(k.damageDealt, damageDealt);

    const damageTaken = raw.events
      .filter((e) => e.type === "damage" && seatIds.has((e as never as { targetId: string }).targetId))
      .reduce((s, e) => s + (e as Extract<GameplayEvent, { type: "damage" }>).amount, 0);
    assert.equal(k.damageTaken, damageTaken);

    const crits = raw.events.filter(
      (e) => e.type === "damage" && seatIds.has(e.sourceId) && e.crit,
    ).length;
    assert.equal(k.criticalHits, crits);

    const healing = raw.events
      .filter((e) => e.type === "heal" && seatIds.has(e.targetId))
      .reduce((s, e) => s + (e as Extract<GameplayEvent, { type: "heal" }>).amount, 0);
    assert.equal(k.healingReceived, healing);

    const shieldGained = raw.events
      .filter((e) => e.type === "shieldGained" && seatIds.has(e.playerId))
      .reduce((s, e) => s + (e as Extract<GameplayEvent, { type: "shieldGained" }>).amount, 0);
    assert.equal(k.shieldGained, shieldGained);

    const purchases = raw.events.filter(
      (e): e is Extract<GameplayEvent, { type: "purchase" }> =>
        e.type === "purchase" && seatIds.has(e.playerId),
    );
    assert.equal(k.citizensBought, purchases.filter((p) => p.kind === "citizen").length);
    assert.equal(k.unlocksPurchased, purchases.filter((p) => p.kind === "unlock").length);
    assert.equal(k.upgradesPurchased, purchases.filter((p) => p.kind === "upgrade").length);
    assert.equal(
      k.goldSpentOnPurchases,
      purchases.reduce((s, p) => s + p.cost, 0),
    );

    const casts = raw.events.filter(
      (e): e is Extract<GameplayEvent, { type: "abilityCast" }> =>
        e.type === "abilityCast" && seatIds.has(e.casterId),
    );
    assert.equal(k.goldSpentOnCasts, casts.reduce((s, c) => s + c.cost, 0));
    assert.equal(
      Object.values(k.abilityUsage).reduce((s, n) => s + n, 0),
      casts.length,
    );

    const switches = raw.events.filter(
      (e) => e.type === "targetChanged" && seatIds.has(e.playerId),
    ).length;
    assert.equal(k.targetSwitches, switches);

    const finalCitizens = raw.records.reduce((s, r) => {
      const seat = r.players.find((p) => p.kingdomId === kingdom)!;
      return s + seat.citizens;
    }, 0);
    assert.equal(k.citizensFinal, finalCitizens);

    // Eliminations recount.
    const eliminations = raw.records.reduce(
      (s, r) =>
        s + (r.players.find((p) => p.kingdomId === kingdom)!.eliminatedAtTick !== null ? 1 : 0),
      0,
    );
    assert.equal(k.eliminations, eliminations);
  }
});

test("status uptime measures exactly the applied duration", () => {
  // A scripted controller: seat 0 casts Scorching Sun once — its Burn's
  // uptime must equal the exact tick span from apply to expiry.
  const scripted: AIController = {
    act: ({ match, player, tick }) => {
      if (tick !== 5) return;
      earn(player, 1_000); // fund the scripted cast
      const r = activateAbility(match, player, SCORCHING_SUN, {
        targetId: "p1",
        forceCrit: false,
        rng: () => 0.99,
      });
      assert.equal(r.ok, true);
    },
  };
  const inert: AIController = { act: () => {} };

  const collector = new AnalyticsCollector();
  let applied: { tick: number; durationTicks: number } | null = null;
  let expired: { tick: number } | null = null;
  const watcher: SimulationObserver = {
    onEvent: (e) => {
      if (e.type === "statusApplied" && e.statusId === "burn") {
        applied = { tick: e.tick, durationTicks: e.durationTicks };
      }
      if (e.type === "statusExpired" && e.statusId === "burn") {
        expired = { tick: e.tick };
      }
    },
  };

  runSimulation({
    matches: 1,
    seed: 11,
    players: [{ kingdomId: "fire" }, { kingdomId: "water" }],
    maxTicks: 600, // outlives the burn comfortably
    createAI: (player) => (player.id === "p0" ? scripted : inert),
    observers: [collector, watcher],
  });

  assert.ok(applied, "burn was never applied");
  assert.ok(expired, "burn never expired");
  const uptime = collector.snapshot().kingdoms["water"]!.statusUptime["burn"];
  assert.equal(uptime, expired!.tick - applied!.tick);
});

test("placements rank winner first, then later deaths", () => {
  const collector = new AnalyticsCollector();
  runSimulation({
    matches: 4,
    seed: "placement",
    players: BRAWL,
    observers: [collector],
  });
  const snapshot = collector.snapshot();

  const placements = Object.values(snapshot.kingdoms).map((k) => k.averagePlacement);
  // Three seats: averages live in [1, 3] and jointly average to 2.
  for (const p of placements) assert.ok(p >= 1 && p <= 3);
  const mean = placements.reduce((s, p) => s + p, 0) / placements.length;
  assert.ok(Math.abs(mean - 2) < 1e-9);

  // Winners' placement contribution is 1: a kingdom that won w of m matches
  // can average at most (w·1 + (m−w)·3)/m.
  for (const k of Object.values(snapshot.kingdoms)) {
    assert.ok(k.averagePlacement <= (k.wins + (k.matches - k.wins) * 3) / k.matches);
  }
});

test("one collector aggregates across consecutive batches automatically", () => {
  const collector = new AnalyticsCollector();
  const config = { matches: 2, seed: 5, players: BRAWL, observers: [collector] };
  runSimulation(config);
  const afterOne = collector.snapshot();
  runSimulation({ ...config, seed: 6 });
  const afterTwo = collector.snapshot();

  assert.equal(afterOne.matches, 2);
  assert.equal(afterTwo.matches, 4);
  assert.equal(afterTwo.kingdoms["fire"]!.matches, 4);
  assert.ok(afterTwo.totalTicks > afterOne.totalTicks);
});

test("usageByKind slices ability usage via metadata", () => {
  const collector = new AnalyticsCollector();
  runSimulation({ matches: 1, seed: 3, players: BRAWL, observers: [collector] });
  const fire = collector.snapshot().kingdoms["fire"]!;

  const recount = Object.entries(fire.abilityUsage)
    .filter(([id]) => ALL_ABILITIES[id]?.kind === "attack")
    .reduce((s, [, n]) => s + n, 0);
  assert.equal(usageByKind(fire, "attack"), recount);
  assert.ok(recount > 0);
});
