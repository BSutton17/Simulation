import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORMAT_SEATS,
  buildSlate,
  buildValidationSlate,
  hashSlate,
  slateSeatCost,
  slateShapeHash,
  slateSize,
  trainingConfig,
} from "../simulation/src/training/index.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * The training slate, and the frozen validation slate beside it.
 *
 * The split is the point. A training curve on its own cannot distinguish
 *
 *     the policy got better at Elementals
 *     the policy memorised the matches it kept being shown
 *
 * and those have very different consequences for a bot people will actually
 * play against. The validation slate is never trained on, is drawn from a
 * provably disjoint seed pool, and stays identical for the life of a run.
 */

const CONFIG = trainingConfig();

test("the training slate spans formats, kingdoms, opponents and seats", () => {
  const slate = buildSlate(0, CONFIG.slate, CONFIG.kingdoms, CONFIG.seed);
  assert.equal(slate.scenarios.length, slateSize(CONFIG.slate, CONFIG.kingdoms.length));
  assert.ok(new Set(slate.scenarios.map((s) => s.format)).size > 1, "one format only");
  assert.ok(new Set(slate.scenarios.map((s) => s.candidateKingdom)).size > 1, "one kingdom only");
  assert.ok(new Set(slate.scenarios.map((s) => s.opponentProfiles[0])).size > 1, "one opponent only");
  assert.ok(new Set(slate.scenarios.map((s) => s.candidateSeat)).size > 1, "one seat only");
});

test("seat counts follow the format", () => {
  const config = { ...CONFIG.slate, formats: ["duel", "ffa4", "ffa7"] as const };
  const slate = buildSlate(0, { ...config, formats: [...config.formats] }, CONFIG.kingdoms, 1);
  for (const s of slate.scenarios) {
    assert.equal(s.seats, FORMAT_SEATS[s.format]);
    assert.equal(s.opponentKingdoms.length, s.seats - 1);
    assert.equal(s.opponentProfiles.length, s.seats - 1);
    assert.ok(s.candidateSeat < s.seats);
  }
});

test("extra seeds add repeats without changing the matchup", () => {
  const one = buildSlate(0, { ...CONFIG.slate, seedsPerScenario: 1 }, CONFIG.kingdoms, 1);
  const three = buildSlate(0, { ...CONFIG.slate, seedsPerScenario: 3 }, CONFIG.kingdoms, 1);
  assert.equal(three.scenarios.length, one.scenarios.length * 3);
  // Same matchups, different dice.
  assert.equal(
    new Set(three.scenarios.map((s) => `${s.format}:${s.candidateKingdom}:${s.candidateSeat}`)).size,
    new Set(one.scenarios.map((s) => `${s.format}:${s.candidateKingdom}:${s.candidateSeat}`)).size,
  );
  assert.equal(new Set(three.scenarios.map((s) => s.seed)).size, three.scenarios.length);
});

test("a generation's slate is fixed, and rotates between generations", () => {
  const a = buildSlate(0, CONFIG.slate, CONFIG.kingdoms, 1);
  const again = buildSlate(0, CONFIG.slate, CONFIG.kingdoms, 1);
  const later = buildSlate(1, CONFIG.slate, CONFIG.kingdoms, 1);
  assert.deepEqual(a, again, "every genome in a generation must face the same slate");
  assert.notEqual(a.hash, later.hash, "consecutive generations should differ");
});

test("every kingdom is played equally often across a run", () => {
  // Rotation rather than sampling, so coverage is exact rather than expected.
  const counts = new Map<string, number>();
  const perGeneration = CONFIG.slate.kingdomsPerGenome;
  const generations = KINGDOM_IDS.length / perGeneration;
  for (let g = 0; g < generations; g++) {
    for (const s of buildSlate(g, CONFIG.slate, CONFIG.kingdoms, 1).scenarios) {
      counts.set(s.candidateKingdom, (counts.get(s.candidateKingdom) ?? 0) + 1);
    }
  }
  assert.equal(counts.size, KINGDOM_IDS.length, "every kingdom should appear");
  const values = [...counts.values()];
  assert.equal(new Set(values).size, 1, `uneven coverage: ${JSON.stringify([...counts])}`);
});

// ── the frozen validation slate ─────────────────────────────────────────

test("validation covers every kingdom and all three formats", () => {
  // Broader than training on purpose: a validation set that samples the same
  // narrow corner as training cannot detect overfitting to that corner.
  const validation = buildValidationSlate(KINGDOM_IDS);
  assert.equal(new Set(validation.scenarios.map((s) => s.candidateKingdom)).size, KINGDOM_IDS.length);
  assert.deepEqual(
    [...new Set(validation.scenarios.map((s) => s.format))].sort(),
    ["duel", "ffa4", "ffa7"],
  );
});

test("validation is frozen — identical every time it is built", () => {
  const a = buildValidationSlate(KINGDOM_IDS);
  const b = buildValidationSlate(KINGDOM_IDS);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.scenarios, b.scenarios);
  assert.equal(a.generation, -1, "validation is not tied to a generation");
});

test("validation seeds never collide with training seeds", () => {
  // The property that makes validation a measurement rather than more training.
  // Guaranteed by the repository's pool machinery, asserted here for this use.
  const trainingSeeds = new Set<number>();
  for (let g = 0; g < 12; g++) {
    for (const s of buildSlate(g, CONFIG.slate, CONFIG.kingdoms, CONFIG.seed).scenarios) {
      trainingSeeds.add(s.seed);
    }
  }
  const validation = buildValidationSlate(KINGDOM_IDS);
  const overlap = validation.scenarios.filter((s) => trainingSeeds.has(s.seed));
  assert.deepEqual(overlap.map((s) => s.id), [], "a validation match was also trained on");
});

test("validation faces an opponent the default training slate never uses", () => {
  const validation = buildValidationSlate(KINGDOM_IDS);
  const validationOpponents = new Set(validation.scenarios.flatMap((s) => s.opponentProfiles));
  const trainingOpponents = new Set(CONFIG.slate.opponents);
  const unseen = [...validationOpponents].filter((o) => !trainingOpponents.has(o));
  assert.ok(unseen.length > 0, "validation should include an opponent training never sees");
});

test("validation is labelled as a distinct pool", () => {
  assert.equal(buildValidationSlate(KINGDOM_IDS).pool, "validation");
  assert.equal(buildSlate(0, CONFIG.slate, CONFIG.kingdoms, 1).pool, "training");
});

// ── identity ────────────────────────────────────────────────────────────

test("the slate hash covers scenario content", () => {
  const slate = buildSlate(0, CONFIG.slate, CONFIG.kingdoms, 1);
  const tampered = { ...slate, scenarios: [...slate.scenarios] };
  tampered.scenarios[0] = { ...tampered.scenarios[0]!, candidateSeat: 1 };
  assert.notEqual(hashSlate(tampered), slate.hash);
});

test("the shape hash ignores generation but catches redesign", () => {
  const shape = slateShapeHash(CONFIG.slate, CONFIG.kingdoms, CONFIG.seed);
  assert.equal(shape, slateShapeHash(CONFIG.slate, CONFIG.kingdoms, CONFIG.seed));
  for (const change of [
    { formats: ["ffa7" as const] },
    { seedsPerScenario: 4 },
    { opponents: ["random"] },
    { maxTicks: 999 },
  ]) {
    assert.notEqual(
      shape,
      slateShapeHash({ ...CONFIG.slate, ...change }, CONFIG.kingdoms, CONFIG.seed),
      `redesign went undetected: ${JSON.stringify(change)}`,
    );
  }
});

test("seat cost reflects format, not just match count", () => {
  // A 7-FFA is one match and seven seats; budgeting on match count alone
  // under-estimates a free-for-all slate by a factor of three.
  const duels = buildSlate(0, { ...CONFIG.slate, formats: ["duel"] }, CONFIG.kingdoms, 1);
  const sevens = buildSlate(0, { ...CONFIG.slate, formats: ["ffa7"] }, CONFIG.kingdoms, 1);
  assert.equal(duels.scenarios.length, sevens.scenarios.length);
  assert.ok(slateSeatCost(sevens) > slateSeatCost(duels) * 3);
});
