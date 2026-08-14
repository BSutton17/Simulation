import type { EvaluationResult } from "../evaluation/index.js";
import { DEFAULT_CONSTRAINTS, type Constraints } from "./fitness.js";

/**
 * The promotion gate — whether a candidate has actually earned a balance change.
 *
 * Fitness answers "how good is this reading?". That is not the same question as
 * "is this candidate ready to ship?", and conflating them is how Step 9's
 * gen007-c05 came to look promotable. It cleared every constraint on its
 * validation pool with zero violations and a 0.8957 score. On a third,
 * independent pool two of those constraints came back violated: Dark's 7-FFA
 * first-place rate at 4.6% against a 5.0% floor, and Fire's chronic-last at
 * 30.6% against a 28.6% ceiling.
 *
 * Nothing had changed except the dice. Both constraints had been sitting inside
 * their own confidence intervals all along — the reading said "clear", but the
 * evidence only ever said "could be either side". A gate that reads point
 * estimates cannot tell those two situations apart, so it must read intervals.
 *
 * This module never scores and never steers the search. It answers one
 * question about a finished candidate, and the honest answer is often
 * "not settled yet".
 */

export type ConstraintStatus = "clear" | "unsettled" | "violated";

export interface ConstraintCheck {
  format: string;
  kind: string;
  subject: string;
  observed: number;
  /** 95% Wilson interval on the observed rate. */
  ci95: [number, number];
  threshold: number;
  /** Whether the threshold is a floor the rate must stay above, or a ceiling it
   *  must stay below. */
  direction: "min" | "max";
  status: ConstraintStatus;
  detail: string;
}

/**
 * Classifies one rate against one threshold.
 *
 * The whole interval must be on the right side of the line for a check to be
 * clear, and on the wrong side for it to be a settled violation. Anything
 * straddling the threshold is `unsettled`: this pool cannot decide it, and
 * saying so is more useful than picking whichever side the point estimate
 * happens to land on.
 */
export function classify(
  observed: number,
  ci95: [number, number],
  threshold: number,
  direction: "min" | "max",
): ConstraintStatus {
  const [low, high] = ci95;
  if (direction === "min") {
    if (low >= threshold) return "clear";
    if (high < threshold) return "violated";
    return "unsettled";
  }
  if (high <= threshold) return "clear";
  if (low > threshold) return "violated";
  return "unsettled";
}

function check(
  format: string,
  kind: string,
  subject: string,
  rate: { rate: number; ci95: [number, number] },
  threshold: number,
  direction: "min" | "max",
  detail: string,
): ConstraintCheck {
  return {
    format, kind, subject,
    observed: rate.rate,
    ci95: rate.ci95,
    threshold,
    direction,
    status: classify(rate.rate, rate.ci95, threshold, direction),
    detail,
  };
}

/**
 * Every constraint in the fitness rules, re-read WITH its interval.
 *
 * Deliberately mirrors `findViolations` rather than replacing it: the search
 * needs a fast point-estimate verdict to penalise, and the gate needs an
 * interval-aware one. Same thresholds, same subjects, two different questions.
 */
export function checkConstraints(
  result: EvaluationResult,
  limits: Constraints = DEFAULT_CONSTRAINTS,
): ConstraintCheck[] {
  const checks: ConstraintCheck[] = [];

  if (result.duel) {
    for (const [kingdom, r] of Object.entries(result.duel.kingdoms)) {
      checks.push(
        check("duel", "extremeWinRate", kingdom, r, limits.duelWinRateBound, "min",
          `${kingdom} wins ${pct(r.rate)} of duels (floor ${pct(limits.duelWinRateBound)})`),
        check("duel", "extremeWinRate", kingdom, r, 1 - limits.duelWinRateBound, "max",
          `${kingdom} wins ${pct(r.rate)} of duels (ceiling ${pct(1 - limits.duelWinRateBound)})`),
      );
    }
  }

  for (const [name, ffa] of [["ffa4", result.ffa4], ["ffa7", result.ffa7]] as const) {
    if (!ffa) continue;
    const fair = 1 / ffa.seats;
    for (const k of Object.values(ffa.kingdoms)) {
      const floor = fair * limits.ffaFirstFloorRatio;
      const ceiling = fair * limits.ffaLastCeilingRatio;
      checks.push(
        check(name, "cannotWin", k.kingdom, k.placement.first, floor, "min",
          `${k.kingdom} takes first ${pct(k.placement.first.rate)} (floor ${pct(floor)}, fair ${pct(fair)})`),
        check(name, "chronicLast", k.kingdom, k.placement.last, ceiling, "max",
          `${k.kingdom} finishes last ${pct(k.placement.last.rate)} (ceiling ${pct(ceiling)}, fair ${pct(fair)})`),
      );
    }
  }
  return checks;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export type PromotionDecision = "promote" | "reject" | "needsMorePools";

export interface PromotionVerdict {
  decision: PromotionDecision;
  /** One line stating what to do and why. */
  reason: string;
  poolsUsed: string[];
  /** Settled violations, from any pool. Any one of these blocks promotion. */
  violated: ConstraintCheck[];
  /** Checks no pool could decide. These are what more pools would resolve. */
  unsettled: ConstraintCheck[];
}

/** Pools required before a clean reading counts as evidence rather than luck. */
export const REQUIRED_POOLS = 2;

/**
 * The gate.
 *
 * Three rules, in order:
 *
 *  1. A violation on ANY pool rejects the candidate. A constraint that fails on
 *     one pool and passes on another has not been fixed; it has been sampled.
 *  2. An unsettled check means the evidence is insufficient — the answer is
 *     "run another pool", never "assume it passed".
 *  3. Clean on fewer than two independent pools is also insufficient. One pool
 *     cannot distinguish a real fix from a favourable draw, which is precisely
 *     the mistake this gate exists to prevent.
 */
export function promotionVerdict(
  pools: { pool: string; checks: ConstraintCheck[] }[],
): PromotionVerdict {
  const poolsUsed = pools.map((p) => p.pool);
  const violated = pools.flatMap((p) =>
    p.checks.filter((c) => c.status === "violated").map((c) => ({ ...c, format: `${c.format}@${p.pool}` })),
  );
  const unsettled = pools.flatMap((p) =>
    p.checks.filter((c) => c.status === "unsettled").map((c) => ({ ...c, format: `${c.format}@${p.pool}` })),
  );

  if (pools.length === 0) {
    return { decision: "needsMorePools", reason: "no evaluations supplied", poolsUsed, violated, unsettled };
  }
  if (violated.length > 0) {
    return {
      decision: "reject",
      reason:
        `${violated.length} constraint${violated.length === 1 ? "" : "s"} settled as violated ` +
        `across ${pools.length} pool${pools.length === 1 ? "" : "s"}: ${violated.map((v) => `${v.subject} ${v.kind}`).join(", ")}`,
      poolsUsed, violated, unsettled,
    };
  }
  if (unsettled.length > 0) {
    return {
      decision: "needsMorePools",
      reason:
        `${unsettled.length} constraint${unsettled.length === 1 ? "" : "s"} straddle their threshold ` +
        `and cannot be decided from ${pools.length} pool${pools.length === 1 ? "" : "s"}: ` +
        `${[...new Set(unsettled.map((v) => `${v.subject} ${v.kind}`))].join(", ")}`,
      poolsUsed, violated, unsettled,
    };
  }
  if (pools.length < REQUIRED_POOLS) {
    return {
      decision: "needsMorePools",
      reason: `clean on ${pools.length} pool, but ${REQUIRED_POOLS} independent pools are required before promotion`,
      poolsUsed, violated, unsettled,
    };
  }
  return {
    decision: "promote",
    reason: `every constraint clear with its full interval on ${pools.length} independent pools`,
    poolsUsed, violated, unsettled,
  };
}

/** Human-readable gate report. */
export function promotionText(verdict: PromotionVerdict): string {
  const L: string[] = [];
  L.push("=".repeat(70));
  L.push("PROMOTION GATE — may this candidate become a real balance change?");
  L.push("=".repeat(70));
  L.push(`  decision  ${verdict.decision.toUpperCase()}`);
  L.push(`  pools     ${verdict.poolsUsed.join(", ") || "none"}`);
  L.push(`  ${verdict.reason}`);
  for (const [title, list] of [
    ["VIOLATED", verdict.violated],
    ["UNSETTLED", verdict.unsettled],
  ] as const) {
    if (list.length === 0) continue;
    L.push("");
    L.push(`  ${title}`);
    for (const c of list) {
      L.push(
        `    ${c.format.padEnd(14)} ${c.detail}  CI [${pct(c.ci95[0])}, ${pct(c.ci95[1])}]`,
      );
    }
  }
  return L.join("\n");
}
