import { configHash, type NeatConfig } from "./config.js";
import { createGenome, type Genome, type GenomeShape, firstHiddenId } from "./genome.js";
import { InnovationRegistry } from "./innovation.js";
import { connectInitial, initialTopology, mutate } from "./mutation.js";
import { NeatRng } from "./rng.js";
import {
  allocateOffspring,
  cullStagnant,
  shareFitness,
  speciate,
  toState,
  updateStagnation,
  type Species,
  type SpeciesState,
} from "./species.js";
import { reproduce } from "./reproduction.js";

/**
 * The evolution loop, as an ask/tell object.
 *
 * `ask()` hands out the genomes to evaluate; `tell()` takes their fitnesses and
 * advances a generation. Deliberately the same shape as the CMA-ES strategy in
 * `search/cmaes.ts`, so the existing distributed coordinator can drive either
 * without knowing which — the evaluation half of that infrastructure does not
 * care what produced a candidate.
 *
 * Knows nothing about Elementals. It never learns what a genome is FOR.
 */

export interface GenerationReport {
  generation: number;
  best: number;
  mean: number;
  worst: number;
  species: number;
  /** Mean genome size, for watching complexification. */
  meanNodes: number;
  meanConnections: number;
  compatibilityThreshold: number;
  bestGenomeId: string;
}

export class Population {
  readonly config: NeatConfig;
  readonly shape: GenomeShape;
  private readonly rng: NeatRng;
  private registry: InnovationRegistry;
  private genomes: Genome[] = [];
  private speciesState: SpeciesState[] = [];
  private lastSpecies: Species[] = [];
  private generationNumber = 0;
  private genomeCounter = 0;
  private speciesCounter = 0;
  /** Adjusted each generation when `compatibilityAdjust` is on. */
  private threshold: number;

  constructor(shape: GenomeShape, config: NeatConfig, seed: number) {
    this.shape = shape;
    this.config = config;
    this.rng = new NeatRng(seed);
    this.registry = new InnovationRegistry(firstHiddenId(shape));
    this.threshold = config.compatibilityThreshold;
    this.seedPopulation();
  }

  private nextGenomeId = (): string =>
    `g${this.generationNumber}-${(this.genomeCounter++).toString(36)}`;

  private nextSpeciesId = (): number => this.speciesCounter++;

  /**
   * The starting population: minimal genomes, no hidden nodes.
   *
   * Each is independently weight-mutated so generation 0 is a spread rather
   * than a hundred and fifty copies of one network — with identical genomes
   * there is nothing for selection to prefer and the first few generations are
   * wasted rediscovering variety.
   */
  private seedPopulation(): void {
    // One topology, drawn once, shared by the whole population. Only the weights
    // differ. Drawing it per genome makes generation 0 structurally noisy and
    // leaves speciation nothing real to read — see `initialTopology`.
    const edges = initialTopology(this.shape, this.config, this.rng, this.registry);
    for (let i = 0; i < this.config.populationSize; i++) {
      const genome = createGenome(this.nextGenomeId(), this.shape);
      connectInitial(genome, edges, this.config, this.rng);
      this.genomes.push(genome);
    }
  }

  /** The genomes awaiting evaluation this generation. */
  ask(): Genome[] {
    return this.genomes;
  }

  get generation(): number {
    return this.generationNumber;
  }

  get species(): readonly Species[] {
    return this.lastSpecies;
  }

  get innovation(): InnovationRegistry {
    return this.registry;
  }

  get rngState(): number {
    return this.rng.state;
  }

  /** The fittest genome of the last evaluated generation. */
  best(): Genome {
    return [...this.genomes].sort(
      (a, b) => b.fitness - a.fitness || a.id.localeCompare(b.id),
    )[0]!;
  }

  /**
   * Accepts fitnesses and produces the next generation.
   *
   * Fitnesses arrive positionally, matching `ask()`. That correspondence is the
   * one thing distribution can silently corrupt, so callers that evaluate
   * remotely must verify identity rather than trust arrival order — the same
   * discipline `distributed/protocol.ts` already enforces for CMA-ES.
   */
  tell(fitnesses: readonly number[]): GenerationReport {
    if (fitnesses.length !== this.genomes.length) {
      throw new Error(
        `expected ${this.genomes.length} fitnesses, got ${fitnesses.length}`,
      );
    }
    this.genomes.forEach((genome, i) => {
      const value = fitnesses[i]!;
      // A NaN would propagate silently through sharing and allocation and quietly
      // corrupt selection for the rest of the run.
      genome.fitness = Number.isFinite(value) ? value : 0;
    });

    const config = { ...this.config, compatibilityThreshold: this.threshold };
    let species = speciate(this.genomes, this.speciesState, config, this.nextSpeciesId);
    updateStagnation(species);
    species = cullStagnant(species, config);
    shareFitness(species);
    allocateOffspring(species, config);

    const report = this.report(species);

    this.speciesState = toState(species);
    this.lastSpecies = species;
    this.generationNumber += 1;
    this.genomeCounter = 0;

    let next = reproduce(species, config, this.rng, this.registry, this.nextGenomeId);
    // Allocation is exact, but a species can be culled between allocation and
    // reproduction; top up from mutated copies of the best rather than shipping
    // a short generation.
    const best = this.best();
    while (next.length < this.config.populationSize) {
      next.push(mutate(best, config, this.rng, this.registry, this.nextGenomeId()));
    }
    if (next.length > this.config.populationSize) next.length = this.config.populationSize;
    this.genomes = next;

    // Nudge the threshold toward the target species count. Fixed thresholds
    // either collapse to one species or explode to one species per genome as
    // genomes grow, and both make speciation pointless.
    if (config.compatibilityAdjust > 0) {
      if (species.length < config.targetSpecies) {
        this.threshold = Math.max(0.3, this.threshold - config.compatibilityAdjust);
      } else if (species.length > config.targetSpecies) {
        this.threshold += config.compatibilityAdjust;
      }
    }

    return report;
  }

  private report(species: Species[]): GenerationReport {
    const fitnesses = this.genomes.map((g) => g.fitness);
    const best = this.best();
    return {
      generation: this.generationNumber,
      best: Math.max(...fitnesses),
      mean: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      worst: Math.min(...fitnesses),
      species: species.length,
      meanNodes: this.genomes.reduce((a, g) => a + g.nodes.length, 0) / this.genomes.length,
      meanConnections:
        this.genomes.reduce((a, g) => a + g.connections.length, 0) / this.genomes.length,
      compatibilityThreshold: this.threshold,
      bestGenomeId: best.id,
    };
  }

  /** Everything needed to resume. See `checkpoint.ts`. */
  snapshot(): PopulationSnapshot {
    return {
      configHash: configHash(this.config),
      shape: this.shape,
      generation: this.generationNumber,
      rngState: this.rng.state,
      genomeCounter: this.genomeCounter,
      speciesCounter: this.speciesCounter,
      threshold: this.threshold,
      genomes: this.genomes,
      speciesState: this.speciesState,
      innovation: this.registry.toJSON(),
    };
  }

  static restore(snapshot: PopulationSnapshot, config: NeatConfig): Population {
    const population = new Population(snapshot.shape, config, 0);
    population.generationNumber = snapshot.generation;
    population.genomeCounter = snapshot.genomeCounter;
    population.speciesCounter = snapshot.speciesCounter;
    population.threshold = snapshot.threshold;
    population.genomes = snapshot.genomes;
    population.speciesState = snapshot.speciesState;
    population.registry = InnovationRegistry.fromJSON(snapshot.innovation);
    (population as unknown as { rng: NeatRng }).rng = NeatRng.fromState(snapshot.rngState);
    return population;
  }
}

export interface PopulationSnapshot {
  configHash: string;
  shape: GenomeShape;
  generation: number;
  rngState: number;
  genomeCounter: number;
  speciesCounter: number;
  threshold: number;
  genomes: Genome[];
  speciesState: SpeciesState[];
  innovation: ReturnType<InnovationRegistry["toJSON"]>;
}
