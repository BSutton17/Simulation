/**
 * Balance parameter registry (ticket #202).
 *
 * Every tunable gameplay value is exposed through one interface: systems call
 * `param(id, base)` instead of reading constants directly. With no active
 * parameter set (the live game), `param` returns `base` unchanged — production
 * behavior is bit-for-bit identical and the overhead is one null check. The
 * simulation activates candidate sets to run matches under alternate balance
 * without ever modifying production data.
 *
 * Parameter ids are dot-paths, stable across releases:
 *   economy.incomePerCitizen        castle.repairCost        shield.cost
 *   combat.baseCritChance           citizens.startingCount
 *   ability.<id>.cost               ability.<id>.cooldownTicks
 *   ability.<id>.unlockCost         ability.<id>.charge.<field>
 *   ability.<id>.charge.damage.<i>  ability.<id>.effects.<i>.<key>
 *   ability.<id>.effects.<i>.chance ability.<id>.upgrade.<level>.cost
 *   passive.<kingdom>.<i>.<field>
 *
 * The full catalog (id + base value for every parameter) is enumerated by
 * `listParameters()` in parameterCatalog.ts, so optimizers can discover the
 * search space without knowing any kingdom or ability by name.
 */

/** A candidate balance configuration: overrides keyed by parameter id. */
export type ParameterSet = Readonly<Record<string, number>>;

let active: ParameterSet | null = null;

/**
 * Activates a parameter set (or clears it with null). Simulation-only in
 * practice; the live server never calls this, so production always reads
 * base values.
 */
export function setActiveParameterSet(set: ParameterSet | null): void {
  active = set;
}

export function getActiveParameterSet(): ParameterSet | null {
  return active;
}

/**
 * The single read gate for tunable values: returns the active override for
 * `id`, or `base` when there is no active set / no override for this id.
 */
export function param(id: string, base: number): number {
  if (active === null) return base;
  const v = active[id];
  return v === undefined ? base : v;
}

/**
 * Runs `fn` under a parameter set, restoring the previous set afterwards
 * (exception-safe). The scoped form keeps tests and simulations from leaking
 * overrides into each other.
 */
export function withParameterSet<T>(set: ParameterSet | null, fn: () => T): T {
  const previous = active;
  active = set;
  try {
    return fn();
  } finally {
    active = previous;
  }
}
