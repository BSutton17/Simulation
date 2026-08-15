import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkload, runWorkload, fingerprintOf } from "../simulation/src/perf/workload.js";
import { runSimulation } from "../simulation/src/runner.js";
import { abilityCoverage, totalAbilities } from "../simulation/src/fitness/index.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * Behavioural equivalence for AI performance work.
 *
 * The AI hot path is being optimised for speed, and the one thing that must not
 * change is what it decides. A faster controller that plays differently
 * invalidates every balance reading taken before it, silently — the numbers
 * still look reasonable, they just describe a different game.
 *
 * These tests are the guardrail. They are deliberately outcome-level rather
 * than unit-level: an optimisation can preserve every function's return value
 * and still change behaviour through evaluation order or allocation-driven
 * timing, and only replaying real matches catches that.
 */

/**
 * Fingerprint of a fixed workload — winners, end ticks and placements across
 * every match, in plan order.
 *
 * Recorded 2026-08-14 against the AI optimisation work (nested resolved-ability
 * cache, single-pass target amplification). It held identical across the
 * unoptimised source, the optimised source, tsx and compiled output.
 *
 * If this changes, something altered AI decisions or engine behaviour. That may
 * be legitimate — a balance change or a deliberate AI improvement will move it
 * — but it must never change as a side effect of an optimisation. Re-record it
 * in the same commit as the intended change, and say why in the message.
 */
const WORKLOAD_FINGERPRINT = "3ec181861c97925d";

const SMALL = { duelPairings: 2, ffa4Compositions: 1, ffa7Compositions: 1 };

test("a fixed workload replays to the same outcomes", () => {
  const jobs = buildWorkload(SMALL);
  assert.ok(jobs.length > 0, "the workload should not be empty");

  const first = runWorkload(jobs);
  const second = runWorkload(jobs);

  assert.equal(
    first.fingerprint,
    second.fingerprint,
    "the same workload produced different outcomes in the same process",
  );
  assert.equal(
    first.fingerprint,
    WORKLOAD_FINGERPRINT,
    "AI or engine behaviour changed — see the note on WORKLOAD_FINGERPRINT before re-recording",
  );
});

test("the outcome fingerprint is sensitive to what it is meant to catch", () => {
  // A digest that ignored the things it digests would pass the test above while
  // proving nothing.
  const base = ["m1|fire|900|1,2", "m2|water|800|2,1"];
  assert.notEqual(fingerprintOf(base), fingerprintOf(["m1|water|900|1,2", "m2|water|800|2,1"]), "winner ignored");
  assert.notEqual(fingerprintOf(base), fingerprintOf(["m1|fire|901|1,2", "m2|water|800|2,1"]), "end tick ignored");
  assert.notEqual(fingerprintOf(base), fingerprintOf(["m1|fire|900|2,1", "m2|water|800|2,1"]), "placements ignored");
  assert.notEqual(fingerprintOf(base), fingerprintOf([...base].reverse()), "order ignored");
});

/**
 * Ability coverage as a regression guard, not a target.
 *
 * Optimising the decision path could quietly narrow what the AI reaches for —
 * a cache keyed too coarsely, a filter that drops a branch — and coverage is
 * how that shows up. It is checked for collapse, not held to a number: the
 * sample here is small, and the standing decision is that coverage is a health
 * check rather than something to chase.
 */
test("performance work has not collapsed ability coverage", () => {
  const telemetry = [];
  for (let i = 0; i < KINGDOM_IDS.length; i += 2) {
    const result = runSimulation({
      matches: 2,
      seed: `coverage-guard-${i}`,
      players: [
        { kingdomId: KINGDOM_IDS[i]! },
        { kingdomId: KINGDOM_IDS[i + 1] ?? KINGDOM_IDS[0]! },
      ],
      telemetry: true,
    });
    telemetry.push(...result.records.map((r) => r.telemetry!));
  }

  const report = abilityCoverage(telemetry);
  assert.equal(report.total, totalAbilities());

  // The observed range across recent runs is 61-66 of 80 on samples this size.
  // A floor well below that catches a collapse without failing on the sampling
  // noise a 16-match sample carries.
  assert.ok(
    report.used >= 50,
    `ability coverage collapsed to ${report.used}/${report.total} — investigate before accepting the optimisation`,
  );

  // Every kingdom should still be doing something.
  const silent = report.byKingdom.filter((k) => k.used === 0);
  assert.deepEqual(silent.map((k) => k.kingdomId), [], "a kingdom stopped casting entirely");
});
