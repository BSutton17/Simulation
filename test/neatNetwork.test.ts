import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InnovationRegistry,
  NeatRng,
  buildNetwork,
  cloneGenome,
  createGenome,
  firstHiddenId,
  mutate,
  withConfig,
  type ConnectionGene,
  type Genome,
  type GenomeShape,
} from "../simulation/src/neat/index.js";
import { ACTION_SIZE, OBSERVATION_SIZE, type Network } from "../simulation/src/ai/index.js";
import { ELEMENTALS_SHAPE } from "../simulation/src/training/index.js";

/**
 * Genome → network.
 *
 * The compiler is where a genome stops being data and starts being behaviour,
 * and its one non-obvious requirement is CANONICAL ORDERING: crossover builds a
 * genome's arrays in a different sequence from mutation, so two semantically
 * identical genomes can carry their genes in different orders. Anything but a
 * canonical evaluation order gives them different outputs.
 */

const SHAPE: GenomeShape = { inputs: 2, outputs: 1, activation: "sigmoid" };

function connect(genome: Genome, connections: ConnectionGene[]): Genome {
  genome.connections = [...connections].sort((a, b) => a.innovation - b.innovation);
  return genome;
}

test("a network reports the genome's input and output counts", () => {
  const network = buildNetwork(createGenome("g", SHAPE));
  assert.equal(network.inputSize, 2);
  assert.equal(network.outputSize, 1);
});

test("the bias node contributes a constant 1", () => {
  // Only the bias is wired, at weight 1, so the output is activation(1).
  const genome = connect(createGenome("g", SHAPE), [
    { innovation: 0, from: 2, to: 3, weight: 1, enabled: true },
  ]);
  const network = buildNetwork(genome);
  const outputs = new Float32Array(1);
  network.activate(new Float32Array([0, 0]), outputs);
  const expected = 1 / (1 + Math.exp(-4.9));
  assert.ok(Math.abs(outputs[0]! - expected) < 1e-6, `got ${outputs[0]}, expected ${expected}`);
});

test("inputs reach the output through their weights", () => {
  const genome = connect(createGenome("g", SHAPE), [
    { innovation: 0, from: 0, to: 3, weight: 2, enabled: true },
    { innovation: 1, from: 1, to: 3, weight: -1, enabled: true },
  ]);
  const network = buildNetwork(genome);
  const outputs = new Float32Array(1);
  network.activate(new Float32Array([1, 1]), outputs);
  const expected = 1 / (1 + Math.exp(-4.9 * (2 - 1)));
  assert.ok(Math.abs(outputs[0]! - expected) < 1e-6);
});

test("disabled genes carry no signal", () => {
  const genome = connect(createGenome("g", SHAPE), [
    { innovation: 0, from: 0, to: 3, weight: 10, enabled: false },
  ]);
  const outputs = new Float32Array(1);
  buildNetwork(genome).activate(new Float32Array([1, 1]), outputs);
  assert.ok(Math.abs(outputs[0]! - 0.5) < 1e-6, "a disabled-only network should sit at activation(0)");
});

test("a hidden node is evaluated before the output that depends on it", () => {
  const genome = createGenome("g", SHAPE);
  genome.nodes.push({ id: 4, type: "hidden", activation: "identity" });
  genome.nodes.sort((a, b) => a.id - b.id);
  connect(genome, [
    { innovation: 0, from: 0, to: 4, weight: 1, enabled: true },
    { innovation: 1, from: 4, to: 3, weight: 1, enabled: true },
  ]);
  const outputs = new Float32Array(1);
  buildNetwork(genome).activate(new Float32Array([1, 0]), outputs);
  // identity hidden → 1, then sigmoid at the output.
  const expected = 1 / (1 + Math.exp(-4.9));
  assert.ok(Math.abs(outputs[0]! - expected) < 1e-6, `got ${outputs[0]}`);
});

test("gene order in the array does not change behaviour", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  const rng = new NeatRng(4);
  let genome = createGenome("g", SHAPE);
  const config = withConfig({ addConnectionRate: 1, addNodeRate: 0.7 });
  for (let i = 0; i < 25; i++) genome = mutate(genome, config, rng, registry, `g${i}`);

  const shuffled = cloneGenome(genome, "shuffled");
  // Reverse the arrays: semantically the same genome, different insertion order.
  shuffled.connections.reverse();
  shuffled.nodes.reverse();

  const a = new Float32Array(1);
  const b = new Float32Array(1);
  const inputs = new Float32Array([0.3, -0.7]);
  buildNetwork(genome).activate(inputs, a);
  buildNetwork(shuffled).activate(inputs, b);
  assert.ok(
    Math.abs(a[0]! - b[0]!) < 1e-9,
    `array order changed the output: ${a[0]} vs ${b[0]} — evaluation is not canonical`,
  );
});

test("activation is deterministic across repeated calls", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  const rng = new NeatRng(8);
  let genome = createGenome("g", SHAPE);
  for (let i = 0; i < 15; i++) {
    genome = mutate(genome, withConfig({ addConnectionRate: 1, addNodeRate: 0.5 }), rng, registry, `g${i}`);
  }
  const network = buildNetwork(genome);
  const first = new Float32Array(1);
  const second = new Float32Array(1);
  network.activate(new Float32Array([0.5, 0.25]), first);
  network.activate(new Float32Array([0.5, 0.25]), second);
  assert.equal(first[0], second[0]);
});

test("a recurrent genome activates without hanging, using last-pass values", () => {
  const genome = createGenome("g", SHAPE);
  genome.nodes.push({ id: 4, type: "hidden", activation: "identity" });
  genome.nodes.push({ id: 5, type: "hidden", activation: "identity" });
  genome.nodes.sort((a, b) => a.id - b.id);
  connect(genome, [
    { innovation: 0, from: 0, to: 4, weight: 1, enabled: true },
    { innovation: 1, from: 4, to: 5, weight: 1, enabled: true },
    { innovation: 2, from: 5, to: 4, weight: 1, enabled: true }, // the cycle
    { innovation: 3, from: 5, to: 3, weight: 1, enabled: true },
  ]);
  const network = buildNetwork(genome);
  assert.equal(network.recurrent, true, "the cycle should be detected");
  const outputs = new Float32Array(1);
  network.activate(new Float32Array([1, 0]), outputs);
  assert.ok(Number.isFinite(outputs[0]!));
  // A memory network's output moves between passes on constant input.
  const firstPass = outputs[0]!;
  network.activate(new Float32Array([1, 0]), outputs);
  assert.notEqual(outputs[0], firstPass);
});

test("wrong-sized buffers are refused", () => {
  const network = buildNetwork(createGenome("g", SHAPE));
  assert.throws(() => network.activate(new Float32Array(5), new Float32Array(1)), /inputs must be 2/);
  assert.throws(() => network.activate(new Float32Array(2), new Float32Array(9)), /outputs must be 1/);
});

// ── the contract with the AI runtime ────────────────────────────────────

test("a compiled genome satisfies the AI runtime's Network interface", () => {
  const genome = createGenome("elementals", ELEMENTALS_SHAPE);
  const network: Network = buildNetwork(genome); // structural compatibility
  assert.equal(network.inputSize, OBSERVATION_SIZE);
  assert.equal(network.outputSize, ACTION_SIZE);

  const inputs = new Float32Array(OBSERVATION_SIZE);
  const outputs = new Float32Array(ACTION_SIZE);
  network.activate(inputs, outputs);
  assert.equal(outputs.length, 22);
  for (const value of outputs) assert.ok(Number.isFinite(value));
});

test("the Elementals genome shape matches the runtime's dimensions", () => {
  assert.equal(ELEMENTALS_SHAPE.inputs, OBSERVATION_SIZE);
  assert.equal(ELEMENTALS_SHAPE.outputs, ACTION_SIZE);
  // 80 since kingdom identity was added; the point of this test is that the
  // genome shape AGREES with the runtime, not what the number happens to be.
  assert.equal(ELEMENTALS_SHAPE.inputs, 80);
  assert.equal(ELEMENTALS_SHAPE.outputs, 22);
});
