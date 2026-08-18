import type { ActivationName, ConnectionGene, NodeGene } from "./gene.js";

/**
 * A genome: a set of node genes and connection genes.
 *
 * Arrays rather than Maps, kept sorted — nodes by id, connections by innovation.
 * Iteration order is then a property of the data instead of of insertion
 * history, which matters because crossover builds genomes in a different order
 * from mutation and the two must still behave identically. A Map-ordered
 * genome would compile to a different activation sequence than a semantically
 * identical one, and with recurrent connections that is a different *result*.
 */
export interface Genome {
  /** Unique within a run, for reports and checkpoints. */
  id: string;
  nodes: NodeGene[];
  connections: ConnectionGene[];
  /** Raw fitness, set by the evaluator. */
  fitness: number;
  /** Fitness after species sharing; set during reproduction. */
  adjustedFitness: number;
  /** Species this genome belonged to at the last speciation. */
  speciesId: number | null;
}

export interface GenomeShape {
  inputs: number;
  outputs: number;
  /** Activation for output nodes (and for hidden nodes as they appear). */
  activation: ActivationName;
}

/** Node ids are laid out so the fixed roles are known without a lookup:
 *  0..inputs-1 are inputs, `inputs` is the bias, then the outputs. Hidden nodes
 *  take ids from the registry, always above these. */
export function inputNodeId(index: number): number {
  return index;
}

export function biasNodeId(shape: GenomeShape): number {
  return shape.inputs;
}

export function outputNodeId(shape: GenomeShape, index: number): number {
  return shape.inputs + 1 + index;
}

/** The first id a hidden node may take. */
export function firstHiddenId(shape: GenomeShape): number {
  return shape.inputs + 1 + shape.outputs;
}

/** An empty genome with the fixed input/bias/output nodes and no connections. */
export function createGenome(id: string, shape: GenomeShape): Genome {
  const nodes: NodeGene[] = [];
  for (let i = 0; i < shape.inputs; i++) {
    nodes.push({ id: inputNodeId(i), type: "input", activation: "identity" });
  }
  nodes.push({ id: biasNodeId(shape), type: "bias", activation: "identity" });
  for (let i = 0; i < shape.outputs; i++) {
    nodes.push({
      id: outputNodeId(shape, i),
      type: "output",
      activation: shape.activation,
    });
  }
  return { id, nodes, connections: [], fitness: 0, adjustedFitness: 0, speciesId: null };
}

export function cloneGenome(genome: Genome, id = genome.id): Genome {
  return {
    id,
    nodes: genome.nodes.map((n) => ({ ...n })),
    connections: genome.connections.map((c) => ({ ...c })),
    fitness: genome.fitness,
    adjustedFitness: genome.adjustedFitness,
    speciesId: genome.speciesId,
  };
}

export function findNode(genome: Genome, id: number): NodeGene | undefined {
  return genome.nodes.find((n) => n.id === id);
}

export function hasConnection(genome: Genome, from: number, to: number): boolean {
  return genome.connections.some((c) => c.from === from && c.to === to);
}

/** Inserts a node, keeping the array sorted by id. */
export function addNode(genome: Genome, node: NodeGene): void {
  const at = genome.nodes.findIndex((n) => n.id > node.id);
  if (at < 0) genome.nodes.push(node);
  else genome.nodes.splice(at, 0, node);
}

/** Inserts a connection, keeping the array sorted by innovation. */
export function addConnection(genome: Genome, connection: ConnectionGene): void {
  const at = genome.connections.findIndex((c) => c.innovation > connection.innovation);
  if (at < 0) genome.connections.push(connection);
  else genome.connections.splice(at, 0, connection);
}

/** Genes actually contributing signal. */
export function enabledConnections(genome: Genome): ConnectionGene[] {
  return genome.connections.filter((c) => c.enabled);
}

/**
 * Structural sanity, used by tests and by checkpoint loading.
 *
 * Crossover recombines two topologies, and a gene referring to a node the
 * child never inherited produces a network that throws at activation time —
 * deep inside a training run, hours in. Cheap to check, expensive to discover
 * late.
 */
export function validateGenome(genome: Genome): string[] {
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const node of genome.nodes) {
    if (ids.has(node.id)) problems.push(`duplicate node ${node.id}`);
    ids.add(node.id);
  }
  const seen = new Set<number>();
  for (const c of genome.connections) {
    if (seen.has(c.innovation)) problems.push(`duplicate innovation ${c.innovation}`);
    seen.add(c.innovation);
    if (!ids.has(c.from)) problems.push(`connection ${c.innovation} from missing node ${c.from}`);
    if (!ids.has(c.to)) problems.push(`connection ${c.innovation} to missing node ${c.to}`);
    if (!Number.isFinite(c.weight)) problems.push(`connection ${c.innovation} has weight ${c.weight}`);
  }
  for (let i = 1; i < genome.connections.length; i++) {
    if (genome.connections[i - 1]!.innovation > genome.connections[i]!.innovation) {
      problems.push("connections are not sorted by innovation");
      break;
    }
  }
  return problems;
}

/** Compact stats for reports. */
export function genomeSize(genome: Genome): { nodes: number; connections: number; enabled: number } {
  return {
    nodes: genome.nodes.length,
    connections: genome.connections.length,
    enabled: genome.connections.filter((c) => c.enabled).length,
  };
}
