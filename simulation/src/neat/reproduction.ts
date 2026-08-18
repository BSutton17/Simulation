import type { NeatConfig } from "./config.js";
import { clone, crossover } from "./crossover.js";
import { cloneGenome, type Genome } from "./genome.js";
import type { InnovationRegistry } from "./innovation.js";
import { mutate } from "./mutation.js";
import type { NeatRng } from "./rng.js";
import type { Species } from "./species.js";

/**
 * Building the next generation.
 *
 * Per species: keep the elite unchanged, cut to the surviving fraction, then
 * fill the species' allocation with children of the survivors. The population
 * size is an invariant, not an aspiration — every generation produces exactly
 * `populationSize` genomes, and a test holds that.
 */

/** Tournament selection: sample k, take the fittest. */
function selectParent(pool: Genome[], config: NeatConfig, rng: NeatRng): Genome {
  const k = Math.max(1, Math.min(config.tournamentSize, pool.length));
  let best = rng.pick(pool);
  for (let i = 1; i < k; i++) {
    const challenger = rng.pick(pool);
    if (challenger.fitness > best.fitness) best = challenger;
  }
  return best;
}

export function reproduce(
  species: Species[],
  config: NeatConfig,
  rng: NeatRng,
  registry: InnovationRegistry,
  nextGenomeId: () => string,
): Genome[] {
  const next: Genome[] = [];

  for (const s of species) {
    if (s.offspring <= 0) continue;
    const ranked = [...s.members].sort(
      (a, b) => b.fitness - a.fitness || a.id.localeCompare(b.id),
    );

    let produced = 0;
    // Elitism: the species' best carries over untouched, so a generation can
    // never be worse than the one before it by accident.
    if (s.members.length >= config.elitismMinSize) {
      const elites = Math.min(config.elitism, s.offspring);
      for (let i = 0; i < elites; i++) {
        const elite = cloneGenome(ranked[i] ?? ranked[0]!, nextGenomeId());
        elite.speciesId = s.id;
        next.push(elite);
        produced += 1;
      }
    }

    const survivors = ranked.slice(
      0,
      Math.max(1, Math.floor(ranked.length * config.survivalThreshold)),
    );

    while (produced < s.offspring) {
      let child: Genome;
      if (survivors.length > 1 && rng.chance(config.crossoverRate)) {
        const a = selectParent(survivors, config, rng);
        const b = selectParent(survivors, config, rng);
        child = crossover(a, b, config, rng, nextGenomeId()).child;
      } else {
        child = clone(selectParent(survivors, config, rng), nextGenomeId());
      }
      child = mutate(child, config, rng, registry, child.id);
      child.fitness = 0;
      child.adjustedFitness = 0;
      child.speciesId = null;
      next.push(child);
      produced += 1;
    }
  }

  return next;
}
