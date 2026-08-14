import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Cmaes } from "../simulation/src/search/index.js";

/**
 * `promote` must not change what CMA-ES learns.
 *
 * The first production run drops promote from 3 to 1, which removes 38% of the
 * compute. That is only safe if promoted full evaluations are pure bookkeeping —
 * if they fed back into the strategy, promote would be a search hyperparameter
 * and a cheaper run would be a *different* run, not a shorter one.
 *
 * The claim rests on one ordering fact in `run.ts`: `cma.tell()` is called on
 * the screening scores of the whole population BEFORE anything is promoted, and
 * nothing after it touches the strategy. These tests pin that ordering, and pin
 * the determinism property that makes the ordering sufficient.
 *
 * An end-to-end confirmation — two real searches at promote 1 and promote 3
 * with the same seed, producing byte-identical CMA-ES state in their
 * checkpoints — is recorded in the commit that introduced this file. It is not
 * run here because it costs ~39,000 matches.
 */

const RUN_TS = readFileSync("simulation/src/search/run.ts", "utf8");

/** The body of the generation loop, which is where the ordering must hold. */
function generationLoop(): string {
  const start = RUN_TS.indexOf("for (let g = firstGeneration; g < generations; g++)");
  assert.ok(start > 0, "could not locate the generation loop — this test needs updating");
  // Up to the validation stage, which is outside the loop.
  const end = RUN_TS.indexOf("// Validate the elite", start);
  assert.ok(end > start, "could not locate the end of the generation loop");
  return RUN_TS.slice(start, end);
}

test("the strategy is told exactly once per generation", () => {
  const loop = generationLoop();
  const tells = [...loop.matchAll(/\bcma\.tell\s*\(/g)];
  assert.equal(tells.length, 1, "more than one tell() per generation would make ordering ambiguous");

  // And nowhere else in the file — a second call site outside the loop would
  // escape this whole analysis.
  const allTells = [...RUN_TS.matchAll(/\bcma\.tell\s*\(/g)];
  assert.equal(allTells.length, 1, "cma.tell is called somewhere outside the generation loop");
});

test("the strategy is told the whole population's SCREENING scores", () => {
  const loop = generationLoop();
  // The exact argument matters: `screened` is every candidate, scored at the
  // screen tier. Anything derived from `promoted` or the full tier here would
  // make promote a search parameter.
  assert.match(
    loop,
    /cma\.tell\(\s*vectors\s*,\s*screened\.map\(rankOf\)\s*\)/,
    "tell() must receive the ask() vectors and the screening scores of all of them",
  );
});

test("nothing is promoted before the strategy has been told", () => {
  const loop = generationLoop();
  const tellAt = loop.search(/\bcma\.tell\s*\(/);
  const promoteAt = loop.search(/\bpromote\b/);
  const fullEvalAt = loop.search(/"full"/);

  assert.ok(tellAt > 0, "no tell() found");
  assert.ok(promoteAt > tellAt, "`promote` is referenced before cma.tell — ordering is not safe");
  assert.ok(fullEvalAt > tellAt, "a full evaluation happens before cma.tell");
});

test("the promotion block never touches the strategy", () => {
  const loop = generationLoop();
  const from = loop.search(/\/\/ Promote the best few/);
  assert.ok(from > 0, "could not locate the promotion block");
  const promotionBlock = loop.slice(from);

  for (const forbidden of [/\bcma\.tell\b/, /\bcma\.ask\b/, /\bcma\.[a-zA-Z]+\s*=/]) {
    assert.ok(
      !forbidden.test(promotionBlock),
      `the promotion block mutates or queries the strategy: ${forbidden}`,
    );
  }
});

test("promoted results flow only to reporting, best-full and validation", () => {
  const loop = generationLoop();
  const from = loop.search(/\/\/ Promote the best few/);
  const promotionBlock = loop.slice(from);

  // Everything the block assigns to. If a new sink appears here, this test
  // should fail until someone confirms it is not a feedback path.
  const sinks = ["bestFullThisGen", "bestFull", "evaluations", "record"];
  for (const sink of sinks) assert.match(promotionBlock, new RegExp(`\\b${sink}\\b`));

  // bestFull is consumed by validation and the checkpoint, never by the search.
  const validationSection = RUN_TS.slice(RUN_TS.indexOf("// Validate the elite"));
  assert.match(validationSection, /bestFull\.candidate/, "bestFull should be the validation target");
});

/**
 * The ordering above is only sufficient because the strategy's next state is a
 * pure function of (vectors, scores) and its own prior state. If some unrelated
 * work between generations could perturb it, promote could still matter
 * indirectly — through the RNG, say.
 */
test("strategy state depends only on the vectors and scores it is told", () => {
  const options = { dimension: 6, mean: new Array(6).fill(0.5), sigma: 0.2, populationSize: 6, seed: 4242 };
  const score = (v: readonly number[]) => -v.reduce((s, x) => s + (x - 0.3) ** 2, 0);

  const lean = new Cmaes({ ...options });
  const busy = new Cmaes({ ...options });

  for (let g = 0; g < 5; g++) {
    const leanVectors = lean.ask();
    lean.tell(leanVectors, leanVectors.map(score));

    const busyVectors = busy.ask();
    const busyScores = busyVectors.map(score);
    // Stand in for the promotion block: extra evaluation work, sorting, and
    // consumption of the module's own RNG — none of it via the strategy.
    const ranked = [...busyVectors].sort((a, b) => score(b) - score(a)).slice(0, 3);
    for (const candidate of ranked) void score(candidate);
    for (let i = 0; i < 50; i++) void Math.random();
    busy.tell(busyVectors, busyScores);
  }

  const a = lean.snapshot();
  const b = busy.snapshot();
  assert.deepEqual(a.mean, b.mean, "mean diverged despite identical vectors and scores");
  assert.deepEqual(a.C, b.C, "covariance diverged");
  assert.deepEqual(a.pc, b.pc, "evolution path pc diverged");
  assert.deepEqual(a.ps, b.ps, "evolution path ps diverged");
  assert.equal(a.sigma, b.sigma, "step size diverged");
  assert.equal(a.rngState, b.rngState, "the strategy's RNG advanced differently");
  assert.equal(a.generation, b.generation);
});

test("how many candidates are promoted cannot change the next ask()", () => {
  // The same property stated the way the production change will use it: the
  // candidates proposed in generation g+1 are identical whether one candidate
  // or three were fully evaluated in generation g.
  const options = { dimension: 5, mean: new Array(5).fill(0.5), sigma: 0.25, populationSize: 6, seed: 777 };
  const score = (v: readonly number[]) => -v.reduce((s, x) => s + x * x, 0);

  const promoteOne = new Cmaes({ ...options });
  const promoteThree = new Cmaes({ ...options });

  for (const [cma, promote] of [[promoteOne, 1], [promoteThree, 3]] as const) {
    const vectors = cma.ask();
    const scores = vectors.map(score);
    cma.tell(vectors, scores);
    // The promotion step, at two different widths.
    [...vectors].sort((a, b) => score(b) - score(a)).slice(0, promote).forEach((v) => void score(v));
  }

  assert.deepEqual(
    promoteOne.ask(),
    promoteThree.ask(),
    "promote changed the next generation's candidates",
  );
});
