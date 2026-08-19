import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../simulation/src/training/parallel/runner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ELEMENTALS_SHAPE,
  aggregate,
  buildSlate,
  estimateMatches,
  evaluateCandidate,
  evaluateGenome,
  formatBaselines,
  hashSlate,
  identityMismatches,
  localIdentity,
  maxScore,
  personalityCandidate,
  placementOf,
  randomCandidate,
  runBaselines,
  scoreScenario,
  slateShapeHash,
  slateSize,
  toModel,
  train,
  trainingConfig,
  writeCheckpoint,
  type ScenarioContext,
  type TrainingCheckpoint,
} from "../simulation/src/training/index.js";
import { NeatRng, Population, createGenome, withConfig } from "../simulation/src/neat/index.js";
import { assertModelCompatible } from "../simulation/src/ai/index.js";
import type { MatchRecord } from "../simulation/src/types.js";

/**
 * The training harness: slate, fitness, real matches, baselines, checkpoints.
 *
 * The tests that touch the game are deliberately small — a couple of genomes
 * over a few thousand ticks. They prove the pipeline carries current and that
 * fitness means what it claims, not that anything has learned to play.
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

function context(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return {
    scenarioId: "duel:water:balanced:s0:r0",
    format: "duel",
    seats: 2,
    kingdom: "water",
    seat: 0,
    combat: { damageDealt: 5_000, damageReceived: 5_000, shieldAbsorbed: 0, kills: 1, healingReceived: 0 },
    behaviour: { casts: 20, invests: 3, citizens: 5, repairs: 1, shields: 1, retargets: 2, waits: 10, decisions: 100 },
    ...overrides,
  };
}

const FIT = trainingConfig().fitness;

// ── fitness ─────────────────────────────────────────────────────────────

test("placement ranks the winner first and the earliest death last", async () => {
  assert.equal(placementOf(record(), "p0"), 1);
  assert.equal(placementOf(record(), "p1"), 2);
});

test("winning dominates the formula", async () => {
  const win = scoreScenario(record(), "p0", context(), FIT);
  const loss = scoreScenario(record(), "p1", context(), FIT);
  assert.equal(win.won, true);
  assert.equal(loss.lost, true);
  // The win term alone must outweigh everything a loss can accumulate.
  assert.ok(win.score > loss.score, `win ${win.score} vs loss ${loss.score}`);
  assert.ok(
    FIT.winWeight > FIT.placementWeight + FIT.survivalWeight + FIT.combatWeight,
    "winning must dominate the shaping terms",
  );
});

test("a strong win scores above a weak win", async () => {
  // Same victory, different quality: healthier castle, better exchange ratio.
  const strong = scoreScenario(
    record(),
    "p0",
    context({ combat: { damageDealt: 9_000, damageReceived: 1_000, shieldAbsorbed: 0, kills: 1, healingReceived: 0 } }),
    FIT,
  );
  const weak = scoreScenario(
    record(),
    "p0",
    context({ combat: { damageDealt: 3_000, damageReceived: 8_000, shieldAbsorbed: 0, kills: 1, healingReceived: 0 } }),
    FIT,
  );
  assert.ok(strong.score > weak.score, `strong ${strong.score} vs weak ${weak.score}`);
  assert.ok(strong.terms.combat > weak.terms.combat);
});

test("a draw sits between a win and a loss", async () => {
  const drawn = record({ winnerId: null, winnerKingdom: null, players: [
    { id: "p0", name: "a", kingdomId: "water", hp: 0, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: 5_000 },
    { id: "p1", name: "b", kingdomId: "fire", hp: 0, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: 5_000 },
  ] });
  const result = scoreScenario(drawn, "p0", context(), FIT);
  assert.equal(result.drawn, true);
  assert.equal(result.won, false);
  assert.equal(result.lost, false);
  assert.equal(result.terms.win, 0, "a draw earns no win term");
  assert.ok(result.score > 0, "but it still scores its shaping terms");
});

test("placement differences move the score in free-for-all", async () => {
  const seven = (place: number): MatchRecord =>
    record({
      winnerId: "p9",
      players: Array.from({ length: 7 }, (_, i) => ({
        id: i === 0 ? "p0" : `p${i}`,
        name: `s${i}`,
        kingdomId: "water",
        hp: 0,
        shield: 0,
        citizens: 0,
        currency: 0,
        // Earlier elimination = worse placement. p0 dies at a tick that puts it
        // in the requested position.
        eliminatedAtTick: i === 0 ? 1_000 * (8 - place) : 1_000 * (i + 1),
      })),
    });
  const second = scoreScenario(seven(2), "p0", context({ seats: 7 }), FIT);
  const sixth = scoreScenario(seven(6), "p0", context({ seats: 7 }), FIT);
  assert.ok(second.placement < sixth.placement);
  assert.ok(second.terms.placement > sixth.terms.placement);
  assert.ok(second.score > sixth.score);
});

test("surviving longer breaks ties between losses", async () => {
  const lossAt = (tick: number): MatchRecord =>
    record({ winnerId: "p1", winnerKingdom: "fire", players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 0, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: tick },
      { id: "p1", name: "b", kingdomId: "fire", hp: 10, shield: 0, citizens: 0, currency: 0, eliminatedAtTick: null },
    ] });
  const early = scoreScenario(lossAt(500), "p0", context(), FIT);
  const late = scoreScenario(lossAt(4_900), "p0", context(), FIT);
  assert.ok(late.score > early.score);
  assert.ok(late.terms.survival > early.terms.survival);
});

test("the damage ratio rewards winning exchanges, not raw damage", async () => {
  // Ten times the damage, but taking more than it deals, scores worse than a
  // small clean exchange. Raw damage is farmable — the volcano is a legal
  // target that is not a kingdom.
  const bruiser = scoreScenario(record(), "p1", context({
    combat: { damageDealt: 50_000, damageReceived: 90_000, shieldAbsorbed: 0, kills: 0, healingReceived: 0 },
  }), FIT);
  const surgeon = scoreScenario(record(), "p1", context({
    combat: { damageDealt: 5_000, damageReceived: 1_000, shieldAbsorbed: 0, kills: 0, healingReceived: 0 },
  }), FIT);
  assert.ok(surgeon.terms.combat > bruiser.terms.combat);
});

test("a timeout is capped however healthy the castle", async () => {
  // The turtle guard. Placement ranks timeout survivors by remaining HP, so
  // without it a genome that shields and never attacks places first.
  const timeout = record({
    winnerId: null,
    timedOut: true,
    players: [
      { id: "p0", name: "a", kingdomId: "water", hp: 9_999, shield: 0, citizens: 40, currency: 0, eliminatedAtTick: null },
      { id: "p1", name: "b", kingdomId: "fire", hp: 100, shield: 0, citizens: 1, currency: 0, eliminatedAtTick: null },
    ],
  });
  const result = scoreScenario(timeout, "p0", context(), FIT);
  assert.equal(result.placement, 1, "the turtle did place first");
  assert.ok(result.score <= FIT.timeoutCap, `timeout scored ${result.score}`);
  assert.equal(result.terms.guardReason, "timeout");
});

test("a genome that never cast anything scores nothing", async () => {
  const result = scoreScenario(record(), "p0", context({
    behaviour: { casts: 0, invests: 0, citizens: 0, repairs: 0, shields: 0, retargets: 0, waits: 100, decisions: 100 },
  }), FIT);
  assert.equal(result.score, FIT.inactivityScore);
  assert.equal(result.terms.guardReason, "never cast");
});

test("every score stays within the formula's stated maximum", async () => {
  const perfect = scoreScenario(record(), "p0", context({
    combat: { damageDealt: 10_000, damageReceived: 0, shieldAbsorbed: 0, kills: 1, healingReceived: 0 },
  }), FIT);
  assert.ok(perfect.score <= maxScore(FIT) + 1e-9, `${perfect.score} exceeds ${maxScore(FIT)}`);
});

test("terms always reconstruct the score", async () => {
  const result = scoreScenario(record(), "p0", context(), FIT);
  const rebuilt =
    result.terms.win + result.terms.placement + result.terms.survival +
    result.terms.combat + result.terms.activity;
  assert.ok(Math.abs(rebuilt - result.score) < 1e-9, "a score must be explainable from its terms");
});

test("aggregation preserves the structured detail", async () => {
  const scenarios = [
    scoreScenario(record(), "p0", context(), FIT),
    scoreScenario(record(), "p1", context(), FIT),
  ];
  const totals = aggregate(scenarios);
  assert.equal(totals.matches, 2);
  assert.equal(totals.wins, 1);
  assert.equal(totals.losses, 1);
  assert.equal(totals.scenarios.length, 2, "the per-scenario results survive aggregation");
  assert.ok(totals.totalDamageDealt > 0);
  assert.ok(totals.totalDamageReceived > 0);
});

// ── the slate ───────────────────────────────────────────────────────────

test("a slate varies format, kingdom, opponent and seat — not just the seed", async () => {
  const config = trainingConfig({
    slate: { ...trainingConfig().slate, formats: ["duel", "ffa4"], seatRotations: 2 },
  });
  const slate = buildSlate(0, config.slate, config.kingdoms, 1);
  assert.equal(slate.scenarios.length, slateSize(config.slate, config.kingdoms.length));
  assert.ok(new Set(slate.scenarios.map((s) => s.format)).size > 1, "one format only");
  assert.ok(new Set(slate.scenarios.map((s) => s.candidateKingdom)).size > 1, "one kingdom only");
  assert.ok(new Set(slate.scenarios.map((s) => s.opponentProfiles[0])).size > 1, "one opponent only");
  assert.ok(new Set(slate.scenarios.map((s) => s.candidateSeat)).size > 1, "one seat only");
  assert.equal(new Set(slate.scenarios.map((s) => s.seed)).size, slate.scenarios.length);
});

test("formats produce the right seat counts", async () => {
  const config = trainingConfig({
    slate: { ...trainingConfig().slate, formats: ["duel", "ffa4", "ffa7"], kingdomsPerGenome: 1, opponents: ["balanced"], seatRotations: 1 },
  });
  const slate = buildSlate(0, config.slate, config.kingdoms, 1);
  const bySeats = new Map(slate.scenarios.map((s) => [s.format, s.seats]));
  assert.equal(bySeats.get("duel"), 2);
  assert.equal(bySeats.get("ffa4"), 4);
  assert.equal(bySeats.get("ffa7"), 7);
  for (const s of slate.scenarios) {
    assert.equal(s.opponentKingdoms.length, s.seats - 1);
    assert.ok(s.candidateSeat < s.seats);
  }
});

test("the slate is fixed within a generation and rotates between them", async () => {
  const config = trainingConfig();
  const first = buildSlate(0, config.slate, config.kingdoms, 1);
  const again = buildSlate(0, config.slate, config.kingdoms, 1);
  const later = buildSlate(1, config.slate, config.kingdoms, 1);
  assert.deepEqual(first, again, "every genome in a generation must face the same slate");
  assert.equal(first.hash, again.hash);
  assert.notEqual(first.hash, later.hash, "consecutive generations should differ");
});

test("the slate hash covers scenario content", async () => {
  const config = trainingConfig();
  const slate = buildSlate(0, config.slate, config.kingdoms, 1);
  const tampered = { ...slate, scenarios: [...slate.scenarios] };
  tampered.scenarios[0] = { ...tampered.scenarios[0]!, candidateSeat: 1 };
  assert.notEqual(hashSlate(tampered), slate.hash);
});

test("the slate SHAPE hash ignores generation but catches redesign", async () => {
  const config = trainingConfig();
  const shape = slateShapeHash(config.slate, config.kingdoms, config.seed);
  // Rotating to another generation must not change the shape…
  assert.equal(shape, slateShapeHash(config.slate, config.kingdoms, config.seed));
  // …but changing the design must.
  const redesigned = { ...config.slate, formats: ["ffa7" as const] };
  assert.notEqual(shape, slateShapeHash(redesigned, config.kingdoms, config.seed));
});

// ── real matches ────────────────────────────────────────────────────────

const smallSlate = () =>
  trainingConfig({
    slate: {
      ...trainingConfig().slate,
      formats: ["duel"],
      kingdomsPerGenome: 1,
      opponents: ["balanced"],
      seatRotations: 1,
      maxTicks: 3_000,
    },
  });

test("a genome plays real Elementals matches and receives a structured result", async () => {
  const config = smallSlate();
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const genome = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ populationSize: 2, activation: "tanh", initialConnectivity: 0.25 }),
    7,
  ).ask()[0]!;

  const result = evaluateGenome(genome, slate, config.fitness);
  assert.equal(result.matches, slate.scenarios.length);
  assert.ok(Number.isFinite(result.fitness));
  assert.equal(result.wins + result.losses + result.draws, result.matches);
  for (const s of result.scenarios) {
    assert.ok(s.placement >= 1 && s.placement <= s.seats);
    assert.ok(s.damageDealt >= 0 && s.damageReceived >= 0);
    assert.ok(s.decisions > 0, "the controller should have decided something");
  }
});

test("damage dealt and received are both observed", async () => {
  const config = smallSlate();
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  // A heuristic definitely fights, so both sides of the exchange must be nonzero.
  const result = evaluateCandidate(personalityCandidate("aggressive"), slate, config.fitness);
  assert.ok(result.totalDamageDealt > 0, "no damage dealt was recorded");
  assert.ok(result.totalDamageReceived > 0, "no damage received was recorded");
});

test("evaluating the same genome on the same slate is reproducible", async () => {
  const config = smallSlate();
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const genome = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ populationSize: 1, activation: "tanh", initialConnectivity: 0.25 }),
    3,
  ).ask()[0]!;
  const first = evaluateGenome(genome, slate, config.fitness);
  const second = evaluateGenome(genome, slate, config.fitness);
  assert.equal(first.fitness, second.fitness);
  assert.deepEqual(
    first.scenarios.map((s) => [s.placement, s.damageDealt, s.damageReceived]),
    second.scenarios.map((s) => [s.placement, s.damageDealt, s.damageReceived]),
  );
});

// ── baselines ───────────────────────────────────────────────────────────

test("baselines put every candidate through identical scenarios", async () => {
  const config = smallSlate();
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const runner = createRunner(1);
  const report = await runBaselines(runner, {
    slate,
    fitness: config.fitness,
    personalities: ["balanced"],
    seed: 99,
  });
  assert.equal(report.slateHash, slate.hash);
  assert.equal(report.entries.length, 2, "random + one personality");
  for (const entry of report.entries) {
    assert.equal(entry.result.matches, slate.scenarios.length);
  }
  assert.match(formatBaselines(report), /candidate/);
});

test("the fitness function ranks the tuned heuristics correctly", async () => {
  // The floor test, and NOT the one this started as. It began as "a heuristic
  // beats a random network", which is measurably false since the policy became
  // stochastic: across eight random seeds the mean fitness is 1.148 against
  // economic's 0.951, and four of the eight win every match. Acting often beats
  // `balanced`, which casts 116 times in eight matches and loses all of them.
  //
  // That is a fact about the heuristics rather than a bug — and it is the
  // clearest possible argument for self-play, since an opponent a random network
  // beats cannot be a training signal. What the fitness function must still do is
  // rank the tuned heuristics in their known order, and it does.
  const config = trainingConfig({
    slate: {
      ...trainingConfig().slate,
      formats: ["duel"],
      kingdomsPerGenome: 4,
      opponents: ["balanced"],
      seatRotations: 2,
      maxTicks: 8_000,
    },
  });
  const slate = buildSlate(0, config.slate, config.kingdoms, config.seed);
  const economic = evaluateCandidate(personalityCandidate("economic"), slate, config.fitness);
  const balanced = evaluateCandidate(personalityCandidate("balanced"), slate, config.fitness);
  const aggressive = evaluateCandidate(personalityCandidate("aggressive"), slate, config.fitness);

  // Economic is the strongest profile measured anywhere in this project (89.6%
  // of duels), and the score must say so.
  assert.ok(
    economic.fitness > balanced.fitness && economic.fitness > aggressive.fitness,
    `economic ${economic.fitness.toFixed(4)} vs balanced ${balanced.fitness.toFixed(4)} / ` +
      `aggressive ${aggressive.fitness.toFixed(4)}`,
  );
  assert.ok(economic.wins > balanced.wins, "and it should actually win more");
});

// ── training loop ───────────────────────────────────────────────────────

test("a short training run completes and reports its champion", async () => {
  const config = trainingConfig({
    mode: "heuristic",
    generations: 2,
    neat: withConfig({ populationSize: 4, activation: "tanh", initialConnectivity: 0.25 }),
    slate: { ...smallSlate().slate, maxTicks: 2_500 },
  });
  const result = await train({ config });
  assert.equal(result.generations, 2);
  assert.equal(result.history.length, 2);
  assert.ok(result.bestResult, "the champion's full result should be kept");
  assert.equal(result.bestResult!.fitness, result.bestFitness);
  for (const record of result.history) {
    assert.equal(record.matches, 4 * slateSize(config.slate, config.kingdoms.length));
    assert.ok(record.slateHash.length > 0);
  }
});

test("estimateMatches matches what a run actually plays", async () => {
  // estimateMatches describes the HEURISTIC slate; self-play shares matches
  // between genomes, so its budget is tableCount, not population x scenarios.
  const config = trainingConfig({
    mode: "heuristic",
    generations: 2,
    neat: withConfig({ populationSize: 3, activation: "tanh", initialConnectivity: 0.25 }),
    slate: { ...smallSlate().slate, maxTicks: 2_000 },
  });
  const result = await train({ config });
  assert.equal(
    result.history.reduce((sum, r) => sum + r.matches, 0),
    estimateMatches(config),
  );
});

// ── checkpoints ─────────────────────────────────────────────────────────

test("a checkpoint from a different seed is refused, and named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neat-"));
  try {
    const path = join(dir, "checkpoint.json");
    const config = trainingConfig({ seed: 111 });
    writeCheckpoint(path, {
      version: "v1",
      identity: localIdentity(config),
      writtenAt: new Date().toISOString(),
      completedGenerations: 1,
      population: new Population(ELEMENTALS_SHAPE, config.neat, config.seed).snapshot(),
      history: [],
    } satisfies TrainingCheckpoint);

    const load = readCheckpointFrom(path, trainingConfig({ seed: 222 }));
    assert.equal(load.checkpoint, null);
    assert.match(load.rejected ?? "", /seed: 111 -> 222/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a redesigned slate invalidates a checkpoint", async () => {
  // Fitness only means something next to the matches that produced it.
  const base = localIdentity(trainingConfig());
  const redesigned = localIdentity(
    trainingConfig({ slate: { ...trainingConfig().slate, formats: ["ffa7"] } }),
  );
  const mismatches = identityMismatches(base, redesigned);
  assert.ok(mismatches.some((m) => m.startsWith("slateShapeHash")), mismatches.join(", "));
});

test("a changed balance configuration invalidates a checkpoint", async () => {
  const base = localIdentity(trainingConfig());
  const other = localIdentity(trainingConfig({ balanceConfigId: "balance-v3-candidate" }));
  const mismatches = identityMismatches(base, other);
  assert.ok(mismatches.some((m) => m.startsWith("balanceConfigId")), mismatches.join(", "));
});

test("identity refuses on the observation schema but tolerates a dirty tree", async () => {
  const identity = localIdentity(trainingConfig());
  assert.ok(
    identityMismatches({ ...identity, observationVersion: "v0" }, identity)
      .some((m) => m.startsWith("observationVersion")),
  );
  assert.deepEqual(
    identityMismatches({ ...identity, engineDirty: !identity.engineDirty }, identity),
    [],
  );
});

test("a missing checkpoint is not an error", async () => {
  const load = readCheckpointFrom(join(tmpdir(), "definitely-not-here-neat.json"), trainingConfig());
  assert.equal(load.checkpoint, null);
  assert.equal(load.rejected, null);
});

// ── models and difficulty ───────────────────────────────────────────────

test("a trained genome becomes a model carrying full provenance", async () => {
  const config = trainingConfig();
  const model = toModel(createGenome("champion", ELEMENTALS_SHAPE), config, "hard", 12);
  assert.equal(model.kind, "elementals.ai.model");
  assert.equal(model.training.generation, 12);
  assert.ok(model.identity.balanceConfigHash.length > 0);
  assert.ok(model.identity.balanceBaselineHash.length > 0);
  assert.ok(model.identity.engineSha.length > 0);
  assert.doesNotThrow(() => assertModelCompatible(model));
});

test("all three difficulties come from one engine and one genome", async () => {
  const config = trainingConfig();
  const genome = createGenome("champion", ELEMENTALS_SHAPE);
  const models = (["easy", "medium", "hard"] as const).map((d) => toModel(genome, config, d, 5));
  for (const model of models) {
    assert.doesNotThrow(() => assertModelCompatible(model));
    assert.deepEqual(model.genome, genome, "the same genome backs every difficulty");
  }
});

test("the evolution RNG is serializable and resumes mid-stream", async () => {
  const rng = new NeatRng(12345);
  for (let i = 0; i < 50; i++) rng.next();
  assert.equal(NeatRng.fromState(rng.state).next(), NeatRng.fromState(rng.state).next());
});

// Local helper so the import list stays about the public surface.
import { readCheckpoint } from "../simulation/src/training/index.js";
function readCheckpointFrom(path: string, config: ReturnType<typeof trainingConfig>) {
  return readCheckpoint(path, localIdentity(config));
}

test("the activity reward saturates, so acting cannot be farmed", async () => {
  // It exists to give the flat basin between "did nothing" and "played" a slope.
  // Past the target it must be constant, or a genome learns to spam the cheapest
  // ability instead of learning to win — the failure this project already
  // measured in its heuristic controller.
  const idle = scoreScenario(record(), "p0", context({
    behaviour: { casts: 1, invests: 0, citizens: 0, repairs: 0, shields: 0, retargets: 0, waits: 100, decisions: 100, forcedWaits: 0 },
  }), FIT);
  const busy = scoreScenario(record(), "p0", context({
    behaviour: { casts: FIT.activityTarget, invests: 0, citizens: 0, repairs: 0, shields: 0, retargets: 0, waits: 100, decisions: 100, forcedWaits: 0 },
  }), FIT);
  const spamming = scoreScenario(record(), "p0", context({
    behaviour: { casts: FIT.activityTarget * 50, invests: 0, citizens: 0, repairs: 0, shields: 0, retargets: 0, waits: 100, decisions: 100, forcedWaits: 0 },
  }), FIT);

  assert.ok(busy.terms.activity > idle.terms.activity, "acting should pay something");
  assert.equal(spamming.terms.activity, busy.terms.activity, "and stop paying at the target");
  // And it stays small enough that it can never outrank winning.
  assert.ok(FIT.activityWeight < FIT.winWeight / 5, "activity must not compete with winning");
});
