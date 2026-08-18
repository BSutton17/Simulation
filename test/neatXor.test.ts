import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateXor, runXor, withConfig, XOR_CONFIG } from "../simulation/src/neat/index.js";

/**
 * The XOR proof.
 *
 * XOR is not linearly separable, so it CANNOT be solved by a network with no
 * hidden node. A run that solves it has therefore demonstrably discovered
 * TOPOLOGY, not merely tuned weights on the structure it was handed — which is
 * the one property separating this from a genetic algorithm over a fixed
 * network.
 *
 * It is also the cheapest possible place to catch a misaligned crossover, an
 * inverted compatibility distance or a broken speciation pass. Every other way
 * of finding those out costs an eight-hour training run and a confusing graph.
 */

test("NEAT solves XOR", () => {
  const result = runXor(1, 200);
  assert.equal(result.solved, true, `unsolved after ${result.generations} generations`);
  assert.ok(result.generations > 0);
});

test("the returned champion genuinely classifies all four cases", () => {
  // Re-evaluated independently: `runXor` reporting "solved" and the genome it
  // hands back disagreeing is exactly the bug this catches.
  const result = runXor(7, 200);
  assert.equal(result.solved, true);
  const check = evaluateXor(result.bestGenome);
  assert.equal(check.solved, true, `champion outputs: ${check.outputs.map((o) => o.toFixed(3))}`);
  const [ff, ft, tf, tt] = check.outputs as [number, number, number, number];
  assert.ok(ff <= 0.5, `0 XOR 0 should be low, got ${ff}`);
  assert.ok(ft > 0.5, `0 XOR 1 should be high, got ${ft}`);
  assert.ok(tf > 0.5, `1 XOR 0 should be high, got ${tf}`);
  assert.ok(tt <= 0.5, `1 XOR 1 should be low, got ${tt}`);
});

test("the solution contains hidden nodes — topology was discovered", () => {
  const result = runXor(3, 200);
  assert.equal(result.solved, true);
  assert.ok(
    result.hiddenNodes >= 1,
    "XOR is not linearly separable; a solution without a hidden node is impossible",
  );
});

test("it solves XOR across several independent seeds", () => {
  // Not a single lucky run. Reliability across seeds is what says the algorithm
  // works rather than that one initial population happened to be well placed.
  const seeds = [1, 2, 5, 42, 101];
  const solved = seeds.filter((seed) => runXor(seed, 200).solved);
  assert.equal(
    solved.length,
    seeds.length,
    `only ${solved.length}/${seeds.length} seeds solved: ${solved.join(", ")}`,
  );
});

test("fitness improves over the course of a run", () => {
  const result = runXor(42, 200);
  const first = result.history[0]!;
  const last = result.history[result.history.length - 1]!;
  assert.ok(
    last.best > first.best,
    `best fitness did not improve: ${first.best.toFixed(3)} -> ${last.best.toFixed(3)}`,
  );
});

test("the population speciates rather than collapsing to one lineage", () => {
  const result = runXor(3, 200);
  const maxSpecies = Math.max(...result.history.map((h) => h.species));
  assert.ok(maxSpecies > 1, "speciation never separated anything");
});

test("a run is reproducible for a given seed", () => {
  const a = runXor(2024, 100);
  const b = runXor(2024, 100);
  assert.equal(a.solved, b.solved);
  assert.equal(a.generations, b.generations);
  assert.equal(a.bestFitness, b.bestFitness);
  assert.deepEqual(a.outputs, b.outputs);
});

test("a network with no hidden nodes cannot solve XOR", () => {
  // The premise of the whole benchmark, asserted rather than assumed: with
  // structural mutation switched off, evolution has only weights to work with
  // and must fail.
  const flat = withConfig({ ...XOR_CONFIG, addNodeRate: 0, addConnectionRate: 0 });
  const result = runXor(11, 60, flat);
  assert.equal(result.hiddenNodes, 0);
  assert.equal(result.solved, false, "a perceptron solved XOR — the benchmark is not measuring what it claims");
});
