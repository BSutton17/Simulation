import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeadlessMatch } from "../simulation/src/headless.js";
import { mulberry32 } from "../simulation/src/rng.js";
import {
  NetworkController,
  randomNetwork,
  type ControllerStats,
} from "../simulation/src/ai/index.js";
import type { AIFactory } from "../simulation/src/types.js";
import type { KingdomId } from "../src/data/kingdoms.js";

/**
 * The runtime, proved in real matches.
 *
 * Everything above this file tests a stage in isolation. This one asserts the
 * whole path carries current:
 *
 *   game → visibility → knowledge → 64 observations → network → 22 outputs
 *        → action mask → legal action → game
 *
 * The controller is driven by a randomly-drawn network and is not trying to
 * play well. What matters is that it decides, spends, casts, retargets, waits,
 * never proposes something the engine refuses, and never crashes a match.
 */

/** Builds controllers while keeping their stats reachable. */
function trackingFactory(difficulty: "easy" | "medium" | "hard" = "hard"): {
  factory: AIFactory;
  stats: ControllerStats[];
} {
  const stats: ControllerStats[] = [];
  const factory: AIFactory = (player, rng) => {
    const controller = new NetworkController(player, {
      network: randomNetwork(rng),
      rng,
      difficulty,
    });
    stats.push(controller.stats);
    return controller;
  };
  return { factory, stats };
}

function total(stats: ControllerStats[], key: keyof ControllerStats): number {
  return stats.reduce((sum, s) => sum + s[key], 0);
}

function play(kingdoms: KingdomId[], seed: number, maxTicks = 8_000) {
  const { factory, stats } = trackingFactory();
  const record = runHeadlessMatch({
    players: kingdoms.map((kingdomId) => ({ kingdomId })),
    seed,
    maxTicks,
    createAI: factory,
    telemetry: false,
  });
  return { record, stats };
}

test("a random-network controller completes a duel without crashing", () => {
  const { record, stats } = play(["water", "fire"], 1001);
  assert.ok(record.endedAtTick > 0);
  assert.equal(stats.length, 2, "both seats should have been given a controller");
  assert.ok(total(stats, "decisions") > 0, "no decisions were made");
});

test("it exercises every branch of the action space", () => {
  // Four seats and a longer cap, so the aggregate has a fair chance to touch
  // each branch at least once. These are existence checks, not quality ones.
  const { stats } = play(["water", "fire", "earth", "nature"], 2002, 12_000);
  assert.ok(total(stats, "casts") > 0, "never cast an ability");
  assert.ok(total(stats, "invests") > 0, "never unlocked or upgraded anything");
  assert.ok(total(stats, "citizens") > 0, "never hired a citizen");
  assert.ok(total(stats, "retargets") > 0, "never switched target");
  assert.ok(total(stats, "waits") > 0, "never waited");
});

test("no proposed action is ever refused by the engine", () => {
  // The mask is a second implementation of the engine's rules. A nonzero count
  // here means the two have drifted — a defect, not a strategy problem.
  const seeds = [3003, 3004, 3005];
  for (const seed of seeds) {
    const { stats } = play(["water", "fire", "earth", "ice"], seed, 8_000);
    assert.equal(
      total(stats, "rejected"),
      0,
      `seed ${seed}: the engine refused an action the mask permitted`,
    );
  }
});

test("it plays every kingdom without crashing", () => {
  const kingdoms: KingdomId[] = [
    "water", "fire", "air", "earth", "electricity", "ice", "nature", "time",
    "space", "love", "joker", "light", "dark", "kitsune", "magma", "insects",
  ];
  for (let i = 0; i < kingdoms.length; i += 2) {
    const pair = [kingdoms[i]!, kingdoms[i + 1]!];
    const { record, stats } = play(pair, 4000 + i, 6_000);
    assert.ok(record.endedAtTick > 0, `${pair.join(" vs ")} produced no ticks`);
    assert.equal(total(stats, "rejected"), 0, `${pair.join(" vs ")} had rejections`);
  }
});

test("a seven-seat free-for-all runs", () => {
  const { record, stats } = play(
    ["water", "fire", "air", "earth", "electricity", "ice", "nature"],
    5005,
    10_000,
  );
  assert.ok(record.endedAtTick > 0);
  assert.equal(stats.length, 7);
  const why: Record<string, number> = {};
  for (const st of stats) {
    for (const [k, v] of Object.entries(st.rejectedBy)) why[k] = (why[k] ?? 0) + v;
  }
  assert.equal(total(stats, "rejected"), 0, `engine refused: ${JSON.stringify(why)}`);
});

test("matches replay identically on the same seed", () => {
  // Determinism has to survive the AI being random, or nothing downstream of it
  // can be reproduced. The network's weights are drawn from the seat's seeded
  // stream, so "random" is still replayable.
  const a = play(["water", "fire", "earth"], 6006);
  const b = play(["water", "fire", "earth"], 6006);
  assert.equal(a.record.endedAtTick, b.record.endedAtTick);
  assert.equal(a.record.winnerKingdom, b.record.winnerKingdom);
  assert.deepEqual(
    a.record.players.map((p) => [p.kingdomId, p.hp, p.currency]),
    b.record.players.map((p) => [p.kingdomId, p.hp, p.currency]),
  );
  assert.deepEqual(a.stats, b.stats, "controller decisions diverged across replays");
});

test("different seeds produce different matches", () => {
  // Guards against the replay test above passing because nothing ever varies.
  const a = play(["water", "fire", "earth"], 7007);
  const b = play(["water", "fire", "earth"], 8008);
  assert.notDeepEqual(a.stats, b.stats);
});

test("the difficulty cadence changes how often a seat decides", () => {
  const counts = (["hard", "medium", "easy"] as const).map((difficulty) => {
    const { factory, stats } = trackingFactory(difficulty);
    runHeadlessMatch({
      players: [{ kingdomId: "water" }, { kingdomId: "fire" }],
      seed: 9009,
      maxTicks: 4_000,
      createAI: factory,
      telemetry: false,
    });
    return total(stats, "decisions");
  });
  const [hard, medium, easy] = counts as [number, number, number];
  assert.ok(hard > medium, `hard ${hard} should decide more often than medium ${medium}`);
  assert.ok(medium > easy, `medium ${medium} should decide more often than easy ${easy}`);
});

test("a fully blocked seat waits instead of failing", () => {
  // Drives a seat into the corner the WAIT floor exists for: broke, frozen,
  // shop sealed. It must keep deciding, and every decision must be a wait.
  const { factory, stats } = trackingFactory();
  runHeadlessMatch({
    players: [{ kingdomId: "water" }, { kingdomId: "fire" }],
    seed: 1234,
    maxTicks: 400,
    createAI: (player, rng) => {
      const controller = factory(player, rng);
      if (player.id === "p0") {
        player.economy.currency = 0;
        player.statuses.push({
          id: "frozen", sourceId: "p1", remainingTicks: 100_000, stacks: 1,
          blocksAttacks: true,
        }, {
          id: "toxicGas", sourceId: "p1", remainingTicks: 100_000, stacks: 1,
          blocksPurchases: true,
        }, {
          id: "fireflies", sourceId: "p1", remainingTicks: 100_000, stacks: 1,
          blocksBearerShield: true,
        });
      }
      return controller;
    },
    telemetry: false,
  });
  const blocked = stats[0]!;
  assert.ok(blocked.decisions > 0, "the blocked seat stopped deciding");
  assert.ok(blocked.forcedWaits > 0, "the WAIT floor was never exercised");
  assert.equal(blocked.rejected, 0);
});
