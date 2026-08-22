import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_VERSION,
  MODEL_FORMAT_VERSION,
  ModelCompatibilityError,
  OBSERVATION_VERSION,
  assertModelCompatible,
  modelMismatches,
  observationSpecHash,
  runtimeIdentity,
  visibilitySpecHash,
  type AiModel,
} from "../simulation/src/ai/index.js";

/**
 * Version identity and its refusal.
 *
 * A model is a set of weights on SPECIFIC input and output indices. Changing
 * what input 31 means does not degrade an old model, it turns it into a
 * different function reading the same sixty-four numbers — one that plays
 * confidently and wrongly with nothing raising an error. So loading is a gate,
 * not a best effort.
 */

function model(overrides: Partial<AiModel["identity"]> = {}): AiModel {
  return {
    formatVersion: MODEL_FORMAT_VERSION,
    kind: "elementals.ai.model",
    difficulty: "hard",
    identity: {
      ...runtimeIdentity(),
      engineSha: "36d9ce3eb0",
      engineDirty: false,
      balanceConfigHash: "baseline",
      balanceBaselineHash: "abcd1234",
      kingdomCount: 16,
      ...overrides,
    },
    training: {
      seed: 20260817,
      generation: 0,
      fitnessVersion: "v0",
      trainedAt: "2026-08-17T00:00:00.000Z",
    },
    genome: null,
  };
}

test("a matching model loads", () => {
  assert.deepEqual(modelMismatches(model()), []);
  assert.doesNotThrow(() => assertModelCompatible(model()));
});

test("a stale observation version is refused, and named", () => {
  const stale = model({ observationVersion: "v0" });
  assert.throws(
    () => assertModelCompatible(stale),
    (error: Error) => {
      assert.ok(error instanceof ModelCompatibilityError);
      // Built from the constant so a schema bump does not break a test that
      // is about the REFUSAL, not about which version is current.
      assert.match(
        error.message,
        new RegExp(`observationVersion: v0 -> ${OBSERVATION_VERSION}`),
      );
      return true;
    },
  );
});

test("a stale action version is refused", () => {
  assert.throws(() => assertModelCompatible(model({ actionVersion: "v0" })), /actionVersion/);
});

test("balance and engine identity are refused when the caller supplies them", () => {
  // `ai/` deliberately does not import the provenance machinery, so the caller
  // passes what it knows. Both balance hashes are checked, because they catch
  // different mistakes: a different candidate, and an uncommitted src/data edit.
  const mismatches = modelMismatches(model(), {
    engineSha: "deadbeef",
    balanceConfigHash: "other",
    balanceBaselineHash: "changed",
  });
  assert.equal(mismatches.length, 3);
  assert.ok(mismatches.some((m) => m.startsWith("engineSha")));
  assert.ok(mismatches.some((m) => m.startsWith("balanceConfigHash")));
  assert.ok(mismatches.some((m) => m.startsWith("balanceBaselineHash")));
});

test("a wrong envelope version is refused", () => {
  const wrong = { ...model(), formatVersion: 99 } as AiModel;
  assert.throws(() => assertModelCompatible(wrong), /formatVersion/);
});

test("kingdom count is part of identity", () => {
  // A seventeenth kingdom changes what the five kit slots mean.
  assert.deepEqual(modelMismatches(model(), { kingdomCount: 17 }), [
    "kingdomCount: 16 -> 17",
  ]);
});

/**
 * The pin.
 *
 * These hashes cover the observation layout AND the visibility rule. Widening
 * what a seat may see changes `visibilitySpecHash`, which changes
 * `observationSpecHash`, which fails here — forcing a deliberate
 * OBSERVATION_VERSION bump instead of a silent change. That is the whole
 * mechanism turning "remember to bump the version" into something enforced.
 *
 * If this test fails: decide whether the change was intended. If it was, bump
 * OBSERVATION_VERSION and update these constants in the same commit.
 */
test("the observation and action specifications are pinned", () => {
  // OBSERVATION v2 added sixteen kingdom-identity inputs (64 -> 80). Without
  // them one network played all sixteen kingdoms with no way to tell which it
  // was in, so every per-kingdom strategy had to be averaged into a single
  // generic policy. Visibility is UNCHANGED — the bot sees no more than before,
  // it just knows whose kit it is holding.
  //
  // ACTION v2 added three auxiliary heads (22 -> 25) so the space could
  // describe payloads it previously could not: Air's multi-target spread,
  // Love's BFFS partner and Dark's declared choice. Those abilities were
  // refused by `legality.ts` at ANY price while the heads could not express
  // them, which no balance change could ever fix.
  //
  // ⚠️ BOTH BUMPS INVALIDATE TRAINED MODELS, and that is the point of pinning
  // them: a 22-output network cannot drive a 25-head space, and loading one
  // must fail loudly rather than silently misalign.
  assert.equal(OBSERVATION_VERSION, "v2");
  assert.equal(ACTION_VERSION, "v2");
  assert.equal(
    visibilitySpecHash(),
    "920dc078",
    "the visibility rule changed — a seat may now see something different",
  );
  assert.equal(
    observationSpecHash(),
    "36645ab0",
    "the observation contract changed — trained models are no longer valid",
  );
});
