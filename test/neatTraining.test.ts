import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ELEMENTALS_SHAPE,
  aggregate,
  buildSlate,
  estimateMatches,
  evaluateGenome,
  identityMismatches,
  localIdentity,
  placementOf,
  readCheckpoint,
  scoreMatch,
  slateSize,
  toModel,
  train,
  trainingConfig,
  writeCheckpoint,
  type TrainingCheckpoint,
} from "../simulation/src/training/index.js";
import {
  NeatRng,
  Population,
  createGenome,
  withConfig,
} from "../simulation/src/neat/index.js";
import { assertModelCompatible } from "../simulation/src/ai/index.js";
import type { MatchRecord } from "../simulation/src/types.js";

/**
 * The adapter: genome → network → controller → real Elementals matches.
 *
 * These are the tests that touch the game, so they are deliberately small —
 * one or two genomes over a few thousand ticks. The point is that the pipeline
 * carries current and that fitness means what it claims, not that anything has
 * learned to play.
 */

function record(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    index: 0,
    seed: 1,
    winnerId: "p0",
    winnerKingdom: "water",
    endedAtTick: 5_000,
    timedOut: false,
    players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 6_000, shield: 0, citizens: 10, currency: 0, eliminatedAtTick: null },
      { id: "p1", name: "b", kingdomId: "fire", hp: 0, shield: 0, citizens: 5, currency: 0, eliminatedAtTick: 4_000 },
    ],
    ...overrides,
  };
}

// ── fitness ─────────────────────────────────────────────────────────────

test("placement ranks the winner first and the earliest death last", () => {
  const r = record();
  assert.equal(placementOf(r, "p0"), 1);
  assert.equal(placementOf(r, "p1"), 2);
});

test("winning scores far above losing", () => {
  const config = trainingConfig().fitness;
  const win = scoreMatch(record(), "p0", 5, config);
  const loss = scoreMatch(record(), "p1", 5, config);
  assert.ok(win.score > loss.score + 0.5, `win ${win.score} vs loss ${loss.score}`);
  assert.equal(win.won, true);
  assert.equal(loss.won, false);
});

test("a timeout is capped however healthy the castle", () => {
  // The turtle guard. Placement ranks timeout survivors by remaining HP, so
  // without this a genome that shields and never attacks places first.
  const config = trainingConfig().fitness;
  const timeout = record({
    winnerId: null,
    timedOut: true,
    players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 9_999, shield: 0, citizens: 40, currency: 0, eliminatedAtTick: null },
      { id: "p1", name: "b", kingdomId: "fire", hp: 100, shield: 0, citizens: 1, currency: 0, eliminatedAtTick: null },
    ],
  });
  const score = scoreMatch(timeout, "p0", 5, config);
  assert.equal(score.placement, 1, "the turtle did place first");
  assert.ok(score.score <= config.timeoutCap, `timeout scored ${score.score}`);
});

test("a genome that never cast anything scores nothing", () => {
  const config = trainingConfig().fitness;
  assert.equal(scoreMatch(record(), "p0", 0, config).score, config.inactivityScore);
});

test("surviving longer breaks ties between losses", () => {
  const config = trainingConfig().fitness;
  const early = scoreMatch(
    record({ winnerId: "p1", winnerKingdom: "fire", players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 0, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: 500 },
      { id: "p1", name: "b", kingdomId: "fire", hp: 10, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: null },
    ] }),
    "p0", 5, config,
  );
  const late = scoreMatch(
    record({ winnerId: "p1", winnerKingdom: "fire", players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 0, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: 4_900 },
      { id: "p1", name: "b", kingdomId: "fire", hp: 10, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: null },
    ] }),
    "p0", 5, config,
  );
  assert.ok(late.score > early.score);
});

test("aggregation averages a slate", () => {
  const config = trainingConfig().fitness;
  const scores = [scoreMatch(record(), "p0", 5, config), scoreMatch(record(), "p1", 5, config)];
  const totals = aggregate(scores);
  assert.equal(totals.matches, 2);
  assert.equal(totals.wins, 1);
  assert.ok(Math.abs(totals.fitness - (scores[0]!.score + scores[1]!.score) / 2) < 1e-9);
});

// ── the slate ───────────────────────────────────────────────────────────

test("a slate varies the matchup, not just the seed", () => {
  // The constraint the module exists for: a deterministic policy replays the
  // same match on every seed, so variance has to come from the matchup.
  const config = trainingConfig();
  const slate = buildSlate(0, config.slate, config.kingdoms, 1);
  assert.equal(slate.length, slateSize(config.slate, config.kingdoms.length));
  assert.ok(new Set(slate.map((e) => e.kingdom)).size > 1, "one kingdom only");
  assert.ok(new Set(slate.map((e) => e.opponentProfiles[0])).size > 1, "one opponent only");
  assert.equal(new Set(slate.map((e) => e.seed)).size, slate.length, "seeds should be distinct");
});

test("the slate rotates between generations but is fixed within one", () => {
  const config = trainingConfig();
  const first = buildSlate(0, config.slate, config.kingdoms, 1);
  const again = buildSlate(0, config.slate, config.kingdoms, 1);
  const later = buildSlate(1, config.slate, config.kingdoms, 1);
  assert.deepEqual(first, again, "a generation's slate must be stable for every genome");
  assert.notDeepEqual(
    first.map((e) => e.kingdom),
    later.map((e) => e.kingdom),
    "consecutive generations should not repeat the same matchups",
  );
});

// ── real matches ────────────────────────────────────────────────────────

test("a genome plays real Elementals matches and receives a fitness", () => {
  const config = trainingConfig({
    slate: { ...trainingConfig().slate, kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1, maxTicks: 3_000 },
  });
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const population = new Population(ELEMENTALS_SHAPE, withConfig({ populationSize: 2, activation: "tanh", initialConnectivity: 0.25 }), 7);
  const genome = population.ask()[0]!;

  const evaluation = evaluateGenome(genome, slate, config.fitness, config.slate.maxTicks);
  assert.equal(evaluation.matches, slate.length);
  assert.ok(Number.isFinite(evaluation.fitness));
  assert.ok(evaluation.fitness >= 0);
  assert.ok(evaluation.scores.every((s) => s.placement >= 1 && s.placement <= 2));
});

test("evaluating the same genome twice gives the same fitness", () => {
  const config = trainingConfig({
    slate: { ...trainingConfig().slate, kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1, maxTicks: 3_000 },
  });
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const genome = new Population(ELEMENTALS_SHAPE, withConfig({ populationSize: 1, activation: "tanh", initialConnectivity: 0.25 }), 3).ask()[0]!;
  const first = evaluateGenome(genome, slate, config.fitness, config.slate.maxTicks);
  const second = evaluateGenome(genome, slate, config.fitness, config.slate.maxTicks);
  assert.equal(first.fitness, second.fitness);
  assert.deepEqual(first.scores.map((s) => s.placement), second.scores.map((s) => s.placement));
});

test("a short training run completes and produces a champion", () => {
  const config = trainingConfig({
    generations: 2,
    neat: withConfig({ populationSize: 4, activation: "tanh", initialConnectivity: 0.25 }),
    slate: { ...trainingConfig().slate, kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1, maxTicks: 2_500 },
  });
  const result = train({ config });
  assert.equal(result.generations, 2);
  assert.equal(result.history.length, 2);
  assert.ok(Number.isFinite(result.bestFitness));
  assert.ok(result.best.connections.length > 0);
  for (const record of result.history) {
    assert.equal(record.matches, 4 * slateSize(config.slate, config.kingdoms.length));
  }
});

test("estimateMatches matches what a run actually plays", () => {
  const config = trainingConfig({
    generations: 2,
    neat: withConfig({ populationSize: 3, activation: "tanh", initialConnectivity: 0.25 }),
    slate: { ...trainingConfig().slate, kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1, maxTicks: 2_000 },
  });
  const result = train({ config });
  const played = result.history.reduce((sum, r) => sum + r.matches, 0);
  assert.equal(played, estimateMatches(config));
});

// ── checkpoints ─────────────────────────────────────────────────────────

test("a training run checkpoints and resumes without restarting", () => {
  const dir = mkdtempSync(join(tmpdir(), "neat-"));
  try {
    const path = join(dir, "checkpoint.json");
    const config = trainingConfig({
      generations: 2,
      checkpointEvery: 1,
      neat: withConfig({ populationSize: 4, activation: "tanh", initialConnectivity: 0.25 }),
      slate: { ...trainingConfig().slate, kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1, maxTicks: 2_000 },
    });

    const first = train({ config, checkpointPath: path });
    assert.equal(first.generations, 2);

    // Resuming a finished run does no further work but must not silently start
    // a fresh random population either.
    const resumed = train({ config, checkpointPath: path, resume: true });
    assert.equal(resumed.resumedFrom, 2, "should have resumed from the checkpoint");
    assert.equal(resumed.checkpointRejected, null);
    assert.equal(resumed.history.length, 2, "history should carry over, not restart");

    // Extending the run continues from where it stopped.
    const extended = train({
      config: { ...config, generations: 3 },
      checkpointPath: path,
      resume: true,
    });
    assert.equal(extended.resumedFrom, 2);
    assert.equal(extended.history.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkpoint from a different configuration is refused, and named", () => {
  const dir = mkdtempSync(join(tmpdir(), "neat-"));
  try {
    const path = join(dir, "checkpoint.json");
    const config = trainingConfig({ seed: 111 });
    const identity = localIdentity(config);
    const checkpoint: TrainingCheckpoint = {
      version: "v1",
      identity,
      writtenAt: new Date().toISOString(),
      completedGenerations: 1,
      population: new Population(ELEMENTALS_SHAPE, config.neat, config.seed).snapshot(),
      history: [],
    };
    writeCheckpoint(path, checkpoint);

    const other = localIdentity(trainingConfig({ seed: 222 }));
    const load = readCheckpoint(path, other);
    assert.equal(load.checkpoint, null);
    assert.match(load.rejected ?? "", /seed: 111 -> 222/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identity refuses on the observation schema, which invalidates weights", () => {
  const identity = localIdentity(trainingConfig());
  const stale = { ...identity, observationVersion: "v0" };
  const mismatches = identityMismatches(stale, identity);
  assert.ok(mismatches.some((m) => m.startsWith("observationVersion")));
  // A dirty engine tree is recorded but never blocks a resume.
  assert.deepEqual(identityMismatches({ ...identity, engineDirty: !identity.engineDirty }, identity), []);
});

test("a missing checkpoint is not an error", () => {
  const load = readCheckpoint(join(tmpdir(), "definitely-not-here-neat.json"), localIdentity(trainingConfig()));
  assert.equal(load.checkpoint, null);
  assert.equal(load.rejected, null);
});

// ── models and difficulty ───────────────────────────────────────────────

test("a trained genome becomes a model carrying full provenance", () => {
  const config = trainingConfig();
  const genome = createGenome("champion", ELEMENTALS_SHAPE);
  const model = toModel(genome, config, "hard", 12);

  assert.equal(model.kind, "elementals.ai.model");
  assert.equal(model.difficulty, "hard");
  assert.equal(model.training.generation, 12);
  assert.equal(model.identity.kingdomCount, 16);
  assert.ok(model.identity.balanceConfigHash.length > 0);
  assert.ok(model.identity.balanceBaselineHash.length > 0);
  assert.ok(model.identity.engineSha.length > 0);
  // And it loads against this build.
  assert.doesNotThrow(() => assertModelCompatible(model));
});

test("all three difficulties come from one engine and one genome", () => {
  // Difficulty is a property of the MODEL plus the runtime cadence, never a
  // separate algorithm — which is what keeps Easy/Medium/Hard one lineage.
  const config = trainingConfig();
  const genome = createGenome("champion", ELEMENTALS_SHAPE);
  const models = (["easy", "medium", "hard"] as const).map((d) => toModel(genome, config, d, 5));
  for (const model of models) {
    assert.doesNotThrow(() => assertModelCompatible(model));
    assert.deepEqual(model.genome, genome, "the same genome backs every difficulty");
  }
  assert.deepEqual(models.map((m) => m.difficulty), ["easy", "medium", "hard"]);
});

test("the evolution RNG is serializable and resumes mid-stream", () => {
  const rng = new NeatRng(12345);
  for (let i = 0; i < 50; i++) rng.next();
  const resumed = NeatRng.fromState(rng.state);
  assert.equal(resumed.next(), NeatRng.fromState(rng.state).next());
});
