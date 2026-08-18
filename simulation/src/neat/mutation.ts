import type { NeatConfig } from "./config.js";
import type { ConnectionGene } from "./gene.js";
import {
  addConnection,
  addNode,
  cloneGenome,
  hasConnection,
  type Genome,
  type GenomeShape,
} from "./genome.js";
import type { InnovationRegistry } from "./innovation.js";
import type { NeatRng } from "./rng.js";

/**
 * The mutation operators.
 *
 * Structural mutations go through the innovation registry so the same change
 * made by two genomes carries the same identity. Weight mutations are local and
 * need no registry.
 */

const clampWeight = (w: number, cap: number): number =>
  w > cap ? cap : w < -cap ? -cap : w;

/**
 * Perturb or replace weights.
 *
 * Mostly small nudges, occasionally a fresh value. The nudge is the workhorse —
 * it is how a topology that is nearly right becomes right — while the reset is
 * what lets a weight escape a bad basin instead of crawling out of it.
 */
export function mutateWeights(genome: Genome, config: NeatConfig, rng: NeatRng): void {
  for (const connection of genome.connections) {
    if (rng.chance(config.weightPerturbChance)) {
      connection.weight = clampWeight(
        connection.weight + rng.gaussian() * config.weightPerturbPower,
        config.weightCap,
      );
    } else {
      connection.weight = rng.spread(config.weightResetRange);
    }
  }
}

/** Every node that may originate a connection. */
function sourceCandidates(genome: Genome): number[] {
  return genome.nodes.filter((n) => n.type !== "output").map((n) => n.id);
}

/** Every node that may receive one. Inputs and the bias never do. */
function targetCandidates(genome: Genome): number[] {
  return genome.nodes.filter((n) => n.type === "hidden" || n.type === "output").map((n) => n.id);
}

/**
 * Whether adding from→to would close a cycle.
 *
 * Walks forward from `to` looking for `from`. Only enabled genes count: a
 * disabled connection carries no signal, so it cannot make the network
 * recurrent, and treating it as if it could needlessly blocks legal mutations.
 */
export function createsCycle(genome: Genome, from: number, to: number): boolean {
  if (from === to) return true;
  const stack = [to];
  const seen = new Set<number>([to]);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    for (const c of genome.connections) {
      if (!c.enabled || c.from !== current) continue;
      if (seen.has(c.to)) continue;
      seen.add(c.to);
      stack.push(c.to);
    }
  }
  return false;
}

/**
 * Add one connection between two previously unconnected nodes.
 *
 * Returns the new gene, or null when no legal pair was found — a small,
 * densely-connected genome genuinely runs out of room, and that is not an
 * error. Tries a bounded number of random pairs rather than enumerating: with
 * sixty-five inputs the full pair set is large and almost always has room.
 */
export function mutateAddConnection(
  genome: Genome,
  config: NeatConfig,
  rng: NeatRng,
  registry: InnovationRegistry,
): ConnectionGene | null {
  const sources = sourceCandidates(genome);
  const targets = targetCandidates(genome);
  if (sources.length === 0 || targets.length === 0) return null;

  for (let attempt = 0; attempt < config.addConnectionTries; attempt++) {
    const from = rng.pick(sources);
    const to = rng.pick(targets);
    if (from === to) continue;
    if (hasConnection(genome, from, to)) continue;
    if (!config.allowRecurrent && createsCycle(genome, from, to)) continue;

    const gene: ConnectionGene = {
      innovation: registry.connection(from, to),
      from,
      to,
      weight: rng.spread(config.weightResetRange),
      enabled: true,
    };
    addConnection(genome, gene);
    return gene;
  }
  return null;
}

/**
 * Split an existing connection with a new node.
 *
 * The classic NEAT form: disable the original, then wire from→new at weight 1
 * and new→to at the original weight. That keeps the network's behaviour almost
 * unchanged at the moment of the mutation, so a structural addition is not
 * immediately punished by a fitness collapse before evolution can tune it.
 */
export function mutateAddNode(
  genome: Genome,
  config: NeatConfig,
  rng: NeatRng,
  registry: InnovationRegistry,
): number | null {
  const candidates = genome.connections.filter((c) => c.enabled);
  if (candidates.length === 0) return null;
  const split = rng.pick(candidates);
  split.enabled = false;

  const nodeId = registry.splitNode(split.innovation);
  if (!genome.nodes.some((n) => n.id === nodeId)) {
    addNode(genome, { id: nodeId, type: "hidden", activation: config.activation });
  }

  if (!hasConnection(genome, split.from, nodeId)) {
    addConnection(genome, {
      innovation: registry.connection(split.from, nodeId),
      from: split.from,
      to: nodeId,
      weight: 1,
      enabled: true,
    });
  }
  if (!hasConnection(genome, nodeId, split.to)) {
    addConnection(genome, {
      innovation: registry.connection(nodeId, split.to),
      from: nodeId,
      to: split.to,
      weight: split.weight,
      enabled: true,
    });
  }
  return nodeId;
}

/** Flip one gene's enabled flag. */
export function mutateToggleEnable(genome: Genome, rng: NeatRng): void {
  if (genome.connections.length === 0) return;
  const gene = rng.pick(genome.connections);
  // Re-enabling can create a cycle in a feed-forward genome, so only the
  // disable direction is unconditional; `mutateReenable` handles the other.
  if (gene.enabled) gene.enabled = false;
}

/** Switch a disabled gene back on, if it stays legal. */
export function mutateReenable(genome: Genome, config: NeatConfig, rng: NeatRng): void {
  const disabled = genome.connections.filter((c) => !c.enabled);
  if (disabled.length === 0) return;
  const gene = rng.pick(disabled);
  if (!config.allowRecurrent && createsCycle(genome, gene.from, gene.to)) return;
  gene.enabled = true;
}

/** Applies the whole mutation set to a copy of `genome`. */
export function mutate(
  genome: Genome,
  config: NeatConfig,
  rng: NeatRng,
  registry: InnovationRegistry,
  id = genome.id,
): Genome {
  const child = cloneGenome(genome, id);
  if (rng.chance(config.weightMutationRate)) mutateWeights(child, config, rng);
  if (rng.chance(config.addConnectionRate)) mutateAddConnection(child, config, rng, registry);
  if (rng.chance(config.addNodeRate)) mutateAddNode(child, config, rng, registry);
  if (rng.chance(config.toggleEnableRate)) mutateToggleEnable(child, rng);
  if (rng.chance(config.reenableRate)) mutateReenable(child, config, rng);
  return child;
}

/** Seeds a starting genome's connections per `config.initialConnectivity`. */
export function connectInitial(
  genome: Genome,
  shape: GenomeShape,
  config: NeatConfig,
  rng: NeatRng,
  registry: InnovationRegistry,
): void {
  const sources = genome.nodes
    .filter((n) => n.type === "input" || n.type === "bias")
    .map((n) => n.id);
  const outputs = genome.nodes.filter((n) => n.type === "output").map((n) => n.id);
  const density = config.initialConnectivity === "full" ? 1 : config.initialConnectivity;

  for (const to of outputs) {
    let wired = false;
    for (const from of sources) {
      if (density < 1 && !rng.chance(density)) continue;
      addConnection(genome, {
        innovation: registry.connection(from, to),
        from,
        to,
        weight: rng.spread(config.weightResetRange),
        enabled: true,
      });
      wired = true;
    }
    // Every output needs at least one input, or it is a constant the search can
    // never influence.
    if (!wired) {
      const from = rng.pick(sources);
      addConnection(genome, {
        innovation: registry.connection(from, to),
        from,
        to,
        weight: rng.spread(config.weightResetRange),
        enabled: true,
      });
    }
  }
  void shape;
}
