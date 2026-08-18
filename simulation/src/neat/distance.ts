import type { NeatConfig } from "./config.js";
import type { Genome } from "./genome.js";

/**
 * Compatibility distance.
 *
 *     δ = c1·E/N + c2·D/N + c3·W̄
 *
 * E excess genes, D disjoint genes, W̄ the mean absolute weight difference over
 * matching genes, N the larger genome's gene count.
 *
 * Excess and disjoint are counted separately even though both mean "present in
 * one parent only": excess genes sit beyond the other genome's highest
 * innovation and therefore mark a lineage that has been evolving separately,
 * while disjoint genes are interleaved and mark local divergence. Weighting
 * them apart is what lets speciation notice the difference.
 */

export interface DistanceBreakdown {
  distance: number;
  excess: number;
  disjoint: number;
  matching: number;
  meanWeightDifference: number;
  normalizer: number;
}

export function compatibility(a: Genome, b: Genome, config: NeatConfig): DistanceBreakdown {
  const aGenes = a.connections;
  const bGenes = b.connections;

  if (aGenes.length === 0 && bGenes.length === 0) {
    return { distance: 0, excess: 0, disjoint: 0, matching: 0, meanWeightDifference: 0, normalizer: 1 };
  }

  const aMax = aGenes.length ? aGenes[aGenes.length - 1]!.innovation : -1;
  const bMax = bGenes.length ? bGenes[bGenes.length - 1]!.innovation : -1;
  const limit = Math.min(aMax, bMax);

  const bByInnovation = new Map(bGenes.map((g) => [g.innovation, g]));

  let matching = 0;
  let disjoint = 0;
  let excess = 0;
  let weightDifference = 0;

  for (const gene of aGenes) {
    const other = bByInnovation.get(gene.innovation);
    if (other !== undefined) {
      matching += 1;
      weightDifference += Math.abs(gene.weight - other.weight);
    } else if (gene.innovation > limit) excess += 1;
    else disjoint += 1;
  }
  const aByInnovation = new Set(aGenes.map((g) => g.innovation));
  for (const gene of bGenes) {
    if (aByInnovation.has(gene.innovation)) continue;
    if (gene.innovation > limit) excess += 1;
    else disjoint += 1;
  }

  // Standard NEAT: small genomes are not normalized by size, because dividing a
  // two-gene difference by a gene count of three flattens every small genome
  // into every other and speciation stops separating anything.
  const size = Math.max(aGenes.length, bGenes.length);
  const normalizer = size < config.smallGenomeSize ? 1 : size;
  const meanWeightDifference = matching > 0 ? weightDifference / matching : 0;

  const distance =
    (config.excessCoefficient * excess) / normalizer +
    (config.disjointCoefficient * disjoint) / normalizer +
    config.weightCoefficient * meanWeightDifference;

  return { distance, excess, disjoint, matching, meanWeightDifference, normalizer };
}

export function compatibilityDistance(a: Genome, b: Genome, config: NeatConfig): number {
  return compatibility(a, b, config).distance;
}
