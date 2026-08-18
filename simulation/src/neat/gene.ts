/**
 * The two gene types, and the activation functions a node may carry.
 *
 * Plain data, no classes: a genome is written to a checkpoint and read back
 * thousands of times over a training run, and structures that serialize as
 * themselves remove a whole category of round-trip bug.
 */

export type NodeType = "input" | "bias" | "hidden" | "output";

export type ActivationName = "sigmoid" | "tanh" | "relu" | "identity";

export interface NodeGene {
  /** Stable within a run; assigned by the innovation registry. */
  readonly id: number;
  readonly type: NodeType;
  readonly activation: ActivationName;
}

export interface ConnectionGene {
  /** Historical marking. Two connections with the same innovation are the
   *  "same" gene for crossover and distance, however far the genomes drifted. */
  readonly innovation: number;
  readonly from: number;
  readonly to: number;
  weight: number;
  enabled: boolean;
}

/**
 * The steepened sigmoid from the original NEAT work (Stanley & Miikkulainen).
 *
 * The 4.9 coefficient is not decoration: a plain logistic is so flat near zero
 * that a minimal network's outputs barely separate, and XOR takes far longer to
 * escape. It is the standard because it works.
 */
export function activate(name: ActivationName, x: number): number {
  switch (name) {
    case "sigmoid":
      return 1 / (1 + Math.exp(-4.9 * x));
    case "tanh":
      return Math.tanh(x);
    case "relu":
      return x > 0 ? x : 0;
    case "identity":
      return x;
  }
}
