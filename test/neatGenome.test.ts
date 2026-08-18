import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InnovationRegistry,
  NeatRng,
  createGenome,
  createsCycle,
  firstHiddenId,
  hasConnection,
  mutate,
  mutateAddConnection,
  mutateAddNode,
  mutateReenable,
  mutateToggleEnable,
  mutateWeights,
  validateGenome,
  withConfig,
  type Genome,
  type GenomeShape,
} from "../simulation/src/neat/index.js";

/**
 * Genome construction, mutation and innovation tracking.
 *
 * Mutation is where a NEAT implementation usually goes quietly wrong: a
 * duplicate connection, a cycle in a feed-forward network, or an innovation
 * number handed out twice all produce genomes that still evaluate and still
 * evolve, just meaninglessly.
 */

const SHAPE: GenomeShape = { inputs: 2, outputs: 1, activation: "sigmoid" };
const CONFIG = withConfig({ addConnectionTries: 100 });

function fixture(): { genome: Genome; registry: InnovationRegistry; rng: NeatRng } {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  return { genome: createGenome("g0", SHAPE), registry, rng: new NeatRng(1) };
}

test("a new genome has inputs, a bias and outputs, and no connections", () => {
  const { genome } = fixture();
  assert.equal(genome.nodes.filter((n) => n.type === "input").length, 2);
  assert.equal(genome.nodes.filter((n) => n.type === "bias").length, 1);
  assert.equal(genome.nodes.filter((n) => n.type === "output").length, 1);
  assert.equal(genome.connections.length, 0);
  assert.deepEqual(validateGenome(genome), []);
});

test("add-connection creates a legal, non-duplicate gene", () => {
  const { genome, registry, rng } = fixture();
  const gene = mutateAddConnection(genome, CONFIG, rng, registry);
  assert.ok(gene, "no connection was added");
  assert.equal(genome.connections.length, 1);
  assert.deepEqual(validateGenome(genome), []);
  // Never into an input or the bias.
  const target = genome.nodes.find((n) => n.id === gene.to)!;
  assert.ok(target.type === "hidden" || target.type === "output");
});

test("add-connection never duplicates an existing pair", () => {
  const { genome, registry, rng } = fixture();
  for (let i = 0; i < 40; i++) mutateAddConnection(genome, CONFIG, rng, registry);
  const seen = new Set<string>();
  for (const c of genome.connections) {
    const key = `${c.from}:${c.to}`;
    assert.ok(!seen.has(key), `duplicate connection ${key}`);
    seen.add(key);
  }
});

test("add-node splits a connection into two and disables the original", () => {
  const { genome, registry, rng } = fixture();
  mutateAddConnection(genome, CONFIG, rng, registry);
  const original = genome.connections[0]!;
  const originalWeight = original.weight;

  const nodeId = mutateAddNode(genome, CONFIG, rng, registry);
  assert.ok(nodeId !== null);
  assert.equal(original.enabled, false, "the split connection should be disabled");
  assert.equal(genome.nodes.filter((n) => n.type === "hidden").length, 1);
  assert.ok(hasConnection(genome, original.from, nodeId!));
  assert.ok(hasConnection(genome, nodeId!, original.to));
  assert.deepEqual(validateGenome(genome), []);

  // The classic form: in at weight 1, out at the original weight, so the
  // network's behaviour barely changes at the moment of the mutation.
  const incoming = genome.connections.find((c) => c.from === original.from && c.to === nodeId)!;
  const outgoing = genome.connections.find((c) => c.from === nodeId && c.to === original.to)!;
  assert.equal(incoming.weight, 1);
  assert.equal(outgoing.weight, originalWeight);
});

test("mutation can build a network with several hidden nodes", () => {
  const { genome, registry, rng } = fixture();
  const config = withConfig({ addConnectionRate: 1, addNodeRate: 1, weightMutationRate: 0 });
  let current = genome;
  for (let i = 0; i < 25; i++) current = mutate(current, config, rng, registry, `g${i}`);
  assert.ok(
    current.nodes.filter((n) => n.type === "hidden").length >= 3,
    "repeated mutation should complexify",
  );
  assert.deepEqual(validateGenome(current), []);
});

test("the same structural mutation gets the same innovation number", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  // Two lineages growing the same connection must recognise it as the same
  // gene, which is the entire point of historical markings.
  assert.equal(registry.connection(0, 3), registry.connection(0, 3));
  assert.notEqual(registry.connection(0, 3), registry.connection(1, 3));
  // And splitting the same connection must yield the same node id.
  assert.equal(registry.splitNode(0), registry.splitNode(0));
  assert.notEqual(registry.splitNode(0), registry.splitNode(1));
});

test("innovation numbers are assigned without any randomness", () => {
  const a = new InnovationRegistry(4);
  const b = new InnovationRegistry(4);
  for (const [from, to] of [[0, 3], [1, 3], [2, 3], [0, 5]] as const) {
    assert.equal(a.connection(from, to), b.connection(from, to));
  }
  assert.deepEqual(a.counters, b.counters);
});

test("the innovation registry round-trips through JSON", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  registry.connection(0, 3);
  registry.connection(1, 3);
  registry.splitNode(0);
  const restored = InnovationRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
  assert.deepEqual(restored.counters, registry.counters);
  assert.equal(restored.connection(0, 3), 0, "a known connection keeps its number");
  assert.equal(restored.splitNode(0), registry.splitNode(0));
});

test("feed-forward mutation never closes a cycle", () => {
  const registry = new InnovationRegistry(firstHiddenId(SHAPE));
  const rng = new NeatRng(9);
  const config = withConfig({ addConnectionRate: 1, addNodeRate: 0.5, allowRecurrent: false });
  let genome = createGenome("g", SHAPE);
  for (let i = 0; i < 60; i++) genome = mutate(genome, config, rng, registry, `g${i}`);

  for (const c of genome.connections) {
    if (!c.enabled) continue;
    // Removing the edge and asking whether it would reintroduce a cycle is the
    // same question `createsCycle` answers when the edge is proposed.
    const without: Genome = { ...genome, connections: genome.connections.filter((x) => x !== c) };
    assert.equal(
      createsCycle(without, c.from, c.to),
      false,
      `connection ${c.from}->${c.to} closes a cycle`,
    );
  }
});

test("weight mutation stays inside the cap", () => {
  const { genome, registry, rng } = fixture();
  for (let i = 0; i < 5; i++) mutateAddConnection(genome, CONFIG, rng, registry);
  const config = withConfig({ weightCap: 3, weightPerturbPower: 50, weightPerturbChance: 1 });
  for (let i = 0; i < 200; i++) mutateWeights(genome, config, rng);
  for (const c of genome.connections) {
    assert.ok(Math.abs(c.weight) <= 3.0001, `weight ${c.weight} escaped the cap`);
  }
});

test("toggle disables and re-enable restores", () => {
  const { genome, registry, rng } = fixture();
  mutateAddConnection(genome, CONFIG, rng, registry);
  mutateToggleEnable(genome, rng);
  assert.equal(genome.connections[0]!.enabled, false);
  mutateReenable(genome, CONFIG, rng);
  assert.equal(genome.connections[0]!.enabled, true);
});

test("mutation leaves the original genome untouched", () => {
  const { genome, registry, rng } = fixture();
  mutateAddConnection(genome, CONFIG, rng, registry);
  const before = JSON.stringify(genome);
  mutate(genome, withConfig({ addNodeRate: 1, addConnectionRate: 1 }), rng, registry, "child");
  assert.equal(JSON.stringify(genome), before, "mutate must not modify its input");
});

test("connections stay sorted by innovation", () => {
  const { genome, registry, rng } = fixture();
  const config = withConfig({ addConnectionRate: 1, addNodeRate: 1 });
  let current = genome;
  for (let i = 0; i < 30; i++) current = mutate(current, config, rng, registry, `g${i}`);
  assert.deepEqual(validateGenome(current), []);
});
