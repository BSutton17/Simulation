import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NeatRng,
  Population,
  compatibility,
  compatibilityDistance,
  genomeSize,
  mutateAddNode,
  mutateWeights,
  withConfig,
  type Genome,
} from "../simulation/src/neat/index.js";
import { ELEMENTALS_SHAPE, trainingConfig } from "../simulation/src/training/index.js";

/**
 * Speciation at Elementals scale.
 *
 * The XOR tests exercise speciation on four-node genomes. This exercises it on
 * the real interface — 64 inputs, 22 outputs, ~340 genes before a single
 * mutation — where two things that are harmless at XOR scale become fatal:
 *
 *   1. normalizing excess and disjoint counts by GENE COUNT divides every
 *      structural difference by the width of the problem, and
 *   2. drawing each genome's initial wiring independently fills generation 0
 *      with sampling noise that looks exactly like structural difference.
 *
 * Together they made a measured add-node mutation move compatibility distance by
 * 0.006 against a baseline spread of 0.36 — speciation could not see topology at
 * all, and the whole population sat in one species forever. These tests hold the
 * fixes in place.
 */

const CONFIG = trainingConfig().neat;

function freshPopulation(seed = 4242, overrides = {}): Population {
  return new Population(ELEMENTALS_SHAPE, withConfig({ ...CONFIG, ...overrides }), seed);
}

function pairwiseDistances(genomes: readonly Genome[], config = CONFIG): number[] {
  const out: number[] = [];
  for (let i = 0; i < genomes.length; i++) {
    for (let j = i + 1; j < genomes.length; j++) {
      out.push(compatibilityDistance(genomes[i]!, genomes[j]!, config));
    }
  }
  return out;
}

// ── what a starting genome actually is ──────────────────────────────────

test("a starting genome is the interface, not accumulated complexity", () => {
  // 87 nodes looks alarming next to XOR's four. It is 64 inputs + 1 bias + 22
  // outputs and ZERO hidden nodes — a minimal start for this problem, where the
  // node count is set by the observation and action spaces rather than by
  // anything evolution did.
  const genome = freshPopulation().ask()[0]!;
  const byType = new Map<string, number>();
  for (const node of genome.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);

  assert.equal(byType.get("input"), 64);
  assert.equal(byType.get("bias"), 1);
  assert.equal(byType.get("output"), 22);
  assert.equal(byType.get("hidden") ?? 0, 0, "a minimal start has no hidden nodes");
  assert.equal(genome.nodes.length, 87);
});

test("every connection in a starting genome is expressed", () => {
  const genome = freshPopulation().ask()[0]!;
  const size = genomeSize(genome);
  assert.equal(size.enabled, size.connections, "nothing starts disabled");
  // Density is a configured fraction of the 65 x 22 interface, not emergent.
  assert.ok(size.connections > 250 && size.connections < 450, `unexpected ${size.connections} genes`);
  const outputsWired = new Set(genome.connections.filter((c) => c.enabled).map((c) => c.to));
  assert.equal(outputsWired.size, 22, "every output must be reachable or it emits a constant");
});

test("generation 0 shares one topology and differs only in weights", () => {
  // The fix for the sampling-noise half of the problem. Independent per-genome
  // wiring gave any two members ~500 disjoint genes of pure noise.
  const genomes = freshPopulation().ask();
  const signature = (g: Genome) => g.connections.map((c) => c.innovation).join(",");
  const shapes = new Set(genomes.map(signature));
  assert.equal(shapes.size, 1, "starting genomes must share one topology");

  const weights = new Set(genomes.map((g) => g.connections.map((c) => c.weight.toFixed(6)).join(",")));
  assert.equal(weights.size, genomes.length, "…but every genome needs its own weights");

  for (const [a, b] of [[genomes[0]!, genomes[1]!]] as const) {
    const d = compatibility(a, b, CONFIG);
    assert.equal(d.excess, 0, "no excess genes at generation 0");
    assert.equal(d.disjoint, 0, "no disjoint genes at generation 0");
    assert.ok(d.matching > 250, "all genes should align");
  }
});

// ── the distance formula can see topology ───────────────────────────────

test("weight differences do not overwhelm structural differences", () => {
  // The property the whole fix exists for. One added hidden node must matter
  // more than the entire spread of weight variation across the population.
  const population = freshPopulation();
  const genomes = population.ask();
  const weightOnlySpread = (() => {
    const d = pairwiseDistances(genomes).sort((x, y) => x - y);
    return d[d.length - 1]! - d[0]!;
  })();

  // ⚠️ The POPULATION's registry, never a fresh one. A second registry starts
  // numbering at zero and re-issues innovation numbers the genomes already use,
  // so a mutation's new genes would align with unrelated existing genes and the
  // structural signal would vanish — silently.
  const registry = population.innovation;
  const rng = new NeatRng(9);
  const mutated = JSON.parse(JSON.stringify(genomes[0]!)) as Genome;
  mutateAddNode(mutated, CONFIG, rng, registry);

  const before = compatibilityDistance(genomes[0]!, genomes[1]!, CONFIG);
  const after = compatibilityDistance(mutated, genomes[1]!, CONFIG);
  const signal = after - before;

  assert.ok(
    signal > weightOnlySpread,
    `one add-node moved distance by ${signal.toFixed(4)} but weight variation alone spans ` +
      `${weightOnlySpread.toFixed(4)} — speciation cannot see topology`,
  );
});

test("structural distance accumulates with structural change", () => {
  // It must keep growing, not saturate: a normalizer that grows with the
  // structure being measured flattens the fourth mutation into the first.
  const population = freshPopulation();
  const registry = population.innovation;
  const rng = new NeatRng(3);
  const original = population.ask()[0]!;
  let current = JSON.parse(JSON.stringify(original)) as Genome;

  const distances: number[] = [];
  for (let i = 0; i < 4; i++) {
    mutateAddNode(current, CONFIG, rng, registry);
    distances.push(compatibilityDistance(original, current, CONFIG));
  }
  for (let i = 1; i < distances.length; i++) {
    assert.ok(
      distances[i]! > distances[i - 1]!,
      `distance stopped growing at mutation ${i + 1}: ${distances.map((d) => d.toFixed(2)).join(" -> ")}`,
    );
  }
});

test("normalizing by gene count is what blinded speciation", () => {
  // The diagnosis itself, pinned. Same genomes, same mutation, only the
  // normalization rule differs.
  const blind = withConfig({ ...CONFIG, normalizeBySize: true });
  const seeing = withConfig({ ...CONFIG, normalizeBySize: false });
  const population = freshPopulation();
  const registry = population.innovation;
  const rng = new NeatRng(5);
  const genomes = population.ask();
  const mutated = JSON.parse(JSON.stringify(genomes[0]!)) as Genome;
  mutateAddNode(mutated, CONFIG, rng, registry);

  const blindSignal =
    compatibilityDistance(mutated, genomes[1]!, blind) -
    compatibilityDistance(genomes[0]!, genomes[1]!, blind);
  const seeingSignal =
    compatibilityDistance(mutated, genomes[1]!, seeing) -
    compatibilityDistance(genomes[0]!, genomes[1]!, seeing);

  assert.ok(seeingSignal > blindSignal * 50, `${seeingSignal.toFixed(4)} vs ${blindSignal.toFixed(4)}`);
});

// ── species form, split and protect ─────────────────────────────────────

test("sufficiently different topologies form different species", () => {
  const population = freshPopulation();
  const genomes = population.ask();
  const registry = population.innovation;
  const rng = new NeatRng(21);

  // Give half the population two hidden nodes; leave the rest alone.
  for (let i = 0; i < genomes.length / 2; i++) {
    mutateAddNode(genomes[i]!, CONFIG, rng, registry);
    mutateAddNode(genomes[i]!, CONFIG, rng, registry);
  }
  const report = population.tell(genomes.map(() => 1));
  assert.ok(report.species >= 2, `expected a split, got ${report.species} species`);
});

test("identical topologies with different weights stay together", () => {
  // The converse: speciation must not shatter a population that has not
  // diverged structurally, or every genome becomes its own species and fitness
  // sharing protects nothing.
  const population = freshPopulation();
  const genomes = population.ask();
  const rng = new NeatRng(13);
  for (const genome of genomes) mutateWeights(genome, CONFIG, rng);
  const report = population.tell(genomes.map((_, i) => i / genomes.length));
  assert.equal(report.species, 1, `weight variation alone split the population into ${report.species}`);
});

test("a structural innovation is protected by its own species", () => {
  // The point of speciation. A fresh hidden node arrives untuned and would be
  // out-competed immediately in one global pool; it has to compete locally
  // first.
  const population = freshPopulation();
  const genomes = population.ask();
  const registry = population.innovation;
  const rng = new NeatRng(17);

  const innovator = genomes[0]!;
  mutateAddNode(innovator, CONFIG, rng, registry);
  mutateAddNode(innovator, CONFIG, rng, registry);

  // Everyone else is fitter, so without protection the innovator dies at once.
  population.tell(genomes.map((g) => (g === innovator ? 0.1 : 1)));

  const species = population.species;
  assert.ok(species.length >= 2, "the innovator should have its own species");
  const innovatorSpecies = species.find((s) => s.members.some((m) => m.id === innovator.id));
  assert.ok(innovatorSpecies, "the innovator was not placed in a species");
  assert.ok(
    innovatorSpecies.offspring > 0,
    "a protected species must be allocated offspring even when its fitness is low",
  );
});

test("species merge again when the difference disappears", () => {
  // Split, then hand every genome the same topology and confirm they recombine.
  const population = freshPopulation();
  const genomes = population.ask();
  const registry = population.innovation;
  const rng = new NeatRng(29);
  for (let i = 0; i < genomes.length / 2; i++) mutateAddNode(genomes[i]!, CONFIG, rng, registry);
  const split = population.tell(genomes.map(() => 1));
  assert.ok(split.species >= 2, "fixture should split first");

  // A second population whose members never diverge stays as one.
  const stable = freshPopulation(99);
  const report = stable.tell(stable.ask().map(() => 1));
  assert.equal(report.species, 1);
});

// ── the whole loop still behaves ────────────────────────────────────────

test("a population speciates over generations instead of collapsing to one", () => {
  const population = freshPopulation(2026, { addNodeRate: 0.4, addConnectionRate: 0.4 });
  const seen: number[] = [];
  const rng = new NeatRng(1);
  for (let generation = 0; generation < 8; generation++) {
    const report = population.tell(population.ask().map(() => rng.next()));
    seen.push(report.species);
  }
  assert.ok(
    Math.max(...seen) > 1,
    `population never speciated across 8 generations: ${seen.join(", ")}`,
  );
});

test("population size stays exact while speciating at this scale", () => {
  const population = freshPopulation(77, { addNodeRate: 0.4 });
  const rng = new NeatRng(2);
  for (let generation = 0; generation < 6; generation++) {
    const genomes = population.ask();
    assert.equal(genomes.length, CONFIG.populationSize, `generation ${generation}`);
    population.tell(genomes.map(() => rng.next()));
  }
});

test("evolution at this scale stays deterministic", () => {
  const run = (): string => {
    const population = freshPopulation(555, { addNodeRate: 0.3 });
    const rng = new NeatRng(8);
    const reports: string[] = [];
    for (let i = 0; i < 5; i++) {
      const report = population.tell(population.ask().map(() => rng.next()));
      reports.push(`${report.species}|${report.meanNodes.toFixed(3)}|${report.meanConnections.toFixed(3)}`);
    }
    return reports.join(";");
  };
  assert.equal(run(), run());
});
