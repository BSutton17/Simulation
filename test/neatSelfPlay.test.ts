import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SELF_PLAY,
  ELEMENTALS_SHAPE,
  HallOfFame,
  buildSelfPlayTables,
  evaluatePopulation,
  playTable,
  tableCount,
  train,
  trainingConfig,
} from "../simulation/src/training/index.js";
import { Population, cloneGenome, withConfig } from "../simulation/src/neat/index.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * Self-play: the population as its own opposition.
 *
 * Adopted because the heuristics stopped discriminating — measured best fitness
 * sat within 0.4% of the fitness ceiling from generation zero, leaving selection
 * nothing to work with. A population playing itself cannot saturate, because the
 * opposition improves with it.
 *
 * The properties worth holding are about FAIRNESS and about not fooling
 * ourselves: every genome must get the same number of matches, past champions
 * must stay in the pool so a cycling population cannot pass as a progressing
 * one, and the absolute yardstick must survive.
 */

const CONFIG = trainingConfig();

function countsFor(format: string, populationSize: number, generation = 0): number[] {
  const tables = buildSelfPlayTables(generation, DEFAULT_SELF_PLAY, populationSize, KINGDOM_IDS, 0);
  const counts = new Array<number>(populationSize).fill(0);
  for (const table of tables) {
    if (table.format !== format) continue;
    for (const index of table.seatGenomes) if (index >= 0) counts[index] += 1;
  }
  return counts;
}

test("match counts are exactly equal when the seats divide the population", () => {
  // 28 genomes divide into both duels and fours, so there is no excuse for a
  // difference: a genome judged on more matches than another is being selected
  // partly for its draw.
  for (const [format, seats] of [["duel", 2], ["ffa4", 4]] as const) {
    const counts = countsFor(format, 28);
    assert.equal(new Set(counts).size, 1, `${format}: uneven ${JSON.stringify(counts)}`);
    assert.equal(counts[0], DEFAULT_SELF_PLAY.roundsPerFormat);
    void seats;
  }
});

test("when the seats do not divide the population the surplus is bounded and rotates", () => {
  // Thirty genomes do not divide into sevens: five tables hold thirty-five
  // seats, so five genomes must play twice. Unavoidable — what matters is that
  // it is at most one extra per round and does not always land on the same
  // genomes.
  const counts = countsFor("ffa7", 30);
  const spread = Math.max(...counts) - Math.min(...counts);
  assert.ok(
    spread <= DEFAULT_SELF_PLAY.roundsPerFormat,
    `surplus of ${spread} exceeds one per round: ${JSON.stringify(counts)}`,
  );
  assert.ok(Math.min(...counts) >= 1, "every genome must play at least once");

  // …and the surplus moves between generations rather than favouring the same
  // genomes for the life of the run.
  const later = countsFor("ffa7", 30, 3);
  const extrasNow = counts.map((c, i) => (c > Math.min(...counts) ? i : -1)).filter((i) => i >= 0);
  const extrasLater = later.map((c, i) => (c > Math.min(...later) ? i : -1)).filter((i) => i >= 0);
  assert.notDeepEqual(extrasNow, extrasLater, "the same genomes got the surplus every generation");
});

test("a population that is not a multiple of the seat count still covers everyone", () => {
  // 30 genomes do not divide into sevens. Dropping the tail would leave the last
  // few unevaluated in that format, and unevaluated reads as fitness zero.
  const tables = buildSelfPlayTables(
    0,
    { ...DEFAULT_SELF_PLAY, formats: ["ffa7"], roundsPerFormat: 1, hallOfFameShare: 0 },
    30,
    KINGDOM_IDS,
    0,
  );
  const seen = new Set(tables.flatMap((t) => t.seatGenomes));
  for (let i = 0; i < 30; i++) assert.ok(seen.has(i), `genome ${i} never played`);
});

test("seat counts and kingdoms match the format", () => {
  const tables = buildSelfPlayTables(0, DEFAULT_SELF_PLAY, 28, KINGDOM_IDS, 0);
  for (const table of tables) {
    assert.equal(table.seatGenomes.length, table.seats);
    assert.equal(table.kingdoms.length, table.seats);
    assert.equal(table.seats, { duel: 2, ffa4: 4, ffa7: 7 }[table.format]);
  }
});

test("tables are deterministic and rotate between generations", () => {
  const a = buildSelfPlayTables(0, DEFAULT_SELF_PLAY, 24, KINGDOM_IDS, 0);
  const again = buildSelfPlayTables(0, DEFAULT_SELF_PLAY, 24, KINGDOM_IDS, 0);
  const later = buildSelfPlayTables(1, DEFAULT_SELF_PLAY, 24, KINGDOM_IDS, 0);
  assert.deepEqual(a, again);
  assert.notDeepEqual(
    a.map((t) => t.seatGenomes),
    later.map((t) => t.seatGenomes),
    "pairings should not repeat generation to generation",
  );
});

test("the Hall of Fame takes seats only when it has members", () => {
  const without = buildSelfPlayTables(0, DEFAULT_SELF_PLAY, 24, KINGDOM_IDS, 0);
  assert.ok(without.every((t) => t.seatGenomes.every((i) => i >= 0)), "no members, no seats");

  const with3 = buildSelfPlayTables(0, DEFAULT_SELF_PLAY, 24, KINGDOM_IDS, 3);
  const hofSeats = with3.flatMap((t) => t.seatGenomes).filter((i) => i < 0);
  assert.ok(hofSeats.length > 0, "past champions should be seated");
  // Indices map to -(n+1), so every one must resolve inside the pool.
  for (const index of hofSeats) assert.ok(-(index + 1) < 3, `bad hall index ${index}`);
});

test("one match scores every seat", () => {
  // The efficiency argument, asserted: a seven-seat match must return seven
  // results, not one.
  const population = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ ...CONFIG.neat, populationSize: 8 }),
    5,
  );
  const genomes = population.ask();
  const tables = buildSelfPlayTables(
    0,
    { formats: ["ffa7"], roundsPerFormat: 1, hallOfFameShare: 0, maxTicks: 2_000 },
    8,
    KINGDOM_IDS,
    0,
  );
  const results = playTable(tables[0]!, (i) => genomes[i]!, CONFIG.fitness);
  assert.equal(results.length, 7);
  assert.deepEqual(
    results.map((r) => r.seat).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6],
  );
  // Exactly one seat can place first.
  assert.equal(results.filter((r) => r.result.placement === 1).length, 1);
});

test("self-play evaluates a whole population and cannot saturate", () => {
  const population = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ ...CONFIG.neat, populationSize: 8 }),
    11,
  );
  const genomes = population.ask();
  const tables = buildSelfPlayTables(
    0,
    { formats: ["duel", "ffa4"], roundsPerFormat: 1, hallOfFameShare: 0, maxTicks: 2_000 },
    8,
    KINGDOM_IDS,
    0,
  );
  const results = evaluatePopulation(genomes, [], tables, CONFIG.fitness);
  assert.equal(results.length, genomes.length);
  for (const r of results) {
    assert.ok(r.matches > 0, "every genome must be evaluated");
    assert.ok(Number.isFinite(r.fitness));
  }
  // Someone has to lose: in a shared match the population cannot all win, which
  // is precisely why the ceiling stops being reachable.
  assert.ok(results.some((r) => r.losses > 0), "self-play must produce losers");
});

test("Hall of Fame members are opposition, not candidates", () => {
  // A past champion occupies a seat but its result belongs to no living genome —
  // otherwise it would be selected and bred as though it were in the population.
  const population = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ ...CONFIG.neat, populationSize: 8 }),
    3,
  );
  const genomes = population.ask();
  const hall = [cloneGenome(genomes[0]!, "hof-0")];
  const tables = buildSelfPlayTables(
    0,
    { formats: ["duel"], roundsPerFormat: 1, hallOfFameShare: 0.5, maxTicks: 1_500 },
    8,
    KINGDOM_IDS,
    1,
  );
  const results = evaluatePopulation(genomes, hall, tables, CONFIG.fitness);
  assert.equal(results.length, 8, "results are per living genome only");
});

// ── the Hall of Fame itself ─────────────────────────────────────────────

test("the Hall of Fame stays bounded and spans the run", () => {
  // "The last N champions" would let a population outrun its own past by
  // improving steadily; an even spread keeps early history in the pool.
  const hall = new HallOfFame(5);
  const population = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ ...CONFIG.neat, populationSize: 2 }),
    1,
  );
  const genome = population.ask()[0]!;
  for (let generation = 0; generation < 40; generation++) {
    hall.admit(cloneGenome(genome, `g${generation}`), generation);
  }
  assert.equal(hall.size, 5, "capacity must hold");
  const entries = hall.toJSON();
  assert.equal(entries[0]!.generation, 0, "the earliest champion should survive");
  assert.equal(entries[entries.length - 1]!.generation, 39, "so should the latest");
});

test("the Hall of Fame round-trips through JSON", () => {
  const hall = new HallOfFame(4);
  const population = new Population(
    ELEMENTALS_SHAPE,
    withConfig({ ...CONFIG.neat, populationSize: 2 }),
    2,
  );
  const genome = population.ask()[0]!;
  for (let g = 0; g < 6; g++) hall.admit(cloneGenome(genome, `g${g}`), g);
  const restored = HallOfFame.fromJSON(JSON.parse(JSON.stringify(hall.toJSON())), 4);
  assert.equal(restored.size, hall.size);
  assert.deepEqual(
    restored.toJSON().map((e) => e.generation),
    hall.toJSON().map((e) => e.generation),
  );
});

test("budgeting counts matches, and self-play is far cheaper", () => {
  const perGeneration = tableCount(DEFAULT_SELF_PLAY, 60);
  // Heuristic mode plays one match per genome per scenario: 60 x 12 = 720.
  assert.ok(perGeneration < 200, `expected far fewer than 720, got ${perGeneration}`);
  // And every genome still gets two matches in each of three formats.
  assert.equal(perGeneration, 2 * (30 + 15 + 9));
});

// ── the loop ────────────────────────────────────────────────────────────

test("a self-play run completes and keeps the absolute yardstick", () => {
  const config = trainingConfig({
    mode: "selfPlay",
    generations: 2,
    validateEvery: 1,
    neat: withConfig({ ...CONFIG.neat, populationSize: 8 }),
    selfPlay: { formats: ["duel"], roundsPerFormat: 1, hallOfFameShare: 0.15, maxTicks: 1_500 },
    slate: { ...CONFIG.slate, maxTicks: 1_500 },
  });
  const result = train({ config });
  assert.equal(result.generations, 2);
  for (const record of result.history) {
    assert.ok(record.matchesPlayed > 0);
    // Validation is measured against fixed heuristics, never against peers:
    // under self-play it is the only score comparable across generations.
    assert.ok(record.validationFitness !== null, "validation must still run");
  }
  assert.ok(result.history[1]!.hallOfFame > 0, "champions should accumulate");
});
