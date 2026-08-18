import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InnovationRegistry,
  NeatRng,
  compatibility,
  compatibilityDistance,
  createGenome,
  crossover,
  firstHiddenId,
  mutate,
  validateGenome,
  withConfig,
  type ConnectionGene,
  type Genome,
  type GenomeShape,
} from "../simulation/src/neat/index.js";

/**
 * Crossover and compatibility distance, on hand-built genomes.
 *
 * Both are pure functions of gene alignment, so they can be tested against
 * arithmetic rather than against emergent behaviour — which matters, because a
 * misclassified excess gene or an inverted distance produces a run that looks
 * healthy for hours and means nothing.
 */

const SHAPE: GenomeShape = { inputs: 2, outputs: 1, activation: "sigmoid" };
const CONFIG = withConfig();

function gene(innovation: number, from: number, to: number, weight = 1, enabled = true): ConnectionGene {
  return { innovation, from, to, weight, enabled };
}

/** A genome with exactly the connections given, in innovation order. */
function build(id: string, connections: ConnectionGene[]): Genome {
  const genome = createGenome(id, SHAPE);
  genome.connections = [...connections].sort((a, b) => a.innovation - b.innovation);
  return genome;
}

// ── compatibility distance ──────────────────────────────────────────────

test("identical genomes are at distance zero", () => {
  const a = build("a", [gene(0, 0, 3), gene(1, 1, 3)]);
  const b = build("b", [gene(0, 0, 3), gene(1, 1, 3)]);
  assert.equal(compatibilityDistance(a, b, CONFIG), 0);
});

test("matching genes contribute only their weight difference", () => {
  const a = build("a", [gene(0, 0, 3, 1)]);
  const b = build("b", [gene(0, 0, 3, 3)]);
  const config = withConfig({ weightCoefficient: 0.5, smallGenomeSize: 20 });
  const result = compatibility(a, b, config);
  assert.equal(result.matching, 1);
  assert.equal(result.excess, 0);
  assert.equal(result.disjoint, 0);
  assert.equal(result.meanWeightDifference, 2);
  assert.equal(result.distance, 0.5 * 2);
});

test("disjoint and excess genes are classified correctly", () => {
  // A: innovations 0,1,2   B: innovations 0,2,5
  // 1 is disjoint (inside B's range), 5 is excess (beyond A's highest).
  const a = build("a", [gene(0, 0, 3), gene(1, 1, 3), gene(2, 2, 3)]);
  const b = build("b", [gene(0, 0, 3), gene(2, 2, 3), gene(5, 1, 3)]);
  const result = compatibility(a, b, withConfig({ smallGenomeSize: 20 }));
  assert.equal(result.matching, 2);
  assert.equal(result.disjoint, 1, "innovation 1 should be disjoint");
  assert.equal(result.excess, 1, "innovation 5 should be excess");
});

test("distance uses c1·E/N + c2·D/N + c3·W", () => {
  const a = build("a", [gene(0, 0, 3, 1), gene(1, 1, 3, 1), gene(2, 2, 3, 1)]);
  const b = build("b", [gene(0, 0, 3, 2), gene(2, 2, 3, 1), gene(5, 1, 3, 1)]);
  const config = withConfig({
    excessCoefficient: 2,
    disjointCoefficient: 3,
    weightCoefficient: 4,
    smallGenomeSize: 20, // N = 1 at this size
  });
  // E=1, D=1, matching weights differ by |1-2| and |1-1| → mean 0.5
  const expected = 2 * 1 + 3 * 1 + 4 * 0.5;
  assert.equal(compatibilityDistance(a, b, config), expected);
});

test("large genomes are normalized by gene count", () => {
  const many = (n: number, offset = 0): ConnectionGene[] =>
    Array.from({ length: n }, (_, i) => gene(i + offset, 0, 3));
  const a = build("a", many(30));
  const b = build("b", [...many(30), gene(100, 1, 3)]);
  const config = withConfig({ smallGenomeSize: 20, excessCoefficient: 1, weightCoefficient: 0 });
  // One excess gene over N = 31.
  assert.ok(Math.abs(compatibilityDistance(a, b, config) - 1 / 31) < 1e-9);
});

test("two empty genomes are compatible", () => {
  assert.equal(compatibilityDistance(build("a", []), build("b", []), CONFIG), 0);
});

// ── crossover ───────────────────────────────────────────────────────────

test("disjoint and excess genes come from the fitter parent only", () => {
  const fit = build("fit", [gene(0, 0, 3), gene(1, 1, 3), gene(7, 2, 3)]);
  fit.fitness = 10;
  const weak = build("weak", [gene(0, 0, 3), gene(2, 2, 3)]);
  weak.fitness = 1;

  const { child, matching } = crossover(fit, weak, CONFIG, new NeatRng(3), "child");
  const innovations = child.connections.map((c) => c.innovation);
  assert.equal(matching, 1);
  assert.deepEqual(innovations, [0, 1, 7], "the child should carry the fitter parent's genes");
  assert.ok(!innovations.includes(2), "a weaker parent's disjoint gene must not be inherited");
});

test("crossover never produces a connection to a missing node", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  const rng = new NeatRng(11);
  const config = withConfig({ addConnectionRate: 1, addNodeRate: 0.8 });

  let a = createGenome("a", SHAPE);
  let b = createGenome("b", SHAPE);
  for (let i = 0; i < 20; i++) {
    a = mutate(a, config, rng, registry, `a${i}`);
    b = mutate(b, config, rng, registry, `b${i}`);
  }
  a.fitness = 5;
  b.fitness = 3;

  for (let i = 0; i < 40; i++) {
    const { child } = crossover(a, b, config, new NeatRng(i), `c${i}`);
    assert.deepEqual(validateGenome(child), [], `child ${i} is structurally invalid`);
  }
});

test("equal fitness prefers the smaller genome, deterministically", () => {
  const small = build("small", [gene(0, 0, 3)]);
  const large = build("large", [gene(0, 0, 3), gene(1, 1, 3), gene(2, 2, 3)]);
  small.fitness = 5;
  large.fitness = 5;

  const fromSmallFirst = crossover(small, large, CONFIG, new NeatRng(1), "c1").child;
  const fromLargeFirst = crossover(large, small, CONFIG, new NeatRng(1), "c2").child;
  assert.equal(fromSmallFirst.connections.length, 1, "the smaller genome should win the tie");
  assert.equal(fromLargeFirst.connections.length, 1);
});

test("a gene disabled in either parent can be re-enabled in the child", () => {
  const a = build("a", [gene(0, 0, 3, 1, false)]);
  const b = build("b", [gene(0, 0, 3, 1, true)]);
  a.fitness = 2;
  b.fitness = 1;

  const always = withConfig({ inheritDisabledChance: 1 });
  assert.equal(crossover(a, b, always, new NeatRng(4), "c").child.connections[0]!.enabled, false);

  const never = withConfig({ inheritDisabledChance: 0 });
  assert.equal(crossover(a, b, never, new NeatRng(4), "c").child.connections[0]!.enabled, true);
});

test("matching genes are inherited from one parent or the other", () => {
  const a = build("a", [gene(0, 0, 3, 1)]);
  const b = build("b", [gene(0, 0, 3, 9)]);
  a.fitness = 5;
  b.fitness = 5;
  const weights = new Set<number>();
  for (let i = 0; i < 30; i++) {
    weights.add(crossover(a, b, CONFIG, new NeatRng(i), "c").child.connections[0]!.weight);
  }
  assert.deepEqual([...weights].sort((x, y) => x - y), [1, 9]);
});

test("crossover is deterministic for a given seed", () => {
  const a = build("a", [gene(0, 0, 3, 1), gene(1, 1, 3, 2)]);
  const b = build("b", [gene(0, 0, 3, 5), gene(1, 1, 3, 6)]);
  a.fitness = 3;
  b.fitness = 2;
  const first = crossover(a, b, CONFIG, new NeatRng(77), "c").child;
  const second = crossover(a, b, CONFIG, new NeatRng(77), "c").child;
  assert.deepEqual(first.connections, second.connections);
});
