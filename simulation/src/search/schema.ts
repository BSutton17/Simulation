import { listParameters } from "../../../src/engine/parameterCatalog.js";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { KINGDOM_ABILITIES } from "../../../src/data/kingdomAbilities.js";
import type { ParameterSet } from "../../../src/engine/parameters.js";
import { hashSeed } from "../rng.js";

/**
 * The balance parameter schema — what the optimizer is allowed to change, and
 * how far.
 *
 * The engine exposes 672 tunables. Handing all of them to CMA-ES would be
 * counterproductive: search cost grows with dimensionality, most of those
 * parameters are upgrade-tier prices with negligible balance leverage, and a
 * 672-dimension diff is unreviewable. So the optimizer gets a curated,
 * explicitly bounded subset, and everything outside it is untouchable by
 * construction rather than by convention.
 *
 * Nothing about fitness lives here. The optimizer may change the GAME; it may
 * never change what counts as balanced.
 */

export const SCHEMA_VERSION = "v1";

export type ParameterType = "continuous" | "integer";

export interface SchemaParameter {
  id: string;
  type: ParameterType;
  base: number;
  min: number;
  max: number;
  /** Quantisation for integers; 0 for continuous. */
  step: number;
  locked: boolean;
  category: string;
  description: string;
}

export interface BalanceSchema {
  version: string;
  /** Fingerprint of the catalog this was generated against — if the engine's
   *  tunables change, a schema built against the old set is suspect. */
  catalogHash: string;
  parameters: SchemaParameter[];
}

/**
 * Curated parameters, with the reason each was chosen.
 *
 * The selection principle is one clean power dial per kingdom plus a few global
 * levers, rather than a grab-bag of whatever the catalog exposes:
 *
 *  - Every kingdom gets exactly one always-on passive scalar. Passives apply
 *    continuously and affect a kingdom's whole game, so they are the least
 *    surgical and most predictable way to move one kingdom's overall strength —
 *    which is precisely what the baseline's problems call for (Dark far too
 *    weak, Nature far too strong). One dial each also keeps the search space
 *    symmetric: no kingdom has more room to move than another.
 *
 *  - Four global levers (repair, shield, crit) shape how punishing the game is
 *    overall, which is the main structural lever on FFA placement spread.
 *
 *  - Ability-level damage and cost values are deliberately EXCLUDED from v1.
 *    There are 302 costs and 56 amounts; including them would multiply the
 *    dimensionality for changes that are harder to reason about and easy to add
 *    once the search is shown to work.
 */
const PASSIVE_DIALS: Omit<SchemaParameter, "base" | "min" | "max">[] = [
  // One always-on power scalar per kingdom.
  p("passive.water.1.pct", "kingdomPower", "Water resistance passive"),
  p("passive.fire.0.pct", "kingdomPower", "Fire's headline passive multiplier"),
  p("passive.air.1.pct", "kingdomPower", "Air attack-redirect chance"),
  p("passive.earth.1.pct", "kingdomPower", "Earth shield-on-damage share"),
  p("passive.electricity.0.pct", "kingdomPower", "Electricity cooldown reduction"),
  p("passive.ice.0.pct", "kingdomPower", "Ice status-duration modifier"),
  p("passive.nature.0.pct", "kingdomPower", "Nature thorns share"),
  p("passive.time.0.pct", "kingdomPower", "Time's periodic passive share"),
  p("passive.space.1.pct", "kingdomPower", "Space passive share"),
  p("passive.love.1.pct", "kingdomPower", "Love passive share"),
  p("passive.joker.0.pct", "kingdomPower", "Joker passive share"),
  p("passive.light.1.pct", "kingdomPower", "Light passive share"),
  p("passive.magma.1.pct", "kingdomPower", "Magma hot-ash share"),
  p("passive.insects.0.goldPct", "kingdomPower", "Insects gold drain share"),
  p("passive.kitsune.0.perDamage", "kingdomPower", "Kitsune memory gain per damage"),
  p("passive.dark.0.chance", "kingdomPower", "Dark passive proc chance"),

];

/**
 * Global levers on how punishing the game is.
 *
 * Part of the v1 search and kept only there. They are excluded from the
 * expanded scope by explicit instruction, and the v1 result gives a reason to
 * take that seriously: the optimizer drove shield cost to its floor and repair
 * amount to its ceiling simultaneously, which makes elimination rarer and
 * compresses FFA placement spread. Since 85% of the objective's weight is
 * placement-based, that may have been the score improving without the game
 * becoming fairer.
 */
const SYSTEM_DIALS: Omit<SchemaParameter, "base" | "min" | "max">[] = [
  p("castle.repairCost", "survivability", "Cost of a castle repair", "integer"),
  p("castle.repairAmount", "survivability", "HP restored per repair", "integer"),
  p("shield.cost", "survivability", "Cost of a shield", "integer"),
  p("combat.baseCritChance", "combat", "Baseline critical-hit chance"),
];

/** The v1 search space, unchanged, so that experiment stays reproducible. */
const CURATED = [...PASSIVE_DIALS, ...SYSTEM_DIALS];

/**
 * Parameters deliberately withheld from the optimizer.
 *
 * `economy.incomePerCitizen` is a standing design decision, not a tunable — it
 * is fixed at 0.06 and must never drift. Locking it in the schema is stronger
 * than remembering not to include it.
 */
const LOCKED: Omit<SchemaParameter, "base" | "min" | "max">[] = [
  p("economy.incomePerCitizen", "economy", "Fixed by design directive at 0.06", "continuous", true),
];

function p(
  id: string,
  category: string,
  description: string,
  type: ParameterType = "continuous",
  locked = false,
): Omit<SchemaParameter, "base" | "min" | "max"> {
  return { id, type, step: type === "integer" ? 1 : 0, locked, category, description };
}

/**
 * Parameters given more room than the default, with the evidence for each.
 *
 * Step 9 ended with 5 of 20 parameters pinned at +/-40%, which is the signature
 * of a search that wants to go further than it is allowed. Widening is applied
 * case by case rather than across the board: a bound is only loosened where the
 * direction of travel is explainable from the baseline diagnosis AND the wider
 * value still describes a sane game.
 */
const WIDENED: Record<string, { spread: number; reason: string }> = {
  // Nature is the strongest kingdom in the game at 73.9% in 1v1, and the search
  // drove its passive to the floor from two independent starting points.
  // Weakening it is exactly what the baseline calls for.
  "passive.nature.0.pct": { spread: 0.6, reason: "strongest kingdom (73.9% 1v1); pinned at MIN" },
  // Space posts the best 4-FFA placement in the game (2.16 against a fair 2.5)
  // and the search pinned it low for the same reason.
  "passive.space.1.pct": { spread: 0.6, reason: "best 4-FFA placement (2.16); pinned at MIN" },
  // Both survivability levers moved the same way — cheaper shields, larger
  // repairs — which plausibly compresses FFA placement spread by making early
  // eliminations rarer. A 240-gold shield and a 1400 HP repair against a 10,000
  // HP castle are still ordinary game states.
  "shield.cost": { spread: 0.6, reason: "pinned at MIN; consistent with the repair lever" },
  "castle.repairAmount": { spread: 0.6, reason: "pinned at MAX; consistent with the shield lever" },
  // passive.ice.0.pct is deliberately NOT widened. It also pinned at MIN, but it
  // is a negative status-duration modifier whose direction of benefit is not
  // obvious from the baseline, and Ice is mid-table rather than an outlier. No
  // evidence, no widening.
};

/** Default search room around a base value. */
const DEFAULT_SPREAD = 0.4;

/**
 * Bounds for one parameter.
 *
 * Ordered by value rather than by sign, so a negative base (Ice's −0.5
 * status-duration modifier) produces a sane interval instead of an inverted
 * one. Probability-like parameters are additionally clamped to [0, 1] — a 1.3
 * chance is not a balance change, it is a bug the engine would silently
 * swallow.
 */
export function boundsFor(id: string, base: number, spread = DEFAULT_SPREAD): { min: number; max: number } {
  const a = base * (1 - spread);
  const b = base * (1 + spread);
  let min = Math.min(a, b);
  let max = Math.max(a, b);
  // A zero base has no multiplicative room; give it a small absolute window.
  if (Math.abs(base) < 1e-9) {
    min = -0.05;
    max = 0.05;
  }
  if (/chance$/i.test(id) || /pct$/i.test(id) || /Pct$/.test(id)) {
    // Percentages in this engine are shares; keep them within [-1, 1] and never
    // let a "chance" go negative or above certainty.
    if (/chance$/i.test(id)) {
      min = Math.max(0, min);
      max = Math.min(1, max);
    } else {
      min = Math.max(-1, min);
      max = Math.min(1, max);
    }
  }
  return { min, max };
}

/** Builds the schema from the live catalog, so bases can never drift from the
 *  engine's actual values. */
/**
 * How much of the engine's tunable surface the optimizer may move.
 *
 * "curated" is the v1 search: 16 passive dials plus four global levers. It is
 * kept verbatim so the completed v1 experiment stays reproducible.
 *
 * "expanded" adds each kingdom's most-cast attack — its damage and its
 * cooldown. That is the largest expansion the compute budget actually supports,
 * and the reasoning is arithmetic rather than taste. CMA-ES needs roughly 10n
 * evaluations to make meaningful progress. At Kaggle's measured 5.41 match/s,
 * a generation costs `lambda * 1656 + 5760` matches, so eight seven-hour
 * sessions buy about 500 evaluations no matter what n is:
 *
 *     dims   evals/dim   verdict
 *       20        24.0   comfortable
 *       52         9.5   marginal, workable
 *      100         5.1   under-resourced
 *      600         0.9   would need 260-2600 generations, i.e. months
 *
 * Handing CMA-ES all 600 ability parameters would not be a bigger search; it
 * would be a search that never gets past its initial covariance estimate. The
 * ceiling is set by evaluations, and evaluations are set by simulation cost.
 */
export type SearchScope = "curated" | "expanded";

/** Version per scope, so a v1 checkpoint can never resume a v2 run: the schema
 *  version is part of the checkpoint identity and the candidate hash. */
const SCOPE_VERSION: Record<SearchScope, string> = { curated: "v1", expanded: "v2" };

/**
 * Abilities the AI never casts, measured from telemetry (68/80 coverage).
 *
 * Tuning an ability nobody uses is a dimension that cannot move the objective —
 * it spends evaluations to learn that its own axis is flat. Excluded until the
 * controller reaches them.
 */
const NEVER_CAST = new Set([
  "birdsEyeView", "neverEndingNightmare", "unlimitedRage", "yinAndYang",
  "blazingDetermination", "creepyCrawlers", "flashBang", "bffs", "empathy",
  "loveGalore", "orionsBeltAbility", "backToTheFuture",
]);

/**
 * Which numeric knobs each kind of ability contributes.
 *
 * Chosen by the designer, and the split reflects what each kind is for. An
 * attack is defined by how hard it hits and how often; a utility by how long
 * its effect lasts and what it costs to keep up; an ultimate by its price and
 * its rhythm, since its payload is usually the point of the kingdom and not a
 * dial to be shaved.
 *
 * Damage is the only continuous value here. Costs, cooldowns and durations are
 * integers in the engine and are searched as integers, so a candidate never
 * describes a game with a fractional tick.
 */
const ABILITY_DIALS: Record<string, { suffix: string; type: ParameterType; label: string }[]> = {
  attack: [
    { suffix: "effects.0.amount", type: "continuous", label: "damage" },
    { suffix: "cooldownTicks", type: "integer", label: "cooldown" },
    { suffix: "cost", type: "integer", label: "cost" },
  ],
  utility: [
    { suffix: "effects.0.durationTicks", type: "integer", label: "duration" },
    { suffix: "cost", type: "integer", label: "cost" },
    { suffix: "cooldownTicks", type: "integer", label: "cooldown" },
  ],
  ultimate: [
    { suffix: "cooldownTicks", type: "integer", label: "cooldown" },
    { suffix: "cost", type: "integer", label: "cost" },
  ],
};

/**
 * Every castable ability's dials, derived from the live catalog.
 *
 * Two things are skipped, both because they would be dimensions that cannot
 * move: an ability the AI never casts, and a parameter whose base is zero —
 * a percentage bound around zero spans nothing. Electricity's lightningBarrage
 * is the live example, with damage 0 and cooldown 0.
 */
/**
 * Above this, a value is a flag rather than a quantity.
 *
 * Nothing in the game legitimately reaches 2^40; anything that does is standing
 * in for "forever" or "unlimited" and must not be searched.
 */
const SENTINEL_FLOOR = 2 ** 40;

function abilityDials(catalog: Map<string, number>): Omit<SchemaParameter, "base" | "min" | "max">[] {
  const out: Omit<SchemaParameter, "base" | "min" | "max">[] = [];
  for (const kingdomId of KINGDOM_IDS) {
    for (const ability of KINGDOM_ABILITIES[kingdomId]) {
      if (ability.kind === "passive" || NEVER_CAST.has(ability.id)) continue;
      for (const dial of ABILITY_DIALS[ability.kind] ?? []) {
        const id = `ability.${ability.id}.${dial.suffix}`;
        const base = catalog.get(id);
        if (base === undefined || base === 0) continue;
        // A sentinel is not a dial. Poison Apple's effect duration is
        // MAX_SAFE_INTEGER, meaning "permanent" — every value inside a +/-40%
        // band around it is equally permanent, so the search spent a whole
        // dimension moving a number that cannot change the game. It came out of
        // one candidate as 7018891676581419 and out of another as the literal
        // string "default", which is what made it visible.
        if (base >= SENTINEL_FLOOR) continue;
        out.push(p(id, `ability${ability.kind[0]!.toUpperCase()}${ability.kind.slice(1)}`,
          `${kingdomId}: ${ability.id} ${dial.label}`, dial.type));
      }
    }
  }
  return out;
}

export interface SchemaOptions {
  scope?: SearchScope;
  spread?: number;
}

export function buildSchema(options: SchemaOptions | number = {}): BalanceSchema {
  // A number keeps the original `buildSchema(spread)` signature working.
  const { scope = "curated", spread = DEFAULT_SPREAD } =
    typeof options === "number" ? { spread: options, scope: "curated" as SearchScope } : options;

  const catalog = new Map(listParameters().map((x) => [x.id, x.base]));
  const catalogHash = hashSeed(
    [...catalog.entries()].sort().map(([k, v]) => `${k}=${v}`).join(";"),
  )
    .toString(16)
    .padStart(8, "0");

  // The expanded scope is ability dials ONLY: damage/cooldown/cost per attack,
  // duration/cost/cooldown per utility, cooldown/cost per ultimate. 181
  // dimensions. v1's passives and global levers are searched separately and
  // are deliberately held still here, so any movement is attributable to the
  // abilities themselves.
  const selected = scope === "expanded" ? abilityDials(catalog) : [...CURATED];

  const parameters: SchemaParameter[] = [];
  for (const entry of [...selected, ...LOCKED]) {
    const base = catalog.get(entry.id);
    if (base === undefined) {
      throw new Error(
        `schema references "${entry.id}", which the engine no longer exposes`,
      );
    }
    const widened = WIDENED[entry.id];
    const { min, max } = entry.locked
      ? { min: base, max: base }
      : boundsFor(entry.id, base, widened?.spread ?? spread);
    parameters.push({ ...entry, base, min, max });
  }
  return { version: SCOPE_VERSION[scope], catalogHash, parameters };
}

/** Parameters the optimizer may actually move. */
export function searchable(schema: BalanceSchema): SchemaParameter[] {
  return schema.parameters.filter((x) => !x.locked && x.max > x.min);
}

/** Clamps and quantises a raw value into a legal one for this parameter. */
export function coerce(parameter: SchemaParameter, value: number): number {
  let v = Number.isFinite(value) ? value : parameter.base;
  v = Math.min(parameter.max, Math.max(parameter.min, v));
  if (parameter.type === "integer") {
    v = Math.round(v);
    // Rounding can push a value back outside the interval at the edges.
    v = Math.min(Math.floor(parameter.max), Math.max(Math.ceil(parameter.min), v));
  }
  return v;
}

/**
 * Maps a searchable parameter onto [0, 1] and back.
 *
 * CMA-ES works in an unbounded continuous space; normalising every dimension
 * to the same interval keeps its step sizes meaningful across parameters whose
 * natural scales differ by orders of magnitude (a crit chance of 0.05 and a
 * repair cost of 500 in the same vector).
 */
export function encode(parameter: SchemaParameter, value: number): number {
  const span = parameter.max - parameter.min;
  return span <= 0 ? 0.5 : (value - parameter.min) / span;
}

export function decode(parameter: SchemaParameter, unit: number): number {
  const span = parameter.max - parameter.min;
  return coerce(parameter, parameter.min + unit * span);
}

/** The schema's base configuration as a normalised vector. */
export function baseVector(schema: BalanceSchema): number[] {
  return searchable(schema).map((x) => encode(x, x.base));
}

/** Turns a normalised vector into a parameter set the engine can consume. */
export function vectorToParameters(
  schema: BalanceSchema,
  vector: readonly number[],
): ParameterSet {
  const params = searchable(schema);
  const out: Record<string, number> = {};
  params.forEach((parameter, i) => {
    out[parameter.id] = decode(parameter, vector[i] ?? 0.5);
  });
  return out;
}

/** Human-readable summary for the schema artifact. */
export function describeSchema(schema: BalanceSchema): string {
  const L: string[] = [];
  const active = searchable(schema);
  L.push(`schema ${schema.version} (catalog ${schema.catalogHash})`);
  L.push(`  ${active.length} searchable, ${schema.parameters.length - active.length} locked`);
  const byCategory = new Map<string, number>();
  for (const x of active) byCategory.set(x.category, (byCategory.get(x.category) ?? 0) + 1);
  for (const [c, n] of byCategory) L.push(`    ${c}: ${n}`);
  L.push("");
  for (const x of schema.parameters) {
    L.push(
      `  ${x.locked ? "[LOCKED] " : "         "}${x.id.padEnd(32)} ` +
        `${String(x.base).padStart(8)}  [${fmt(x.min)} … ${fmt(x.max)}]  ${x.type}`,
    );
  }
  return L.join("\n");
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
