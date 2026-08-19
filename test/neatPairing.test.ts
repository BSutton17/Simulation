import assert from "node:assert/strict";
import test from "node:test";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import { createGenome, withConfig, type Genome } from "../simulation/src/neat/index.js";
import {
  DEFAULT_SELF_PLAY,
  buildSelfPlayTables,
  deconflict,
  type SelfPlayTable,
} from "../simulation/src/training/selfPlay.js";
import {
  expressedConnections,
  geneticDiversity,
  genomeFingerprint,
} from "../simulation/src/training/populationStats.js";
import { ELEMENTALS_SHAPE } from "../simulation/src/training/matchEvaluator.js";
import { trainingConfig } from "../simulation/src/training/config.js";
import { train } from "../simulation/src/training/trainer.js";

/**
 * The one invariant true self-play rests on: a genome never faces itself.
 *
 * It is not a detail. A mirror match returns a score that says nothing about
 * skill — both seats play identically, so the result is decided by seat order
 * and dice — and it is silently reachable two different ways: an index that
 * wraps onto itself when the population does not divide by the seat count, and
 * a Hall-of-Fame clone meeting the elite it was cloned from. Both had to be
 * closed, and both are cheap to reopen by accident, which is what these are for.
 */

const ALL_FORMATS = { ...DEFAULT_SELF_PLAY, hallOfFameShare: 0 };

test("no table ever seats the same genome twice", async () => {
  // Sizes chosen to hit every awkward case: exact multiples, populations that
  // divide by no format, and populations equal to the largest seat count.
  for (const populationSize of [7, 8, 9, 11, 12, 16, 23, 24, 30]) {
    for (const hall of [0, 1, 3, 8]) {
      for (let generation = 0; generation < 4; generation++) {
        const tables = buildSelfPlayTables(
          generation,
          { ...DEFAULT_SELF_PLAY, hallOfFameShare: hall > 0 ? 0.5 : 0 },
          populationSize,
          KINGDOM_IDS,
          hall,
        );
        for (const table of tables) {
          assert.equal(
            new Set(table.seatGenomes).size,
            table.seatGenomes.length,
            `${table.id} pop=${populationSize} hall=${hall} seated [${table.seatGenomes}]`,
          );
          assert.equal(table.seatGenomes.length, table.seats);
        }
      }
    }
  }
});

test("a population too small to fill a format is refused, not quietly mirrored", async () => {
  assert.throws(
    () => buildSelfPlayTables(0, { ...ALL_FORMATS, formats: ["ffa7"] }, 5, KINGDOM_IDS, 0),
    /cannot fill a 7-seat ffa7 table/,
  );
  // Exactly enough is enough.
  assert.ok(
    buildSelfPlayTables(0, { ...ALL_FORMATS, formats: ["ffa7"] }, 7, KINGDOM_IDS, 0).length > 0,
  );
});

test("every table keeps at least one living genome to score", async () => {
  // A share of 1.0 would once have handed the whole table to past champions,
  // producing a match whose result belonged to nobody.
  const tables = buildSelfPlayTables(
    0,
    { ...DEFAULT_SELF_PLAY, hallOfFameShare: 1 },
    16,
    KINGDOM_IDS,
    8,
  );
  for (const table of tables) {
    assert.ok(
      table.seatGenomes.some((index) => index >= 0),
      `${table.id} had no living genome`,
    );
  }
});

test("the Hall of Fame never seats the same champion twice at one table", async () => {
  // One hall member and several hall slots is the case that used to repeat it.
  const tables = buildSelfPlayTables(
    0,
    { ...DEFAULT_SELF_PLAY, formats: ["ffa7"], hallOfFameShare: 0.9 },
    16,
    KINGDOM_IDS,
    1,
  );
  for (const table of tables) {
    const hallSeats = table.seatGenomes.filter((index) => index < 0);
    assert.equal(new Set(hallSeats).size, hallSeats.length);
    assert.ok(hallSeats.length <= 1, `${table.id} used ${hallSeats.length} hall seats`);
  }
});

test("banded pairing follows the ranking and still gives everyone equal matches", async () => {
  const populationSize = 24;
  const ranking = Array.from({ length: populationSize }, (_, i) => populationSize - 1 - i);
  const tables = buildSelfPlayTables(
    0,
    { ...ALL_FORMATS, formats: ["duel"], roundsPerFormat: 1, opponentSelection: "banded" },
    populationSize,
    KINGDOM_IDS,
    0,
    ranking,
  );

  const counts = new Array(populationSize).fill(0);
  for (const table of tables) for (const index of table.seatGenomes) counts[index] += 1;
  assert.deepEqual(new Set(counts), new Set([1]));

  // The strongest genome must meet someone near the top of the ranking rather
  // than a uniformly-drawn peer — that IS the difference from "shuffle".
  const top = ranking[0]!;
  const table = tables.find((t) => t.seatGenomes.includes(top))!;
  const opponent = table.seatGenomes.find((index) => index !== top)!;
  assert.ok(
    ranking.indexOf(opponent) < 4,
    `top genome met rank ${ranking.indexOf(opponent)}, which is not a banded pairing`,
  );
});

test("pairing modes are genuinely different arrangements", async () => {
  const size = 24;
  const ranking = Array.from({ length: size }, (_, i) => size - 1 - i);
  const of = (mode: "shuffle" | "banded" | "random"): string =>
    JSON.stringify(
      buildSelfPlayTables(
        0,
        { ...ALL_FORMATS, formats: ["duel"], roundsPerFormat: 1, opponentSelection: mode },
        size,
        KINGDOM_IDS,
        0,
        ranking,
      ).map((t) => t.seatGenomes),
    );
  assert.notEqual(of("shuffle"), of("banded"));
  assert.notEqual(of("shuffle"), of("random"));
  // ...and each is still deterministic.
  assert.equal(of("banded"), of("banded"));
  assert.equal(of("random"), of("random"));
});

test("a Hall-of-Fame clone never plays the elite it was cloned from", async () => {
  // Distinct INDICES are not distinct genomes: an elite carried unchanged
  // through reproduction keeps its id, and the hall holds a clone of it.
  const living: Genome[] = ["a", "b", "c", "d"].map((id) => createGenome(id, ELEMENTALS_SHAPE));
  const hall: Genome[] = [createGenome("b", ELEMENTALS_SHAPE), createGenome("z", ELEMENTALS_SHAPE)];
  const resolve = (index: number): Genome => (index >= 0 ? living[index]! : hall[-(index + 1)]!);

  const table: SelfPlayTable = {
    id: "t",
    format: "duel",
    seats: 2,
    seatGenomes: [1, -1], // living "b" against hall "b"
    kingdoms: ["water", "fire"],
    seed: 1,
    maxTicks: 100,
  };

  const fixed = deconflict(table, resolve, living.length, hall.length);
  const ids = fixed.seatGenomes.map((index) => resolve(index).id);
  assert.equal(new Set(ids).size, ids.length, `still a mirror: [${ids}]`);
  // A table that was already clean is returned untouched, so deconflicting
  // costs nothing in the overwhelmingly common case.
  const clean = { ...table, seatGenomes: [0, 1] };
  assert.equal(deconflict(clean, resolve, living.length, hall.length), clean);
});

test("fingerprints track what a network computes, not what it is called", async () => {
  const a = createGenome("a", ELEMENTALS_SHAPE);
  const b = createGenome("b-with-a-different-name", ELEMENTALS_SHAPE);
  assert.equal(genomeFingerprint(a), genomeFingerprint(b));

  a.connections.push({ innovation: 1, from: 0, to: 64, weight: 0.5, enabled: true });
  assert.notEqual(genomeFingerprint(a), genomeFingerprint(b));

  // A disabled gene changes nothing the network evaluates.
  const before = genomeFingerprint(a);
  a.connections.push({ innovation: 2, from: 1, to: 64, weight: 9, enabled: false });
  assert.equal(genomeFingerprint(a), before);
  assert.equal(expressedConnections(a), 1);
});

test("genetic diversity is zero for a cloned population and positive otherwise", async () => {
  const config = withConfig({ populationSize: 4, normalizeBySize: false });
  const identical = [0, 1, 2, 3].map((i) => {
    const genome = createGenome(`g${i}`, ELEMENTALS_SHAPE);
    genome.connections.push({ innovation: 1, from: 0, to: 64, weight: 0.25, enabled: true });
    return genome;
  });
  assert.equal(geneticDiversity(identical, config), 0);

  const varied = identical.map((genome, i) => ({
    ...genome,
    connections: genome.connections.map((gene) => ({ ...gene, weight: gene.weight + i })),
  }));
  assert.ok(geneticDiversity(varied, config) > 0);
});

test("the Hall of Fame is seeded by self-play, never by the held-out slate", async () => {
  // The decisive separation. With validation switched OFF entirely there is no
  // champion and no frozen-slate score, so a hall that still fills can only have
  // been filled from the population itself. Before this, the hall took the
  // VALIDATED champion — which put heuristic personalities back in the training
  // loop by the back door and let the held-out slate influence reproduction.
  const config = trainingConfig({
    mode: "selfPlay",
    generations: 3,
    validateEvery: 0,
    benchmarkEvery: 0,
    kingdoms: ["water", "fire", "earth"],
    neat: withConfig({ populationSize: 6, normalizeBySize: false }),
    selfPlay: {
      ...DEFAULT_SELF_PLAY,
      formats: ["duel"],
      roundsPerFormat: 1,
      hallOfFameShare: 0.5,
      maxTicks: 1_200,
    },
    slate: { ...trainingConfig().slate, maxTicks: 1_200 },
  });

  const result = await train({ config });
  const last = result.history[result.history.length - 1]!;
  assert.equal(last.validationFitness, null, "validation must not have run");
  assert.ok(last.hallOfFame > 0, "the hall filled without any validated champion");
});

test("a short self-play run actually changes the population", async () => {
  // Requirement 4 made a test: offspring must not be copies. Checked on the
  // genomes themselves rather than on fitness, because under self-play a moving
  // fitness number is also consistent with a static population meeting a
  // different draw.
  const config = trainingConfig({
    mode: "selfPlay",
    generations: 3,
    validateEvery: 0,
    benchmarkEvery: 0,
    kingdoms: ["water", "fire", "earth"],
    neat: withConfig({ populationSize: 8, normalizeBySize: false }),
    selfPlay: {
      ...DEFAULT_SELF_PLAY,
      formats: ["duel"],
      roundsPerFormat: 1,
      hallOfFameShare: 0,
      maxTicks: 1_200,
    },
    slate: { ...trainingConfig().slate, maxTicks: 1_200 },
  });

  const result = await train({ config });
  const fingerprints = result.history.map((r) => r.bestFingerprint);
  assert.equal(fingerprints.length, 3);
  assert.ok(
    new Set(fingerprints).size > 1,
    `the best genome computed the same function throughout: ${fingerprints.join(", ")}`,
  );
  assert.ok(result.history.every((r) => r.diversity > 0), "the population collapsed to one policy");
});
