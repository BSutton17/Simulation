/**
 * Historical markings.
 *
 * The mechanism that makes NEAT NEAT rather than a genetic algorithm over
 * graphs: two genomes that independently grew the same structure must be able
 * to recognise it as the same structure, so crossover aligns homologous genes
 * instead of guessing by array position.
 *
 * Two registries in one, because NEAT needs two kinds of identity:
 *
 *   - a CONNECTION between two nodes always gets the same innovation number,
 *     whoever grows it and whenever;
 *   - SPLITTING a given connection always produces the same new node id and the
 *     same pair of replacement connections.
 *
 * Both are memoised for the whole run rather than reset each generation. The
 * per-generation reset in some implementations exists to stop the counter
 * growing; the cost is that the same structure appearing two generations apart
 * gets two identities and stops aligning. For runs of this size the counter is
 * not a problem and alignment is worth more.
 *
 * Nothing here draws a random number. Innovation identity is a pure function of
 * what was mutated and what came before, which is what lets a seeded run
 * reproduce exactly.
 */

export interface InnovationState {
  nextInnovation: number;
  nextNodeId: number;
  /** "from:to" → innovation number. */
  connections: [string, number][];
  /** split connection innovation → the node id it produced. */
  splits: [number, number][];
}

export class InnovationRegistry {
  private nextInnovation: number;
  private nextNodeId: number;
  private readonly connections = new Map<string, number>();
  private readonly splits = new Map<number, number>();

  constructor(firstNodeId: number, firstInnovation = 0) {
    this.nextNodeId = firstNodeId;
    this.nextInnovation = firstInnovation;
  }

  /** The innovation number for a connection, minted once and reused forever. */
  connection(from: number, to: number): number {
    const key = `${from}:${to}`;
    const existing = this.connections.get(key);
    if (existing !== undefined) return existing;
    const innovation = this.nextInnovation++;
    this.connections.set(key, innovation);
    return innovation;
  }

  /**
   * Splitting `innovation` yields this node id.
   *
   * Keyed by the connection being split rather than by (from, to), because two
   * genomes splitting the same connection have produced the same structural
   * change and their children must be able to line it up.
   */
  splitNode(innovation: number): number {
    const existing = this.splits.get(innovation);
    if (existing !== undefined) return existing;
    const id = this.nextNodeId++;
    this.splits.set(innovation, id);
    return id;
  }

  get counters(): { innovation: number; node: number } {
    return { innovation: this.nextInnovation, node: this.nextNodeId };
  }

  toJSON(): InnovationState {
    return {
      nextInnovation: this.nextInnovation,
      nextNodeId: this.nextNodeId,
      // Sorted, so a checkpoint is byte-stable for the same run state.
      connections: [...this.connections.entries()].sort((a, b) => a[1] - b[1]),
      splits: [...this.splits.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  static fromJSON(state: InnovationState): InnovationRegistry {
    const registry = new InnovationRegistry(state.nextNodeId, state.nextInnovation);
    for (const [key, value] of state.connections) registry.connections.set(key, value);
    for (const [key, value] of state.splits) registry.splits.set(key, value);
    return registry;
  }
}
