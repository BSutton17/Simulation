import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  runHeadlessMatch,
  createHeadlessMatch,
  createBaselineAI,
  deriveSeed,
  normalizeSeed,
  mulberry32,
} from "../simulation/src/index.js";
import type {
  MatchRecord,
  PlayerSpec,
  SimulationObserver,
} from "../simulation/src/index.js";
import { GameLoop } from "../src/engine/GameLoop.js";
import { tickMatch } from "../src/engine/tick.js";
import type { Match } from "../src/match/Match.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * Ticket #201 — the simulation framework runs complete matches through the
 * production engine with no networking, rendering, or timers, and identical
 * seeds replay identically.
 */

const DUEL: PlayerSpec[] = [
  { kingdomId: "fire" },
  { kingdomId: "water" },
];

const BRAWL: PlayerSpec[] = [
  { kingdomId: "fire" },
  { kingdomId: "water" },
  { kingdomId: "ice" },
  { kingdomId: "nature" },
];

/** Stable projection of a player's gameplay state (modifier ids are cosmetic
 *  and intentionally random, so modifiers project to value shapes only). */
function projectPlayer(p: PlayerState) {
  return {
    id: p.id,
    hp: p.castle.hp,
    shield: p.castle.shield,
    citizens: p.economy.citizens,
    currency: p.economy.currency,
    incomePerTick: p.economy.incomePerTick,
    cooldowns: p.cooldowns,
    recharges: p.recharges,
    upgrades: p.upgrades,
    unlocked: p.unlocked,
    target: p.target,
    eliminated: p.eliminated,
    eliminatedAtTick: p.eliminatedAtTick,
    statuses: p.statuses.map((s) => ({ id: s.id, remainingTicks: s.remainingTicks, stacks: s.stacks })),
    // Modifier ids are engine-generated; since #203 they are deterministic
    // (match-tick + sequence, no Math.random/Date.now), so they participate
    // in the equality checks.
    modifiers: p.modifiers.map((m) => ({ id: m.id, stat: m.stat, op: m.op, value: m.value })),
  };
}

function projectMatch(match: Match) {
  return {
    phase: match.phase,
    tick: match.tick,
    winnerId: match.winnerId,
    players: match.gameState!.getPlayers().map(projectPlayer),
  };
}

test("simulations run complete matches with no networking or timers", () => {
  const result = runSimulation({ matches: 3, seed: 1234, players: DUEL });

  assert.equal(result.records.length, 3);
  for (const record of result.records) {
    assert.ok(record.endedAtTick > 0);
    assert.equal(record.players.length, 2);
    // Every match resolves: a winner emerged (baseline AIs do fight).
    assert.equal(record.timedOut, false);
    assert.ok(record.winnerId, "expected a winner");
    const winner = record.players.find((p) => p.id === record.winnerId)!;
    assert.ok(winner.hp > 0);
    assert.equal(record.winnerKingdom, winner.kingdomId);
    // Losers were eliminated at a definite tick.
    for (const p of record.players) {
      if (p.id !== record.winnerId) {
        assert.equal(p.hp, 0);
        assert.ok(p.eliminatedAtTick !== null);
      }
    }
  }
  assert.ok(result.totalTicks > 0);
});

test("identical seeds replay the entire run identically", () => {
  const config = { matches: 3, seed: "balance-run-1", players: BRAWL };
  const a = runSimulation(config);
  const b = runSimulation(config);
  // durationMs is wall-clock; the gameplay records must match exactly.
  assert.deepEqual(a.records, b.records);
  assert.equal(a.totalTicks, b.totalTicks);
});

test("different seeds produce independent (generally different) matches", () => {
  const a = runSimulation({ matches: 1, seed: 1, players: BRAWL });
  const b = runSimulation({ matches: 1, seed: 2, players: BRAWL });
  // Not asserting different winners (could legitimately coincide) — but the
  // full record should differ somewhere for a 4-player brawl.
  assert.notDeepEqual(a.records, b.records);
});

test("per-match seeds are index-derived: match k replays standalone", () => {
  const run = runSimulation({ matches: 3, seed: 777, players: DUEL });
  const third: MatchRecord = run.records[2]!;

  const standalone = runHeadlessMatch({
    players: DUEL,
    seed: deriveSeed(normalizeSeed(777), 2),
    createAI: createBaselineAI,
    index: 2,
  });
  assert.deepEqual(standalone, third);
});

test("the tick cap records a timeout instead of hanging", () => {
  const result = runSimulation({
    matches: 1,
    seed: 5,
    players: DUEL,
    maxTicks: 10, // nobody dies in half a second
  });
  const record = result.records[0]!;
  assert.equal(record.timedOut, true);
  assert.equal(record.endedAtTick, 10);
  assert.equal(record.winnerId, null);
});

test("observers see every lifecycle stage in order", () => {
  const events: string[] = [];
  const observer: SimulationObserver = {
    onMatchStart: (_m, index) => events.push(`start:${index}`),
    onMatchEnd: (record) => events.push(`end:${record.index}`),
    onComplete: (result) => events.push(`complete:${result.records.length}`),
  };
  runSimulation({
    matches: 2,
    seed: 9,
    players: DUEL,
    maxTicks: 20,
    observers: [observer],
  });
  assert.deepEqual(events, ["start:0", "end:0", "start:1", "end:1", "complete:2"]);
});

test("headless execution matches the live fixed-timestep loop exactly", () => {
  // The same seeded match, driven two ways:
  //  (a) the simulation's tight loop, and
  //  (b) the production GameLoop advanced by a simulated 50ms clock —
  // must land on identical gameplay state, tick for tick. Both paths call the
  // same tickMatch; this proves the simulation inherits live behavior.
  const seed = normalizeSeed("parity");
  const TICKS = 600; // 30 seconds of game time

  const runDriven = (drive: (matchTick: (t: number) => boolean) => void) => {
    // Match-level RNG (#203): the same seed makes both drivers roll the same
    // gameplay dice; the AIs no longer pin their own gameplay streams.
    const match = createHeadlessMatch(DUEL, {
      rng: mulberry32(deriveSeed(seed, 0)),
    });
    const state = match.gameState!;
    const controllers = state.getPlayers().map((p, i) => ({
      player: p,
      ai: createBaselineAI(p, mulberry32(deriveSeed(seed, i + 1))),
      rng: mulberry32(deriveSeed(seed, i + 1)),
    }));
    const step = (t: number): boolean => {
      for (const c of controllers) {
        if (c.player.eliminated) continue;
        c.ai.act({ match, player: c.player, tick: t, rng: c.rng });
      }
      return tickMatch(match, t);
    };
    drive(step);
    return projectMatch(match);
  };

  // (a) tight loop
  const headless = runDriven((step) => {
    for (let t = 1; t <= TICKS; t++) if (step(t)) break;
  });

  // (b) production GameLoop with a simulated clock (no real timers)
  const live = runDriven((step) => {
    let ended = false;
    const loop = new GameLoop({
      tickRate: 20,
      maxCatchUpTicks: 1,
      onTick: (t) => {
        if (!ended && t <= TICKS) ended = step(t);
      },
    });
    let now = 0;
    loop.advance(now); // primes the clock
    while (!ended && loop.currentTick < TICKS) {
      now += 50; // one tick of simulated real time
      loop.advance(now);
    }
  });

  assert.deepEqual(headless, live);
});
