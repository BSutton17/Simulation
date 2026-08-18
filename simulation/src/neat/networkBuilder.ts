import { activate, type ActivationName } from "./gene.js";
import type { Genome } from "./genome.js";

/**
 * Genome → runnable network.
 *
 * NEAT owns topology; this compiles a topology into something that can be
 * activated. The result is structurally identical to `ai/network.ts`'s
 * `Network` interface — same three members, same semantics — so a genome can
 * drive the game controller with no adapter. It is deliberately NOT imported
 * from there: `neat/` must stay free of Elementals, and `training/` asserts the
 * two types line up at compile time.
 *
 * ⚠️ Activation order is computed by a deterministic topological sort keyed on
 * node id, never on genome array order. Crossover rebuilds a genome's arrays in
 * a different sequence from mutation, so two semantically identical genomes can
 * carry their genes in different orders; ordering the evaluation by anything
 * but a canonical key would give them different outputs. With recurrent
 * connections it would give them different *behaviour*.
 */

/** The runtime contract, matching `ai/network.ts`'s `Network`. */
export interface ActivationNetwork {
  readonly inputSize: number;
  readonly outputSize: number;
  activate(inputs: Float32Array, outputs: Float32Array): void;
}

interface CompiledNode {
  id: number;
  activation: ActivationName;
  /** Incoming enabled connections, in canonical order. */
  incoming: { from: number; weight: number }[];
}

export class GenomeNetwork implements ActivationNetwork {
  readonly inputSize: number;
  readonly outputSize: number;
  /** Node ids in evaluation order (inputs and bias first). */
  private readonly order: CompiledNode[];
  private readonly inputIds: number[];
  private readonly outputIds: number[];
  private readonly biasId: number | null;
  /** Scratch, keyed by node id — reused across activations. */
  private readonly values = new Map<number, number>();
  /** Previous activation values, for recurrent edges. */
  private readonly previous = new Map<number, number>();
  readonly recurrent: boolean;

  constructor(genome: Genome) {
    this.inputIds = genome.nodes.filter((n) => n.type === "input").map((n) => n.id).sort((a, b) => a - b);
    this.outputIds = genome.nodes.filter((n) => n.type === "output").map((n) => n.id).sort((a, b) => a - b);
    this.biasId = genome.nodes.find((n) => n.type === "bias")?.id ?? null;
    this.inputSize = this.inputIds.length;
    this.outputSize = this.outputIds.length;

    const enabled = genome.connections.filter((c) => c.enabled);
    const byNode = new Map<number, { from: number; weight: number }[]>();
    for (const node of genome.nodes) byNode.set(node.id, []);
    for (const c of [...enabled].sort((a, b) => a.innovation - b.innovation)) {
      byNode.get(c.to)?.push({ from: c.from, weight: c.weight });
    }

    const { order, recurrent } = topologicalOrder(genome, enabled);
    this.recurrent = recurrent;
    this.order = order.map((id) => ({
      id,
      activation: genome.nodes.find((n) => n.id === id)!.activation,
      incoming: byNode.get(id) ?? [],
    }));

    for (const node of genome.nodes) {
      this.values.set(node.id, 0);
      this.previous.set(node.id, 0);
    }
  }

  activate(inputs: Float32Array, outputs: Float32Array): void {
    if (inputs.length !== this.inputSize) {
      throw new Error(`inputs must be ${this.inputSize}, got ${inputs.length}`);
    }
    if (outputs.length !== this.outputSize) {
      throw new Error(`outputs must be ${this.outputSize}, got ${outputs.length}`);
    }

    if (this.recurrent) {
      for (const [id, value] of this.values) this.previous.set(id, value);
    }

    for (let i = 0; i < this.inputIds.length; i++) {
      this.values.set(this.inputIds[i]!, inputs[i]!);
    }
    if (this.biasId !== null) this.values.set(this.biasId, 1);

    const seen = new Set<number>(this.inputIds);
    if (this.biasId !== null) seen.add(this.biasId);

    for (const node of this.order) {
      if (seen.has(node.id)) continue;
      let sum = 0;
      for (const edge of node.incoming) {
        // An edge from a node not yet evaluated this pass is recurrent: read
        // last activation's value, which is what makes memory possible.
        const source = seen.has(edge.from)
          ? this.values.get(edge.from)!
          : this.previous.get(edge.from) ?? 0;
        sum += source * edge.weight;
      }
      this.values.set(node.id, activate(node.activation, sum));
      seen.add(node.id);
    }

    for (let i = 0; i < this.outputIds.length; i++) {
      outputs[i] = this.values.get(this.outputIds[i]!)!;
    }
  }
}

/**
 * Evaluation order: Kahn's algorithm over enabled genes, breaking ties by node
 * id so the result is canonical. Nodes left over after the sort sit on a cycle;
 * they are appended in id order and their back-edges read the previous
 * activation.
 */
function topologicalOrder(
  genome: Genome,
  enabled: { from: number; to: number }[],
): { order: number[]; recurrent: boolean } {
  const ids = genome.nodes.map((n) => n.id).sort((a, b) => a - b);
  const indegree = new Map<number, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const c of enabled) {
    if (!indegree.has(c.to) || !outgoing.has(c.from)) continue;
    indegree.set(c.to, indegree.get(c.to)! + 1);
    outgoing.get(c.from)!.push(c.to);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of (outgoing.get(id) ?? []).slice().sort((a, b) => a - b)) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        // Keep `ready` sorted so the traversal is canonical.
        const at = ready.findIndex((x) => x > next);
        if (at < 0) ready.push(next);
        else ready.splice(at, 0, next);
      }
    }
  }

  const recurrent = order.length < ids.length;
  if (recurrent) {
    const placed = new Set(order);
    for (const id of ids) if (!placed.has(id)) order.push(id);
  }
  return { order, recurrent };
}

export function buildNetwork(genome: Genome): GenomeNetwork {
  return new GenomeNetwork(genome);
}
