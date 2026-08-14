import { PERSONALITIES } from "../personalities.js";
import { personalityAI } from "../personality.js";
import type { PersonalityProfile } from "../personality.js";
import type { AIFactory } from "../types.js";

/**
 * The strategy population a balance reading is taken over.
 *
 * Step 3 established the rule this module exists to enforce: a single AI
 * personality is not a balance evaluator. A deterministic policy replays the
 * same match every seed, so its win rate is a boolean that flips wholesale when
 * the profile changes. Aggregated over a population of strategies the same
 * measurement is stable to within ~5 percentage points across disjoint seed
 * pools, which is what makes it usable as a fitness input.
 *
 * The population is versioned because a balance result is only comparable to
 * another taken over the same strategies — changing the roster changes the
 * measuring instrument.
 */

export interface StrategyPopulation {
  /** Bump whenever the roster changes; results across versions are not
   *  comparable. */
  version: string;
  /** Stable, ordered profile ids. Order is part of the identity: seeds are
   *  derived from pairing indices. */
  profiles: readonly StrategyProfile[];
}

export interface StrategyProfile {
  id: string;
  profile: PersonalityProfile;
}

/** One ordered pairing of strategies within a match. */
export interface ProfilePairing {
  /** Profile driving seat 0. */
  a: string;
  /** Profile driving seat 1 (and, in FFA, cycled across remaining seats). */
  b: string;
  /** Stable key, e.g. "aggressive/defensive". */
  key: string;
  /** True when both seats use the same profile — a mirror pairing. */
  mirror: boolean;
}

/**
 * The current population: the six shipped personalities.
 *
 * Not assumed final — adding a profile is adding an entry here and bumping the
 * version. Nothing downstream enumerates personalities by name.
 */
export const POPULATION_V1: StrategyPopulation = {
  version: "v1",
  profiles: Object.entries(PERSONALITIES)
    .map(([id, profile]) => ({ id, profile: profile as PersonalityProfile }))
    .sort((x, y) => x.id.localeCompare(y.id)),
};

/**
 * Every ORDERED pairing, mirrors included — n² for n profiles.
 *
 * Ordered rather than combinations because A-vs-B is not B-vs-A: the two
 * controllers make different decisions, and seat order additionally drives
 * intent resolution order and each seat's RNG stream. Mirrors are kept because
 * they are the cleanest diagnostic for controller-induced asymmetry.
 */
export function orderedPairings(
  population: StrategyPopulation,
): ProfilePairing[] {
  const out: ProfilePairing[] = [];
  for (const a of population.profiles) {
    for (const b of population.profiles) {
      out.push({ a: a.id, b: b.id, key: `${a.id}/${b.id}`, mirror: a.id === b.id });
    }
  }
  return out;
}

/** Controller factory for a profile id in this population. */
export function factoryFor(
  population: StrategyPopulation,
  id: string,
): AIFactory {
  const found = population.profiles.find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `unknown strategy "${id}" in population ${population.version}`,
    );
  }
  return personalityAI(found.profile);
}

/**
 * Assigns profiles to `seats` seats for one pairing.
 *
 * In a duel this is simply [a, b]. In a free-for-all the pairing's two
 * strategies alternate across the remaining seats, so every sampled
 * composition is played by a mix rather than by one strategy — a field of six
 * identical controllers measures the controller, not the kingdoms.
 */
export function seatProfiles(pairing: ProfilePairing, seats: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < seats; i++) out.push(i % 2 === 0 ? pairing.a : pairing.b);
  return out;
}
