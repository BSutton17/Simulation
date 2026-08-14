import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  promotionVerdict,
  promotionText,
  REQUIRED_POOLS,
  type ConstraintCheck,
} from "../simulation/src/fitness/index.js";

/**
 * The promotion gate exists because Step 9's elite candidate cleared every
 * constraint on one validation pool and then violated two of them on another,
 * with nothing changed but the seeds. These tests encode that episode: a
 * candidate whose margins are smaller than its intervals must not be promotable
 * on a single clean reading.
 */

function chk(over: Partial<ConstraintCheck> = {}): ConstraintCheck {
  return {
    format: "ffa7",
    kind: "cannotWin",
    subject: "dark",
    observed: 0.05,
    ci95: [0.04, 0.06],
    threshold: 0.05,
    direction: "min",
    status: "unsettled",
    detail: "dark takes first 5.0%",
    ...over,
  };
}

test("a check is clear only when its whole interval clears the threshold", () => {
  // Floor: the rate must stay above.
  assert.equal(classify(0.24, [0.221, 0.262], 0.2, "min"), "clear");
  assert.equal(classify(0.046, [0.037, 0.058], 0.05, "min"), "unsettled");
  assert.equal(classify(0.02, [0.012, 0.031], 0.05, "min"), "violated");

  // Ceiling: the rate must stay below.
  assert.equal(classify(0.2, [0.18, 0.22], 0.286, "max"), "clear");
  assert.equal(classify(0.45, [0.42, 0.48], 0.286, "max"), "violated");
  assert.equal(classify(0.29, [0.26, 0.31], 0.286, "max"), "unsettled");
});

test("the real third-pool readings are unsettled, not settled violations", () => {
  // Both constraints that "failed" gen007-c05 on the third pool have intervals
  // straddling their thresholds. The point estimate called them violations; the
  // evidence says neither side is established. Reading this as a settled failure
  // would be the same error as reading pool 2 as a settled pass.
  assert.equal(
    classify(0.046, [0.037, 0.058], 0.05, "min"),
    "unsettled",
    "dark 7-FFA first: 4.6% with CI [3.7, 5.8] spans the 5.0% floor",
  );
  assert.equal(
    classify(0.306, [0.283, 0.329], 0.286, "max"),
    "unsettled",
    "fire chronic-last: 30.6% with CI [28.3, 32.9] spans the 28.6% ceiling",
  );
  // Dark's 1v1 rate, by contrast, is genuinely settled — this one really is fixed.
  assert.equal(classify(0.241, [0.221, 0.262], 0.2, "min"), "clear");
});

test("a point estimate on the right side of the line is not enough", () => {
  // Dark's real pool-2 reading: 5.8% first-place against a 5.0% floor. The point
  // estimate clears; the interval does not. Pool 3 then read 4.6%.
  assert.equal(
    classify(0.058, [0.047, 0.071], 0.05, "min"),
    "unsettled",
    "a margin smaller than the interval must not read as clear",
  );
});

test("one clean pool is never enough to promote", () => {
  const clean = [chk({ status: "clear" }), chk({ kind: "chronicLast", status: "clear" })];
  const one = promotionVerdict([{ pool: "validation", checks: clean }]);
  assert.equal(one.decision, "needsMorePools");
  assert.match(one.reason, /independent pools are required/);

  const two = promotionVerdict([
    { pool: "validation", checks: clean },
    { pool: "final", checks: clean },
  ]);
  assert.equal(two.decision, "promote");
  assert.equal(REQUIRED_POOLS, 2);
});

test("a violation on any single pool rejects the candidate", () => {
  const verdict = promotionVerdict([
    { pool: "validation", checks: [chk({ status: "clear" }), chk({ subject: "fire", kind: "chronicLast", status: "clear" })] },
    {
      pool: "final",
      checks: [
        chk({ subject: "dark", status: "violated", observed: 0.01, ci95: [0.005, 0.02] }),
        chk({ subject: "fire", kind: "chronicLast", direction: "max", status: "violated" }),
      ],
    },
  ]);
  assert.equal(verdict.decision, "reject");
  assert.equal(verdict.violated.length, 2);
  assert.match(verdict.reason, /dark cannotWin/);
  assert.match(verdict.reason, /fire chronicLast/);
  // The pool a violation came from must survive into the report.
  assert.ok(verdict.violated.every((v) => v.format.includes("@final")));
});

test("gen007-c05 reaches needsMorePools, not promote and not reject", () => {
  // The candidate's actual history: pool 2 read clean on point estimates but
  // both margins sat inside their intervals; pool 3 read them the other way.
  // The gate's job is to refuse promotion WITHOUT overclaiming failure.
  const verdict = promotionVerdict([
    {
      pool: "validation",
      checks: [
        chk({ subject: "dark", observed: 0.058, ci95: [0.047, 0.071], status: "unsettled" }),
        chk({ subject: "fire", kind: "chronicLast", direction: "max", status: "unsettled" }),
        chk({ subject: "dark", kind: "extremeWinRate", format: "duel", status: "clear" }),
      ],
    },
    {
      pool: "final",
      checks: [
        chk({ subject: "dark", observed: 0.046, ci95: [0.037, 0.058], status: "unsettled" }),
        chk({ subject: "fire", kind: "chronicLast", direction: "max", status: "unsettled" }),
        chk({ subject: "dark", kind: "extremeWinRate", format: "duel", status: "clear" }),
      ],
    },
  ]);
  assert.equal(verdict.decision, "needsMorePools");
  assert.equal(verdict.violated.length, 0, "nothing about this candidate is settled as failing");
  assert.equal(verdict.unsettled.length, 4);
});

test("an unsettled check asks for more pools rather than guessing", () => {
  const verdict = promotionVerdict([
    { pool: "validation", checks: [chk({ status: "clear" })] },
    { pool: "final", checks: [chk({ status: "unsettled" })] },
  ]);
  assert.equal(verdict.decision, "needsMorePools");
  assert.equal(verdict.unsettled.length, 1);
  assert.match(verdict.reason, /straddle their threshold/);
});

test("a settled violation outranks an unsettled one", () => {
  const verdict = promotionVerdict([
    { pool: "a", checks: [chk({ status: "unsettled" }), chk({ subject: "fire", status: "violated" })] },
    { pool: "b", checks: [chk({ status: "clear" })] },
  ]);
  assert.equal(verdict.decision, "reject", "a real violation is not softened by an uncertain one");
});

test("no evaluations means no promotion", () => {
  assert.equal(promotionVerdict([]).decision, "needsMorePools");
});

test("the gate report names the pool and shows the interval", () => {
  const text = promotionText(
    promotionVerdict([
      { pool: "validation", checks: [chk({ status: "clear" })] },
      { pool: "final", checks: [chk({ status: "violated", observed: 0.046, ci95: [0.037, 0.058] })] },
    ]),
  );
  assert.match(text, /PROMOTION GATE/);
  assert.match(text, /decision  REJECT/);
  assert.match(text, /validation, final/);
  assert.match(text, /VIOLATED/);
  assert.match(text, /CI \[3\.7%, 5\.8%\]/);
});
