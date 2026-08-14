import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { KINGDOM_ABILITIES } from "../../../src/data/kingdomAbilities.js";
import type { MatchTelemetry } from "../telemetry.js";

/**
 * AI ability coverage — a health check on the measuring instrument, not a
 * balance metric.
 *
 * The Balance AI judges the game through AI-played matches. If the controller
 * never casts an ability, the evaluator sees a game in which that ability does
 * not exist, and may conclude its parameters do not matter. Coverage tells us
 * how much of the game the readings actually cover.
 *
 * It deliberately does NOT feed fitness. Rewarding coverage directly would let
 * the optimizer buy a better score by making abilities cheap enough to spam,
 * trading real balance for a diagnostic number.
 */

export type UsageBand = "never" | "rare" | "occasional" | "regular";

export interface AbilityUsage {
  abilityId: string;
  kingdomId: KingdomId;
  kind: string;
  casts: number;
  /** Casts per match in which this kingdom appeared. */
  perMatch: number;
  band: UsageBand;
}

export interface KingdomCoverage {
  kingdomId: KingdomId;
  used: number;
  total: number;
  unused: string[];
}

export interface CoverageReport {
  used: number;
  total: number;
  fraction: number;
  byKingdom: KingdomCoverage[];
  abilities: AbilityUsage[];
  /** Abilities never cast at all, across every match sampled. */
  unused: string[];
  /** Matches the report was derived from. */
  matches: number;
}

/**
 * Bands, so "used once in 500 matches" is not reported as equivalent to a
 * staple. An ability firing once proves it is reachable, not that the
 * controller understands when to reach for it.
 */
function bandFor(perMatch: number): UsageBand {
  if (perMatch <= 0) return "never";
  if (perMatch < 0.05) return "rare";
  if (perMatch < 0.5) return "occasional";
  return "regular";
}

/** Every activatable ability in the game, keyed by id. */
function allAbilities(): Map<string, { kingdomId: KingdomId; kind: string }> {
  const out = new Map<string, { kingdomId: KingdomId; kind: string }>();
  for (const kingdomId of KINGDOM_IDS) {
    for (const ability of KINGDOM_ABILITIES[kingdomId]) {
      if (ability.kind === "passive") continue;
      out.set(ability.id, { kingdomId, kind: ability.kind });
    }
  }
  return out;
}

/** Total activatable abilities — the denominator of the coverage figure. */
export function totalAbilities(): number {
  return allAbilities().size;
}

/**
 * Builds a coverage report from match telemetry.
 *
 * Derived from telemetry the evaluator already collects, so a checkpoint costs
 * nothing beyond enabling telemetry on the run that produces it.
 */
export function abilityCoverage(telemetry: readonly MatchTelemetry[]): CoverageReport {
  const catalogue = allAbilities();
  const casts = new Map<string, number>();
  const kingdomMatches = new Map<string, number>();

  for (const match of telemetry) {
    for (const seat of match.seats) {
      if (!seat.kingdomId) continue;
      kingdomMatches.set(seat.kingdomId, (kingdomMatches.get(seat.kingdomId) ?? 0) + 1);
      for (const [abilityId, n] of Object.entries(seat.abilities.byAbility)) {
        casts.set(abilityId, (casts.get(abilityId) ?? 0) + n);
      }
    }
  }

  const abilities: AbilityUsage[] = [];
  for (const [abilityId, meta] of catalogue) {
    const n = casts.get(abilityId) ?? 0;
    const appearances = kingdomMatches.get(meta.kingdomId) ?? 0;
    const perMatch = appearances > 0 ? n / appearances : 0;
    abilities.push({
      abilityId,
      kingdomId: meta.kingdomId,
      kind: meta.kind,
      casts: n,
      perMatch,
      band: bandFor(perMatch),
    });
  }
  abilities.sort((a, b) => a.kingdomId.localeCompare(b.kingdomId) || a.abilityId.localeCompare(b.abilityId));

  const byKingdom: KingdomCoverage[] = KINGDOM_IDS.map((kingdomId) => {
    const own = abilities.filter((a) => a.kingdomId === kingdomId);
    const unused = own.filter((a) => a.casts === 0).map((a) => a.abilityId);
    return { kingdomId, used: own.length - unused.length, total: own.length, unused };
  });

  const unused = abilities.filter((a) => a.casts === 0).map((a) => a.abilityId);
  const used = abilities.length - unused.length;
  return {
    used,
    total: abilities.length,
    fraction: abilities.length > 0 ? used / abilities.length : 0,
    byKingdom,
    abilities,
    unused,
    matches: telemetry.length,
  };
}

/**
 * A coverage reading plus the context that makes it comparable to another one.
 *
 * Bare counts are not comparable, and treating them as if they were produces
 * confident nonsense: the Step 10 smoke test reported a "regression" from 66 to
 * 61 that was really a baseline reading held up against a reading taken under a
 * candidate's parameters, on different seeds, from 24 matches. Every one of
 * those differences moves the number on its own.
 */
export interface CoverageCheckpoint {
  used: number;
  total: number;
  matches: number;
  /** Hash of the parameter overrides in force. Readings taken under different
   *  balance are not comparable. */
  balanceConfigHash: string;
  /** Seed label, so same-config readings on different seeds are flagged. */
  seedLabel: string;
}

/**
 * Below this, a coverage count is dominated by sampling.
 *
 * Coverage is per-ability, so what matters is how often each KINGDOM is drawn:
 * with 16 kingdoms and two seats, a 24-match sample gives each kingdom about
 * three appearances, and a situational ability can easily miss all three
 * without anything having changed. 160 duel-matches puts each kingdom in
 * roughly twenty, which is where the count starts to mean something.
 */
export const MIN_MATCHES_FOR_STABLE_COVERAGE = 160;

export interface CoverageComparison {
  comparable: boolean;
  /** Why a comparison was refused, or why it is weak. Null when clean. */
  caveat: string | null;
  delta: number | null;
  /** Set only for a real, comparable, beyond-tolerance drop. */
  regression: string | null;
}

/**
 * Compares two coverage checkpoints, refusing the comparison when the readings
 * were not taken under the same conditions.
 *
 * Refusing is the point. A coverage number is a health check on the measuring
 * instrument; a false regression alarm sends someone hunting a controller bug
 * that does not exist, which is a worse outcome than no reading at all.
 */
export function compareCoverage(
  before: CoverageCheckpoint,
  after: CoverageCheckpoint,
  tolerance = 4,
): CoverageComparison {
  if (before.balanceConfigHash !== after.balanceConfigHash) {
    return {
      comparable: false,
      caveat:
        `not comparable: different balance (${before.balanceConfigHash} vs ${after.balanceConfigHash}). ` +
        `Compare baseline-to-baseline or candidate-to-the-same-candidate.`,
      delta: null,
      regression: null,
    };
  }
  if (before.seedLabel !== after.seedLabel) {
    return {
      comparable: false,
      caveat: `not comparable: different seeds ("${before.seedLabel}" vs "${after.seedLabel}")`,
      delta: null,
      regression: null,
    };
  }

  const delta = after.used - before.used;
  const thin = Math.min(before.matches, after.matches) < MIN_MATCHES_FOR_STABLE_COVERAGE;
  if (delta >= -tolerance) {
    return { comparable: true, caveat: thin ? thinCaveat(before, after) : null, delta, regression: null };
  }
  // A drop past tolerance on a thin sample is reported as inconclusive rather
  // than as a regression — the sample cannot support the claim.
  if (thin) {
    return { comparable: true, caveat: thinCaveat(before, after), delta, regression: null };
  }
  return {
    comparable: true,
    caveat: null,
    delta,
    regression: `AI coverage regression: ${after.used}/${after.total} against ${before.used}/${before.total}`,
  };
}

function thinCaveat(before: CoverageCheckpoint, after: CoverageCheckpoint): string {
  return (
    `sample too thin to judge a change: ${Math.min(before.matches, after.matches)} matches ` +
    `(need ${MIN_MATCHES_FOR_STABLE_COVERAGE} for each kingdom to appear often enough)`
  );
}

/**
 * Renders a coverage report.
 *
 * A comparison is only shown when one was actually made. Passing a bare
 * "baseline number" is deliberately not supported any more: that signature is
 * what allowed two incomparable readings to be printed side by side with a
 * delta between them.
 */
export function coverageText(report: CoverageReport, comparison?: CoverageComparison): string {
  const L: string[] = [];
  L.push("=".repeat(70));
  L.push("AI ABILITY COVERAGE — diagnostic, never part of fitness");
  L.push("=".repeat(70));
  const delta =
    comparison?.comparable && comparison.delta !== null
      ? `   (${comparison.delta >= 0 ? "+" : ""}${comparison.delta} vs previous)`
      : "";
  L.push(
    `  ${report.used}/${report.total} = ${(report.fraction * 100).toFixed(1)}%${delta}` +
      `   from ${report.matches} matches`,
  );
  if (comparison?.regression) L.push(`  ⚠ ${comparison.regression}`);
  if (comparison?.caveat) L.push(`  · ${comparison.caveat}`);
  if (report.matches < MIN_MATCHES_FOR_STABLE_COVERAGE) {
    L.push(
      `  · ${report.matches} matches is below the ${MIN_MATCHES_FOR_STABLE_COVERAGE} needed for a stable count — ` +
        `read the bands, not the total`,
    );
  }
  L.push("");
  L.push("  By kingdom");
  for (const k of report.byKingdom) {
    L.push(
      `    ${k.kingdomId.padEnd(13)} ${k.used}/${k.total}` +
        (k.unused.length > 0 ? `   unused: ${k.unused.join(", ")}` : ""),
    );
  }
  // Usage bands matter more than the raw count: an ability cast once is
  // reachable, not understood.
  const bands: Record<UsageBand, number> = { never: 0, rare: 0, occasional: 0, regular: 0 };
  for (const a of report.abilities) bands[a.band] += 1;
  L.push("");
  L.push(
    `  Usage bands: regular ${bands.regular}  ·  occasional ${bands.occasional}  ·  ` +
      `rare ${bands.rare}  ·  never ${bands.never}`,
  );
  return L.join("\n");
}
