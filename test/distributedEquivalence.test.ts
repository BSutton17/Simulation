import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Cmaes } from "../simulation/src/search/index.js";

/**
 * The scientific gate for distributed evaluation.
 *
 * Distribution is allowed to change WHERE a candidate is evaluated. It is not
 * allowed to change what CMA-ES learns. Evaluation is already deterministic
 * given (parameters, tier, seed pool, engine, schema, fitness version) — proven
 * separately by outcome fingerprints over 540 matches — so the only way a
 * distributed run can diverge from a local one is if the scores arrive paired
 * with the wrong candidates.
 *
 * That makes ORDER the whole safety argument. `cma.tell(vectors, scores)` takes
 * the correspondence between candidate and score from array position and
 * nothing else. A permuted result set trains the strategy on mismatched pairs
 * and raises no error anywhere: the run completes, the numbers look plausible,
 * and the optimisation is meaningless.
 *
 * These tests establish three things: that order genuinely matters (so the
 * guard is not decorative), that identical ordered input gives identical state,
 * and that `run.ts` refuses a result set which is the wrong size or out of
 * order.
 */

const DIMENSION = 6;
const POPULATION = 8;

function strategy(): Cmaes {
  return new Cmaes({
    dimension: DIMENSION,
    mean: new Array(DIMENSION).fill(0.5),
    sigma: 0.2,
    populationSize: POPULATION,
    seed: 20260813,
  });
}

/** A deterministic stand-in for a real evaluation. */
const score = (v: readonly number[]) => -v.reduce((sum, x) => sum + (x - 0.31) ** 2, 0);

test("identical ordered scores produce identical strategy state", () => {
  // The distributed path evaluates the same candidates somewhere else and
  // returns the same numbers. If that is all it does, the strategy cannot tell
  // the difference — which is exactly the claim being made.
  const local = strategy();
  const distributed = strategy();

  for (let generation = 0; generation < 4; generation++) {
    const a = local.ask();
    local.tell(a, a.map(score));

    const b = distributed.ask();
    // Simulate results coming back from workers in arbitrary completion order,
    // then being restored to candidate order before tell() — what the
    // coordinator is required to do.
    const outOfOrder = b.map((vector, index) => ({ index, vector, value: score(vector) }));
    outOfOrder.sort((x, y) => (x.index * 7919) % 13 - (y.index * 7919) % 13);
    const reordered = [...outOfOrder].sort((x, y) => x.index - y.index);
    distributed.tell(b, reordered.map((r) => r.value));
  }

  const x = local.snapshot();
  const y = distributed.snapshot();
  assert.deepEqual(x.mean, y.mean, "mean diverged");
  assert.deepEqual(x.C, y.C, "covariance diverged");
  assert.deepEqual(x.pc, y.pc, "evolution path pc diverged");
  assert.deepEqual(x.ps, y.ps, "evolution path ps diverged");
  assert.equal(x.sigma, y.sigma, "step size diverged");
  assert.equal(x.rngState, y.rngState, "RNG diverged");
  assert.equal(x.generation, y.generation);
});

test("order is load-bearing, so the guard is not decorative", () => {
  // If a permuted result set produced the same state, none of this would
  // matter. It does not: this is the failure the coordinator must prevent.
  const ordered = strategy();
  const permuted = strategy();

  const a = ordered.ask();
  ordered.tell(a, a.map(score));

  const b = permuted.ask();
  const scores = b.map(score);
  permuted.tell(b, [scores[1]!, scores[0]!, ...scores.slice(2)]); // two swapped

  assert.notDeepEqual(
    ordered.snapshot().mean,
    permuted.snapshot().mean,
    "swapping two scores left the strategy unchanged — the ordering guard would be pointless",
  );
});

test("run.ts refuses a result set that is the wrong size or out of order", () => {
  // Asserted against the source: exercising it needs a full generation of real
  // evaluation, which costs about forty minutes. The guards are short and
  // their absence is the specific way distribution goes wrong silently.
  const source = readFileSync("simulation/src/search/run.ts", "utf8");
  const seam = source.slice(source.indexOf("if (config.evaluateGeneration)"));

  assert.match(
    seam,
    /results\.length !== candidates\.length/,
    "a short result set must not reach tell()",
  );
  assert.match(
    seam,
    /e\.candidate\.hash !== candidates\[i\]!\.hash/,
    "results must be checked against the candidate at the same index",
  );
  // Both must throw rather than warn: a warning in a Kaggle log is a warning
  // nobody reads until the run is over.
  const guardBlock = seam.slice(0, seam.indexOf("} else {"));
  assert.equal(
    (guardBlock.match(/throw new Error/g) ?? []).length,
    2,
    "both guards must throw",
  );
});

test("the local path is untouched when no distributed evaluator is supplied", () => {
  // Distribution is opt-in. The existing single-process search must behave
  // exactly as it did, which is what the rest of the suite continues to prove.
  const source = readFileSync("simulation/src/search/run.ts", "utf8");
  assert.match(source, /evaluateGeneration\?:/, "the seam should be optional");
  assert.match(
    source,
    /} else \{\s*for \(const candidate of candidates\) \{/,
    "the original sequential loop must remain as the default path",
  );
});
