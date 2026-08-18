import type { MatchRecord } from "../types.js";
import type { MatchFormat } from "./slate.js";
import type { SeatCombat } from "./matchObserver.js";

/**
 * AI fitness — how good a PLAYER is.
 *
 * Deliberately not the balance fitness in `fitness/fitness.ts`. That scores how
 * far a 21,000-match reading sits from parity across sixteen kingdoms; it is a
 * property of a balance configuration, and a single genome has no win-rate
 * spread to be fair about. Reusing it here would be a category error.
 *
 * The formula is small on purpose. Four terms, each observable in the result,
 * and winning dominates. A pile of shaping rewards is how a fitness function
 * becomes something nobody can reason about and a policy learns to farm.
 */

export const AI_FITNESS_VERSION = "v2";

/** Everything one evaluation match produced. Kept whole, not reduced to a number. */
export interface ScenarioResult {
  scenarioId: string;
  format: MatchFormat;
  seats: number;
  kingdom: string;
  seat: number;

  // outcome
  placement: number;
  won: boolean;
  drawn: boolean;
  lost: boolean;
  eliminated: boolean;
  timedOut: boolean;

  // survival
  endedAtTick: number;
  survivedTicks: number;
  survivedFraction: number;
  hpRemaining: number;
  hpFraction: number;

  // combat
  damageDealt: number;
  damageReceived: number;
  kills: number;

  // behaviour
  casts: number;
  invests: number;
  citizensBought: number;
  repairs: number;
  shields: number;
  retargets: number;
  waits: number;
  decisions: number;

  // scoring
  score: number;
  /** Per-term contributions, so a score can always be taken apart. */
  terms: FitnessTerms;
}

export interface FitnessTerms {
  win: number;
  placement: number;
  survival: number;
  combat: number;
  /** Multiplier applied by the guards (1 = untouched). */
  guard: number;
  guardReason: string | null;
}

export interface FitnessConfig {
  /** Outright victory. Dominant by design. */
  winWeight: number;
  /** Normalized placement, 1 = first. Carries the free-for-all signal. */
  placementWeight: number;
  /** Fraction of the match survived. Small: a tiebreak between losses. */
  survivalWeight: number;
  /**
   * Damage dealt as a share of damage exchanged, in [0,1].
   *
   * A ratio rather than raw damage, deliberately. Raw damage is farmable — the
   * volcano is a legal target that is not a kingdom — while a ratio rewards
   * winning exchanges, which is what fighting well actually looks like.
   */
  combatWeight: number;
  /**
   * Ceiling on a match that hit the tick cap.
   *
   * Without it, turtling wins: placement ranks timeout survivors by remaining
   * HP, so a genome that buys shields and never attacks places first having
   * accomplished nothing. The baseline produces timeouts at roughly one match
   * in eighty, so the state is reachable.
   */
  timeoutCap: number;
  /** Score for a match in which the genome never cast anything. */
  inactivityScore: number;
}

export const DEFAULT_FITNESS: FitnessConfig = {
  winWeight: 1,
  placementWeight: 0.35,
  survivalWeight: 0.1,
  combatWeight: 0.15,
  timeoutCap: 0.25,
  inactivityScore: 0,
};

/** The largest score the formula can produce, for normalizing reports. */
export function maxScore(config: FitnessConfig): number {
  return config.winWeight + config.placementWeight + config.survivalWeight + config.combatWeight;
}

/** Finishing position, 1 = winner. Mirrors `evaluation/jobs.ts:runJob`. */
export function placementOf(record: MatchRecord, playerId: string): number {
  const ordered = [...record.players].sort((x, y) => {
    if (x.id === record.winnerId) return -1;
    if (y.id === record.winnerId) return 1;
    const xd = x.eliminatedAtTick;
    const yd = y.eliminatedAtTick;
    if (xd === null && yd === null) return y.hp - x.hp;
    if (xd === null) return -1;
    if (yd === null) return 1;
    return yd - xd;
  });
  return ordered.findIndex((p) => p.id === playerId) + 1;
}

export interface ScenarioContext {
  scenarioId: string;
  format: MatchFormat;
  seats: number;
  kingdom: string;
  seat: number;
  combat: SeatCombat;
  behaviour: {
    casts: number;
    invests: number;
    citizens: number;
    repairs: number;
    shields: number;
    retargets: number;
    waits: number;
    decisions: number;
  };
}

/**
 * Scores one match from the genome's point of view.
 *
 * Every term is recorded alongside the total, so a surprising fitness can be
 * taken apart without re-running the match.
 */
export function scoreScenario(
  record: MatchRecord,
  playerId: string,
  context: ScenarioContext,
  config: FitnessConfig,
): ScenarioResult {
  const seats = record.players.length;
  const placement = placementOf(record, playerId);
  const me = record.players.find((p) => p.id === playerId)!;
  const won = record.winnerId === playerId;
  // A draw is the engine's no-survivors outcome: the match ended, nobody won.
  const drawn = record.winnerId === null && !record.timedOut;
  const eliminated = me.eliminatedAtTick !== null;
  const lost = !won && !drawn;

  const survivedTicks = me.eliminatedAtTick ?? record.endedAtTick;
  const survivedFraction = survivedTicks / Math.max(1, record.endedAtTick);
  const hpFraction = Math.max(0, Math.min(1, me.hp / 10_000));

  const normalizedPlacement = seats > 1 ? (seats - placement) / (seats - 1) : won ? 1 : 0;
  const exchanged = context.combat.damageDealt + context.combat.damageReceived;
  const combatShare = exchanged > 0 ? context.combat.damageDealt / exchanged : 0;

  const terms: FitnessTerms = {
    win: won ? config.winWeight : 0,
    placement: config.placementWeight * normalizedPlacement,
    survival: config.survivalWeight * survivedFraction,
    combat: config.combatWeight * combatShare,
    guard: 1,
    guardReason: null,
  };

  let score = terms.win + terms.placement + terms.survival + terms.combat;

  // Guards. Both describe strategies that score well while accomplishing
  // nothing, and both are reachable in this game.
  if (context.behaviour.casts === 0) {
    score = config.inactivityScore;
    terms.guard = 0;
    terms.guardReason = "never cast";
  } else if (record.timedOut && score > config.timeoutCap) {
    terms.guard = config.timeoutCap / score;
    terms.guardReason = "timeout";
    score = config.timeoutCap;
  }

  return {
    scenarioId: context.scenarioId,
    format: context.format,
    seats: context.seats,
    kingdom: context.kingdom,
    seat: context.seat,
    placement,
    won,
    drawn,
    lost,
    eliminated,
    timedOut: record.timedOut,
    endedAtTick: record.endedAtTick,
    survivedTicks,
    survivedFraction,
    hpRemaining: me.hp,
    hpFraction,
    damageDealt: context.combat.damageDealt,
    damageReceived: context.combat.damageReceived,
    kills: context.combat.kills,
    casts: context.behaviour.casts,
    invests: context.behaviour.invests,
    citizensBought: context.behaviour.citizens,
    repairs: context.behaviour.repairs,
    shields: context.behaviour.shields,
    retargets: context.behaviour.retargets,
    waits: context.behaviour.waits,
    decisions: context.behaviour.decisions,
    score,
    terms,
  };
}

/** A genome's result over a whole slate. */
export interface TrainingResult {
  fitness: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  totalDamageDealt: number;
  totalDamageReceived: number;
  totalKills: number;
  totalCasts: number;
  scenarios: ScenarioResult[];
}

export function aggregate(scenarios: readonly ScenarioResult[]): TrainingResult {
  const all = [...scenarios];
  if (all.length === 0) {
    return {
      fitness: 0, matches: 0, wins: 0, losses: 0, draws: 0, timeouts: 0, inactive: 0,
      meanPlacement: 0, totalDamageDealt: 0, totalDamageReceived: 0, totalKills: 0,
      totalCasts: 0, scenarios: [],
    };
  }
  const sum = (pick: (s: ScenarioResult) => number): number =>
    all.reduce((total, s) => total + pick(s), 0);
  return {
    fitness: sum((s) => s.score) / all.length,
    matches: all.length,
    wins: all.filter((s) => s.won).length,
    losses: all.filter((s) => s.lost).length,
    draws: all.filter((s) => s.drawn).length,
    timeouts: all.filter((s) => s.timedOut).length,
    inactive: all.filter((s) => s.casts === 0).length,
    meanPlacement: sum((s) => s.placement) / all.length,
    totalDamageDealt: sum((s) => s.damageDealt),
    totalDamageReceived: sum((s) => s.damageReceived),
    totalKills: sum((s) => s.kills),
    totalCasts: sum((s) => s.casts),
    scenarios: all,
  };
}
