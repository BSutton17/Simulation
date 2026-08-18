import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NeatRng,
  Population,
  allocateOffspring,
  createGenome,
  cullStagnant,
  shareFitness,
  speciate,
  toState,
  updateStagnation,
  withConfig,
  type ConnectionGene,
  type Genome,
  type GenomeShape,
  type Species,
} from "../simulation/src/neat/index.js";

/**
 * Speciation, fitness sharing, offspring allocation and the population loop.
 *
 * The population-size invariant gets its own attention: allocation is
 * proportional and therefore fractional, and "roughly the right number of
 * genomes" is the kind of drift that goes unnoticed for a hundred generations
 * and quietly changes what every earlier result meant.
 */

const SHAPE: GenomeShape = { inputs: 2, outputs: 1, activation: "sigmoid" };

function gene(innovation: number, weight = 1): ConnectionGene {
  return { innovation, from: 0, to: 3, weight, enabled: true };
}

function genome(id: string, connections: ConnectionGene[], fitness = 0): Genome {
  const g = createGenome(id, SHAPE);
  g.connections = connections;
  g.fitness = fitness;
  return g;
}

let speciesCounter = 0;
const nextSpeciesId = (): number => speciesCounter++;

test("similar genomes join one species and dissimilar ones split", () => {
  speciesCounter = 0;
  const config = withConfig({ compatibilityThreshold: 1, weightCoefficient: 1, smallGenomeSize: 20 });
  const near = [genome("a", [gene(0, 1)]), genome("b", [gene(0, 1.1)])];
  const far = genome("c", [gene(0, 50)]);
  const species = speciate([...near, far], [], config, nextSpeciesId);

  assert.equal(species.length, 2);
  const sizes = species.map((s) => s.members.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test("speciation is deterministic under a fixed seed", () => {
  const config = withConfig({ compatibilityThreshold: 1, weightCoefficient: 1 });
  const build = (): Genome[] =>
    [1, 1.2, 5, 5.1, 20].map((w, i) => genome(`g${i}`, [gene(0, w)]));
  speciesCounter = 0;
  const first = speciate(build(), [], config, nextSpeciesId).map((s) => s.members.map((m) => m.id));
  speciesCounter = 0;
  const second = speciate(build(), [], config, nextSpeciesId).map((s) => s.members.map((m) => m.id));
  assert.deepEqual(first, second);
});

test("fitness sharing divides by species size", () => {
  speciesCounter = 0;
  const config = withConfig({ compatibilityThreshold: 100 }); // one big species
  const members = [genome("a", [gene(0)], 10), genome("b", [gene(0)], 20)];
  const species = speciate(members, [], config, nextSpeciesId);
  shareFitness(species);
  assert.equal(members[0]!.adjustedFitness, 5);
  assert.equal(members[1]!.adjustedFitness, 10);
});

test("a large species does not gain from its size alone", () => {
  // Twenty copies of one idea should be worth about what one is — that is the
  // pressure keeping several lines of play alive at once.
  speciesCounter = 0;
  const config = withConfig({ compatibilityThreshold: 1, weightCoefficient: 1, populationSize: 30 });
  const big = Array.from({ length: 20 }, (_, i) => genome(`big${i}`, [gene(0, 1)], 10));
  const small = Array.from({ length: 2 }, (_, i) => genome(`small${i}`, [gene(0, 50)], 10));
  const species = speciate([...big, ...small], [], config, nextSpeciesId);
  shareFitness(species);
  allocateOffspring(species, config);

  const bySize = [...species].sort((a, b) => b.members.length - a.members.length);
  assert.equal(bySize[0]!.offspring, bySize[1]!.offspring, "equal mean fitness should allocate equally");
});

test("offspring allocation always sums to exactly the population size", () => {
  const config = withConfig({ populationSize: 97, compatibilityThreshold: 1, weightCoefficient: 1 });
  for (let trial = 0; trial < 20; trial++) {
    speciesCounter = 0;
    const rng = new NeatRng(trial);
    const members = Array.from({ length: 97 }, (_, i) =>
      genome(`g${i}`, [gene(0, rng.next() * 30)], rng.next() * 10),
    );
    const species = speciate(members, [], config, nextSpeciesId);
    shareFitness(species);
    allocateOffspring(species, config);
    const total = species.reduce((sum, s) => sum + s.offspring, 0);
    assert.equal(total, 97, `trial ${trial} allocated ${total}`);
  }
});

test("an all-zero-fitness population is still allocated evenly", () => {
  speciesCounter = 0;
  const config = withConfig({ populationSize: 10, compatibilityThreshold: 1, weightCoefficient: 1 });
  const members = [0, 0, 40, 40].map((w, i) => genome(`g${i}`, [gene(0, w)], 0));
  const species = speciate(members, [], config, nextSpeciesId);
  shareFitness(species);
  allocateOffspring(species, config);
  assert.equal(species.reduce((sum, s) => sum + s.offspring, 0), 10);
  assert.ok(species.every((s) => s.offspring > 0), "no species should be starved at zero fitness");
});

test("stagnation is tracked and stagnant species are culled", () => {
  speciesCounter = 0;
  const config = withConfig({ stagnationLimit: 2, minSpecies: 1, compatibilityThreshold: 1, weightCoefficient: 1 });
  const members = [genome("a", [gene(0, 1)], 5), genome("b", [gene(0, 60)], 9)];
  let state = toState(speciate(members, [], config, nextSpeciesId));

  let species: Species[] = [];
  for (let generation = 0; generation < 4; generation++) {
    // Fitness never improves, so both species accumulate stagnation.
    const fresh = [genome("a", [gene(0, 1)], 5), genome("b", [gene(0, 60)], 9)];
    species = speciate(fresh, state, config, nextSpeciesId);
    updateStagnation(species);
    state = toState(species);
  }
  assert.ok(species.some((s) => s.stagnation >= 2), "stagnation should accumulate");
  const survivors = cullStagnant(species, config);
  assert.ok(survivors.length >= config.minSpecies, "never cull below the floor");
});

// ── the population loop ─────────────────────────────────────────────────

test("every generation produces exactly the configured population size", () => {
  const config = withConfig({ populationSize: 40 });
  const population = new Population(SHAPE, config, 5);
  const rng = new NeatRng(1);
  for (let generation = 0; generation < 8; generation++) {
    const genomes = population.ask();
    assert.equal(genomes.length, 40, `generation ${generation} had ${genomes.length} genomes`);
    population.tell(genomes.map(() => rng.next()));
  }
});

test("evolution is reproducible for a seed and a fitness sequence", () => {
  const config = withConfig({ populationSize: 20 });
  const run = (): string[] => {
    const population = new Population(SHAPE, config, 99);
    const rng = new NeatRng(7);
    const reports: string[] = [];
    for (let i = 0; i < 5; i++) {
      const genomes = population.ask();
      const report = population.tell(genomes.map(() => rng.next()));
      reports.push(`${report.best.toFixed(6)}|${report.species}|${report.meanConnections.toFixed(3)}`);
    }
    return reports;
  };
  assert.deepEqual(run(), run());
});

test("a different seed produces a different run", () => {
  // Guards against the reproducibility test above passing because nothing ever
  // varies. Fingerprints every weight in the population rather than a structural
  // count: at three genes per genome the topology is often identical across
  // seeds while the weights — the thing actually being evolved — are not.
  const config = withConfig({ populationSize: 20 });
  const run = (seed: number): string => {
    const population = new Population(SHAPE, config, seed);
    const rng = new NeatRng(7);
    for (let i = 0; i < 3; i++) population.tell(population.ask().map(() => rng.next()));
    return population
      .ask()
      .map((g) => g.connections.map((c) => c.weight.toFixed(6)).join(","))
      .join("|");
  };
  const results = new Set([run(1), run(2), run(3), run(4), run(5)]);
  assert.equal(results.size, 5, "every seed should produce a distinct population");
});

test("a non-finite fitness is neutralized rather than poisoning selection", () => {
  const population = new Population(SHAPE, withConfig({ populationSize: 10 }), 1);
  const genomes = population.ask();
  const report = population.tell(genomes.map((_, i) => (i === 0 ? NaN : 1)));
  assert.ok(Number.isFinite(report.best));
  assert.ok(Number.isFinite(report.mean));
});

test("telling the wrong number of fitnesses is refused", () => {
  const population = new Population(SHAPE, withConfig({ populationSize: 10 }), 1);
  assert.throws(() => population.tell([1, 2, 3]), /expected 10 fitnesses/);
});
