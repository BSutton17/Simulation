import { compatibilityDistance, type Genome, type NeatConfig } from "../neat/index.js";

/**
 * Cheap per-generation measurements of whether the POPULATION is changing.
 *
 * Fitness moving is not evidence that evolution is working — under self-play the
 * opponents move too, so a rising mean can mean the field got worse. These
 * measure the genomes themselves, cost no matches, and answer the two questions
 * a training log otherwise cannot: are the genomes still different from each
 * other, and is generation N's best actually a different animal from generation
 * 0's.
 */

/**
 * Mean pairwise compatibility distance across the population.
 *
 * The same distance speciation uses, so a diversity of zero and a species count
 * of one are the same fact reported twice — which is exactly the corroboration
 * wanted when diagnosing a converged run.
 *
 * Sampled rather than exhaustive: the pass is O(n^2) and this runs every
 * generation, so a fixed stride keeps it flat in population size.
 */
export function geneticDiversity(
  genomes: readonly Genome[],
  config: NeatConfig,
  sample = 16,
): number {
  const stride = Math.max(1, Math.floor(genomes.length / sample));
  const picked: Genome[] = [];
  for (let i = 0; i < genomes.length && picked.length < sample; i += stride) {
    picked.push(genomes[i]!);
  }
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      sum += compatibilityDistance(picked[i]!, picked[j]!, config);
      pairs += 1;
    }
  }
  return pairs > 0 ? sum / pairs : 0;
}

/**
 * A content hash of a genome's expressed phenotype.
 *
 * Covers the enabled connections' innovation numbers and weights and the node
 * set — everything that changes what the network COMPUTES. Two genomes with the
 * same fingerprint play identically, whatever their ids say, which is what makes
 * this a usable answer to "did generation 5's best actually differ from
 * generation 0's" rather than a restatement of the id counter.
 */
export function genomeFingerprint(genome: Genome): string {
  let h = 0x811c9dc5;
  const mix = (value: number): void => {
    h ^= value >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(genome.nodes.length);
  for (const node of genome.nodes) mix(node.id);
  for (const gene of genome.connections) {
    if (!gene.enabled) continue;
    mix(gene.innovation);
    // Weights quantized to six decimals: a fingerprint should survive float
    // round-tripping through a checkpoint, and 1e-6 is far below any weight
    // change a mutation makes.
    mix(Math.round(gene.weight * 1e6));
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Enabled connections — the ones the network actually evaluates. */
export function expressedConnections(genome: Genome): number {
  return genome.connections.filter((gene) => gene.enabled).length;
}
