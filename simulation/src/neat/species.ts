import type { NeatConfig } from "./config.js";
import { compatibilityDistance } from "./distance.js";
import { cloneGenome, type Genome } from "./genome.js";

/**
 * Speciation and fitness sharing.
 *
 * The protection mechanism. A structural mutation is almost always worse before
 * it is better — a fresh hidden node arrives untuned — so in a single global
 * population it is out-competed and gone before it can be optimized. Grouping
 * by compatibility and making genomes compete mainly within their own group is
 * what buys innovation the time to become good.
 */

export interface Species {
  id: number;
  /** Compared against to decide membership. Frozen for the generation. */
  representative: Genome;
  members: Genome[];
  bestFitness: number;
  /** Generations since `bestFitness` last improved. */
  stagnation: number;
  age: number;
  /** Genomes this species is entitled to produce next generation. */
  offspring: number;
}

export interface SpeciesState {
  id: number;
  representative: Genome;
  bestFitness: number;
  stagnation: number;
  age: number;
}

/**
 * Assigns every genome to a species.
 *
 * Representatives come from the PREVIOUS generation and are held fixed for the
 * duration of the assignment, so membership does not depend on the order
 * genomes happen to be visited. A representative that drifts as members join is
 * the classic source of speciation that is stable in one run and not in the
 * next.
 */
export function speciate(
  population: Genome[],
  previous: SpeciesState[],
  config: NeatConfig,
  nextSpeciesId: () => number,
): Species[] {
  const species: Species[] = previous.map((s) => ({
    id: s.id,
    representative: s.representative,
    members: [],
    bestFitness: s.bestFitness,
    stagnation: s.stagnation,
    age: s.age + 1,
    offspring: 0,
  }));

  for (const genome of population) {
    let home: Species | undefined;
    for (const candidate of species) {
      if (compatibilityDistance(genome, candidate.representative, config) < config.compatibilityThreshold) {
        home = candidate;
        break;
      }
    }
    if (home === undefined) {
      home = {
        id: nextSpeciesId(),
        // A copy: the founder keeps evolving, and a representative that moves
        // underneath the species would change what membership means.
        representative: cloneGenome(genome),
        members: [],
        bestFitness: -Infinity,
        stagnation: 0,
        age: 0,
        offspring: 0,
      };
      species.push(home);
    }
    home.members.push(genome);
    genome.speciesId = home.id;
  }

  return species.filter((s) => s.members.length > 0);
}

/**
 * Fitness sharing: a genome's fitness is divided by its species size.
 *
 * So a species does not gain by being large — twenty copies of one idea are
 * worth about what one is. This is the pressure that keeps several lines of
 * play alive at once instead of letting the first thing that works take the
 * whole population.
 */
export function shareFitness(species: Species[]): void {
  for (const s of species) {
    const size = s.members.length;
    for (const member of s.members) {
      member.adjustedFitness = member.fitness / size;
    }
  }
}

/** Updates best-fitness and stagnation counters after evaluation. */
export function updateStagnation(species: Species[]): void {
  for (const s of species) {
    const best = Math.max(...s.members.map((m) => m.fitness));
    if (best > s.bestFitness) {
      s.bestFitness = best;
      s.stagnation = 0;
    } else {
      s.stagnation += 1;
    }
  }
}

/**
 * Drops species that have not improved in `stagnationLimit` generations.
 *
 * Never below `minSpecies`, and never the current best — a run whose whole
 * population stagnates at once must not delete itself. The best species are
 * kept, ranked by their own best fitness.
 */
export function cullStagnant(species: Species[], config: NeatConfig): Species[] {
  if (species.length <= config.minSpecies) return species;
  const ranked = [...species].sort((a, b) => b.bestFitness - a.bestFitness);
  const protectedIds = new Set(ranked.slice(0, config.minSpecies).map((s) => s.id));
  return species.filter((s) => protectedIds.has(s.id) || s.stagnation < config.stagnationLimit);
}

/**
 * Divides the next generation between species, proportional to summed adjusted
 * fitness.
 *
 * Exactly `populationSize` slots are allocated. Proportional division leaves a
 * remainder, and handing it out by largest fractional part (rather than to
 * whoever is first) keeps the split deterministic and unbiased.
 */
export function allocateOffspring(species: Species[], config: NeatConfig): void {
  const totals = species.map((s) => s.members.reduce((sum, m) => sum + m.adjustedFitness, 0));
  const grand = totals.reduce((a, b) => a + b, 0);

  if (grand <= 0) {
    // Every genome scored zero — spread evenly rather than giving everything to
    // whichever species happens to sort first.
    const base = Math.floor(config.populationSize / species.length);
    species.forEach((s) => (s.offspring = base));
    let remainder = config.populationSize - base * species.length;
    for (let i = 0; remainder > 0; i = (i + 1) % species.length, remainder--) {
      species[i]!.offspring += 1;
    }
    return;
  }

  const exact = totals.map((t) => (t / grand) * config.populationSize);
  species.forEach((s, i) => (s.offspring = Math.floor(exact[i]!)));

  let assigned = species.reduce((sum, s) => sum + s.offspring, 0);
  const byFraction = species
    .map((s, i) => ({ s, fraction: exact[i]! - Math.floor(exact[i]!), index: i }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; assigned < config.populationSize; i = (i + 1) % byFraction.length, assigned++) {
    byFraction[i]!.s.offspring += 1;
  }
  // Rounding can overshoot when many species round up; trim from the smallest
  // allocations so the population size is exact.
  const byAllocation = [...species].sort((a, b) => a.offspring - b.offspring);
  for (let i = 0; assigned > config.populationSize; i = (i + 1) % byAllocation.length) {
    const target = byAllocation[i]!;
    if (target.offspring <= 0) continue;
    target.offspring -= 1;
    assigned -= 1;
  }
}

/** The state carried into the next generation. */
export function toState(species: Species[]): SpeciesState[] {
  return species.map((s) => ({
    id: s.id,
    // Next generation's yardstick: this generation's best member.
    representative: cloneGenome(
      [...s.members].sort((a, b) => b.fitness - a.fitness)[0] ?? s.representative,
    ),
    bestFitness: s.bestFitness,
    stagnation: s.stagnation,
    age: s.age,
  }));
}
