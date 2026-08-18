import type { MatchRecord } from "../types.js";
import type { FitnessConfig } from "./config.js";

/**
 * AI fitness — how good a PLAYER is.
 *
 * Deliberately not the balance fitness in `fitness/fitness.ts`. That scores how
 * far a 21,000-match reading sits from parity across sixteen kingdoms; it is a
 * property of a balance configuration, and a single genome has no win-rate
 * spread to be fair about. Reusing it here would be a category error.
 *
 * Placement is the primary term because it is the only measure that means the
 * same thing in a duel, a four-way and a seven-way. Everything else is a
 * tiebreak or a guard.
 */

export interface MatchScore {
  /** Final fitness for this match, in [0, ~1.5]. */
  score: number;
  placement: number;
  seats: number;
  won: boolean;
  timedOut: boolean;
  casts: number;
  survivedFraction: number;
  hpFraction: number;
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

/**
 * Scores one match from the genome's point of view.
 *
 * The two guards are not decoration. Both describe strategies that score well
 * while accomplishing nothing, and both are reachable in this game — the
 * baseline already produces timeouts at roughly one match in eighty.
 */
export function scoreMatch(
  record: MatchRecord,
  playerId: string,
  casts: number,
  config: FitnessConfig,
): MatchScore {
  const seats = record.players.length;
  const placement = placementOf(record, playerId);
  const me = record.players.find((p) => p.id === playerId)!;
  const won = record.winnerId === playerId;

  const normalized = seats > 1 ? (seats - placement) / (seats - 1) : won ? 1 : 0;
  const survivedFraction =
    me.eliminatedAtTick === null ? 1 : me.eliminatedAtTick / Math.max(1, record.endedAtTick);
  const hpFraction = Math.max(0, Math.min(1, me.hp / 10_000));

  // Surviving is worth something, but only as a tiebreak between genomes that
  // placed the same — never enough to beat placing higher.
  const margin = won ? hpFraction : survivedFraction;
  let score =
    config.placementWeight * normalized +
    (won ? config.winBonus : 0) +
    config.marginWeight * margin;

  // A genome that never acted cannot be rewarded for outlasting six kingdoms
  // that fought each other.
  if (casts === 0) {
    return {
      score: config.inactivityScore,
      placement, seats, won, timedOut: record.timedOut, casts,
      survivedFraction, hpFraction,
    };
  }
  // Reaching the tick cap is not a win, however healthy the castle.
  if (record.timedOut) score = Math.min(score, config.timeoutCap);

  return { score, placement, seats, won, timedOut: record.timedOut, casts, survivedFraction, hpFraction };
}

export interface GenomeFitness {
  fitness: number;
  matches: number;
  wins: number;
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  totalCasts: number;
}

/** Mean score across a genome's slate. */
export function aggregate(scores: readonly MatchScore[]): GenomeFitness {
  if (scores.length === 0) {
    return { fitness: 0, matches: 0, wins: 0, timeouts: 0, inactive: 0, meanPlacement: 0, totalCasts: 0 };
  }
  return {
    fitness: scores.reduce((sum, s) => sum + s.score, 0) / scores.length,
    matches: scores.length,
    wins: scores.filter((s) => s.won).length,
    timeouts: scores.filter((s) => s.timedOut).length,
    inactive: scores.filter((s) => s.casts === 0).length,
    meanPlacement: scores.reduce((sum, s) => sum + s.placement, 0) / scores.length,
    totalCasts: scores.reduce((sum, s) => sum + s.casts, 0),
  };
}
