import type { NeatConfig } from "./config.js";
import type { ConnectionGene, NodeGene } from "./gene.js";
import { addConnection, addNode, cloneGenome, type Genome } from "./genome.js";
import type { NeatRng } from "./rng.js";

/**
 * NEAT crossover, aligned by innovation number.
 *
 * Matching genes (same innovation in both parents) are inherited at random from
 * either. Disjoint and excess genes come from the FITTER parent only — that is
 * what stops crossover from being a topology blender and makes it a way of
 * combining what already works.
 *
 * Nodes follow the genes: the child receives every node referenced by a gene it
 * inherited, plus every input/bias/output. Building the node set from the
 * inherited connections rather than from a parent is what makes
 * "connection to a missing node" structurally impossible.
 */

export interface CrossoverResult {
  child: Genome;
  matching: number;
  disjointFromFitter: number;
  excessFromFitter: number;
}

/**
 * Recombines two parents.
 *
 * Equal fitness is resolved by taking the SMALLER genome as the fitter — the
 * standard tie-break, and one that quietly resists bloat. When sizes also tie,
 * the first parent wins, so the operation stays deterministic rather than
 * spending a random draw on a decision that does not matter.
 */
export function crossover(
  parentA: Genome,
  parentB: Genome,
  config: NeatConfig,
  rng: NeatRng,
  childId: string,
): CrossoverResult {
  let fitter = parentA;
  let other = parentB;
  if (parentB.fitness > parentA.fitness) {
    fitter = parentB;
    other = parentA;
  } else if (parentB.fitness === parentA.fitness) {
    if (parentB.connections.length < parentA.connections.length) {
      fitter = parentB;
      other = parentA;
    }
  }

  const otherGenes = new Map<number, ConnectionGene>();
  for (const gene of other.connections) otherGenes.set(gene.innovation, gene);
  const otherMax = other.connections.length
    ? other.connections[other.connections.length - 1]!.innovation
    : -1;

  const child: Genome = {
    id: childId,
    nodes: [],
    connections: [],
    fitness: 0,
    adjustedFitness: 0,
    speciesId: null,
  };

  // Fixed-role nodes always survive, whatever the genes say.
  const nodesById = new Map<number, NodeGene>();
  for (const node of fitter.nodes) {
    if (node.type !== "hidden") nodesById.set(node.id, { ...node });
  }
  const fitterNodes = new Map(fitter.nodes.map((n) => [n.id, n]));
  const otherNodes = new Map(other.nodes.map((n) => [n.id, n]));

  let matching = 0;
  let disjoint = 0;
  let excess = 0;

  for (const gene of fitter.connections) {
    const match = otherGenes.get(gene.innovation);
    let inherited: ConnectionGene;
    if (match !== undefined) {
      matching += 1;
      const source = rng.chance(0.5) ? gene : match;
      inherited = { ...source };
      // A gene disabled in EITHER parent is usually disabled in the child;
      // occasionally it comes back, which is how a structure that was switched
      // off in an ancestor gets another chance.
      if (!gene.enabled || !match.enabled) {
        inherited.enabled = !rng.chance(config.inheritDisabledChance);
      }
    } else {
      if (gene.innovation > otherMax) excess += 1;
      else disjoint += 1;
      inherited = { ...gene };
    }
    addConnection(child, inherited);
    for (const id of [inherited.from, inherited.to]) {
      if (nodesById.has(id)) continue;
      const node = fitterNodes.get(id) ?? otherNodes.get(id);
      if (node !== undefined) nodesById.set(id, { ...node });
    }
  }

  for (const node of [...nodesById.values()].sort((a, b) => a.id - b.id)) {
    addNode(child, node);
  }
  return { child, matching, disjointFromFitter: disjoint, excessFromFitter: excess };
}

/** Asexual reproduction: a straight copy, mutated by the caller. */
export function clone(parent: Genome, childId: string): Genome {
  const child = cloneGenome(parent, childId);
  child.fitness = 0;
  child.adjustedFitness = 0;
  child.speciesId = null;
  return child;
}
