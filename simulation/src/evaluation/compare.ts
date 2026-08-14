import { comparabilityProblem } from "./provenance.js";
import type { EvaluationResult } from "./evaluator.js";
import type { Rate } from "./stats.js";

/**
 * Baseline vs candidate comparison.
 *
 * Reports what moved. It deliberately does NOT decide whether the candidate is
 * better — ranking configurations is the fitness function's job, and a
 * measuring instrument that also scores is one that can quietly encode a
 * preference nobody agreed to.
 */

export interface Delta {
  baseline: number;
  candidate: number;
  /** candidate − baseline, in percentage points for rates. */
  deltaPp: number;
  /** True when the two confidence intervals do not overlap — the movement is
   *  larger than sampling noise comfortably explains. */
  separated: boolean;
}

export interface MatchupDelta extends Delta {
  a: string;
  b: string;
}

export interface FfaKingdomDelta {
  kingdom: string;
  averagePlacement: { baseline: number; candidate: number; delta: number };
  first: Delta;
  last: Delta;
}

export interface Comparison {
  /** Non-null when the two readings must not be compared. */
  incomparable: string | null;
  baselineId: string;
  candidateId: string;
  duel: {
    kingdoms: Record<string, Delta>;
    profiles: Record<string, Delta>;
    matchups: MatchupDelta[];
    /** Matchups whose intervals separated, largest movement first. */
    significant: MatchupDelta[];
  } | null;
  ffa4: { kingdoms: FfaKingdomDelta[] } | null;
  ffa7: { kingdoms: FfaKingdomDelta[] } | null;
}

function delta(baseline: Rate | undefined, candidate: Rate | undefined): Delta {
  const b = baseline ?? { count: 0, total: 0, rate: 0, ci95: [0, 0] as [number, number] };
  const c = candidate ?? { count: 0, total: 0, rate: 0, ci95: [0, 0] as [number, number] };
  return {
    baseline: b.rate,
    candidate: c.rate,
    deltaPp: (c.rate - b.rate) * 100,
    separated: b.ci95[1] < c.ci95[0] || c.ci95[1] < b.ci95[0],
  };
}

export function compare(
  baseline: EvaluationResult,
  candidate: EvaluationResult,
): Comparison {
  const incomparable = comparabilityProblem(
    baseline.provenance,
    candidate.provenance,
  );

  let duel: Comparison["duel"] = null;
  if (baseline.duel && candidate.duel) {
    const kingdoms: Record<string, Delta> = {};
    for (const k of Object.keys(baseline.duel.kingdoms)) {
      kingdoms[k] = delta(baseline.duel.kingdoms[k], candidate.duel.kingdoms[k]);
    }
    const profiles: Record<string, Delta> = {};
    for (const p of Object.keys(baseline.duel.profiles)) {
      profiles[p] = delta(baseline.duel.profiles[p], candidate.duel.profiles[p]);
    }
    const byKey = new Map(
      candidate.duel.matchups.map((m) => [`${m.a}|${m.b}`, m]),
    );
    const matchups: MatchupDelta[] = baseline.duel.matchups.map((m) => ({
      a: m.a,
      b: m.b,
      ...delta(m.aggregate, byKey.get(`${m.a}|${m.b}`)?.aggregate),
    }));
    const significant = matchups
      .filter((m) => m.separated)
      .sort((x, y) => Math.abs(y.deltaPp) - Math.abs(x.deltaPp));
    duel = { kingdoms, profiles, matchups, significant };
  }

  return {
    incomparable,
    baselineId: baseline.provenance.balanceConfigId,
    candidateId: candidate.provenance.balanceConfigId,
    duel,
    ffa4: ffaDelta(baseline, candidate, "ffa4"),
    ffa7: ffaDelta(baseline, candidate, "ffa7"),
  };
}

function ffaDelta(
  baseline: EvaluationResult,
  candidate: EvaluationResult,
  key: "ffa4" | "ffa7",
): { kingdoms: FfaKingdomDelta[] } | null {
  const b = baseline[key];
  const c = candidate[key];
  if (!b || !c) return null;
  const kingdoms: FfaKingdomDelta[] = [];
  for (const [id, bk] of Object.entries(b.kingdoms)) {
    const ck = c.kingdoms[id];
    if (!ck) continue;
    kingdoms.push({
      kingdom: id,
      averagePlacement: {
        baseline: bk.placement.average,
        candidate: ck.placement.average,
        delta: ck.placement.average - bk.placement.average,
      },
      first: delta(bk.placement.first, ck.placement.first),
      last: delta(bk.placement.last, ck.placement.last),
    });
  }
  kingdoms.sort((x, y) => x.kingdom.localeCompare(y.kingdom));
  return { kingdoms };
}
