import { withConfig, type NeatConfig } from "./config.js";
import type { Genome } from "./genome.js";
import { buildNetwork } from "./networkBuilder.js";
import { Population, type GenerationReport } from "./population.js";

/**
 * The XOR benchmark.
 *
 * The standard NEAT validation, and it is here for a specific reason: XOR is
 * not linearly separable, so it CANNOT be solved without a hidden node. A run
 * that solves it has demonstrably discovered topology rather than tuned weights
 * on the structure it was handed — which is the one property distinguishing
 * this implementation from a genetic algorithm over a fixed network.
 *
 * It also costs seconds. Every alternative way of finding out that crossover
 * misaligns innovations or that compatibility distance is inverted involves an
 * eight-hour training run and a confusing graph.
 */

const CASES: readonly { inputs: [number, number]; expected: number }[] = [
  { inputs: [0, 0], expected: 0 },
  { inputs: [0, 1], expected: 1 },
  { inputs: [1, 0], expected: 1 },
  { inputs: [1, 1], expected: 0 },
];

export interface XorEvaluation {
  fitness: number;
  outputs: number[];
  /** Every case on the correct side of 0.5. */
  solved: boolean;
}

/**
 * Scores one genome.
 *
 * Fitness is `(4 − Σ|error|)²` — the classic formulation. Squaring matters: it
 * makes the last fraction of error worth far more than the first, so selection
 * keeps pushing once a genome is roughly right instead of plateauing at "three
 * out of four".
 */
export function evaluateXor(genome: Genome): XorEvaluation {
  const network = buildNetwork(genome);
  const inputs = new Float32Array(2);
  const outputs = new Float32Array(1);
  let error = 0;
  const seen: number[] = [];
  let solved = true;

  for (const testCase of CASES) {
    inputs[0] = testCase.inputs[0];
    inputs[1] = testCase.inputs[1];
    network.activate(inputs, outputs);
    const value = outputs[0]!;
    seen.push(value);
    error += Math.abs(testCase.expected - value);
    if (testCase.expected === 1 ? value <= 0.5 : value > 0.5) solved = false;
  }

  const margin = Math.max(0, 4 - error);
  return { fitness: margin * margin, outputs: seen, solved };
}

export const XOR_CONFIG: NeatConfig = withConfig({
  populationSize: 150,
  activation: "sigmoid",
  initialConnectivity: "full",
  compatibilityThreshold: 3,
  targetSpecies: 8,
  addNodeRate: 0.05,
  addConnectionRate: 0.12,
  survivalThreshold: 0.3,
  stagnationLimit: 20,
});

export interface XorResult {
  solved: boolean;
  generations: number;
  bestFitness: number;
  bestGenome: Genome;
  outputs: number[];
  hiddenNodes: number;
  history: GenerationReport[];
}

/**
 * Evolves until XOR is solved or `maxGenerations` runs out.
 *
 * Success is "every case on the correct side of 0.5", not a fitness threshold:
 * a fitness number can be gamed by a lucky near-miss on one case, while the
 * classification is the thing actually being asked for.
 */
export function runXor(
  seed: number,
  maxGenerations = 150,
  config: NeatConfig = XOR_CONFIG,
): XorResult {
  const population = new Population({ inputs: 2, outputs: 1, activation: config.activation }, config, seed);
  const history: GenerationReport[] = [];
  let champion: Genome | null = null;
  let championEval = { fitness: -Infinity, outputs: [] as number[], solved: false };

  for (let generation = 0; generation < maxGenerations; generation++) {
    const genomes = population.ask();
    const results = genomes.map((genome) => evaluateXor(genome));
    results.forEach((result, i) => {
      if (result.fitness > championEval.fitness) {
        championEval = result;
        champion = genomes[i]!;
      }
    });
    // The genome to REPORT is the best one that actually solved, which is not
    // always the highest-fitness genome: fitness rewards small total error, so a
    // genome that is very close on all four cases can outscore one that is
    // correctly classified on all four. Reporting by fitness alone produced a
    // "solved" result whose own outputs failed a case.
    const solvedIndices = results.flatMap((r, i) => (r.solved ? [i] : []));
    const pick =
      solvedIndices.length > 0
        ? solvedIndices.reduce((best, i) => (results[i]!.fitness > results[best]!.fitness ? i : best))
        : results.reduce((best, r, i) => (r.fitness > results[best]!.fitness ? i : best), 0);
    const picked = genomes[pick]!;
    // Snapshot before `tell` replaces the population.
    const snapshot = {
      ...picked,
      nodes: [...picked.nodes],
      connections: picked.connections.map((c) => ({ ...c })),
    };

    history.push(population.tell(results.map((r) => r.fitness)));

    if (solvedIndices.length > 0) {
      return {
        solved: true,
        generations: generation + 1,
        bestFitness: results[pick]!.fitness,
        bestGenome: snapshot,
        outputs: results[pick]!.outputs,
        hiddenNodes: snapshot.nodes.filter((n) => n.type === "hidden").length,
        history,
      };
    }
  }

  const fallback = champion!;
  return {
    solved: false,
    generations: maxGenerations,
    bestFitness: championEval.fitness,
    bestGenome: fallback,
    outputs: championEval.outputs,
    hiddenNodes: fallback.nodes.filter((n) => n.type === "hidden").length,
    history,
  };
}
