import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeadlessMatch } from "../simulation/src/headless.js";
import { mulberry32 } from "../simulation/src/rng.js";
import {
  ACTION_SIZE,
  ObservedHistory,
  actionName,
  knowledgeFor,
  orderEnemies,
  primaryActionOf,
  chargesToSpend,
  createMask,
  decide,
  legalActions,
  WAIT,
} from "../simulation/src/ai/index.js";

/**
 * Target ordering and action decoding.
 *
 * Ordering gets its own suite because it is the second place hidden information
 * can escape. The observation tests watch the sixty-four floats; nothing there
 * would notice a sort key that reads enemy HP, because the leak would show up
 * as WHICH enemy occupies slot 14 rather than as a changed number.
 */

function setup(kingdoms = ["water", "fire", "earth", "ice"] as const) {
  const match = createHeadlessMatch(
    kingdoms.map((kingdomId) => ({ kingdomId })),
    { rng: mulberry32(777) },
  );
  const state = match.gameState!;
  const players = state.getPlayers();
  const me = players[0]!;
  const history = new ObservedHistory();
  const order = (): string[] =>
    orderEnemies(knowledgeFor(match, me, history)).map((e) => e.kingdomId);
  return { match, state, me, players, history, order };
}

test("hidden enemy HP and gold never reorder target slots", () => {
  const { players, order } = setup();
  const before = order();
  players[1]!.castle.hp = 1;
  players[2]!.castle.hp = 9999;
  players[3]!.economy.currency = 50_000;
  players[1]!.economy.currency = 0;
  assert.deepEqual(
    order(),
    before,
    "the ordering key is reading hidden state — see actions.ts",
  );
});

test("an enemy aiming at me is promoted to the front", () => {
  const { me, players, order } = setup();
  const before = order();
  const aggressor = players[2]!;
  assert.notEqual(before[0], aggressor.kingdomId, "fixture would not prove anything");
  aggressor.target = me.id;
  assert.equal(order()[0], aggressor.kingdomId);
});

test("damage I have dealt promotes an enemy, below aggressors", () => {
  const { match, me, players, history, order } = setup();
  const prey = players[3]!;
  history.observe(me.id, {
    type: "damage",
    tick: 10,
    sourceId: me.id,
    targetId: prey.id,
    amount: 900,
    absorbedByShield: 0,
    dealtToHp: 900,
    overkill: 0,
    crit: false,
    cause: "ability",
  });
  assert.equal(order()[0], prey.kingdomId, "the wounded enemy should lead");

  // …but an aggressor still outranks them.
  players[1]!.target = me.id;
  assert.equal(order()[0], players[1]!.kingdomId);
  assert.equal(order()[1], prey.kingdomId);
  void match;
});

test("eliminated enemies leave the ordering", () => {
  const { players, order } = setup();
  assert.equal(order().length, 3);
  players[1]!.eliminated = true;
  const after = order();
  assert.equal(after.length, 2);
  assert.ok(!after.includes(players[1]!.kingdomId));
});

test("ordering is stable and deterministic across repeated calls", () => {
  const { order } = setup();
  assert.deepEqual(order(), order());
  assert.deepEqual(order(), order());
});

// ── decoding ────────────────────────────────────────────────────────────

test("decode never chooses an illegal head", () => {
  const outputs = new Float32Array(ACTION_SIZE).fill(1);
  const mask = createMask();
  mask[WAIT] = 1;
  mask[3] = 1; // one arbitrary cast slot
  const decision = decide(outputs, mask);
  assert.ok(
    decision.primaryIndex === 3 || decision.primaryIndex === WAIT,
    `chose ${actionName(decision.primaryIndex)}, which was not legal`,
  );
});

test("decode falls back to WAIT when nothing else is legal", () => {
  const outputs = new Float32Array(ACTION_SIZE).fill(5);
  const mask = createMask();
  mask[WAIT] = 1;
  const decision = decide(outputs, mask);
  assert.equal(decision.primary.kind, "wait");
  assert.equal(decision.retargetSlot, null);
});

test("the switch gate suppresses retargeting", () => {
  const outputs = new Float32Array(ACTION_SIZE);
  const mask = createMask();
  mask[WAIT] = 1;
  mask[14] = 1;
  mask[20] = 1;

  outputs[20] = -1; // gate closed
  assert.equal(decide(outputs, mask).retargetSlot, null);

  outputs[20] = 1; // gate open
  assert.equal(decide(outputs, mask).retargetSlot, 0);
});

test("decode is deterministic and breaks ties toward the lower index", () => {
  const outputs = new Float32Array(ACTION_SIZE).fill(0.5);
  const mask = createMask();
  mask[WAIT] = 1;
  mask[2] = 1;
  mask[7] = 1;
  const first = decide(outputs, mask);
  assert.equal(first.primaryIndex, 2);
  assert.equal(decide(outputs, mask).primaryIndex, first.primaryIndex);
});

test("charges are never spent beyond what is available or affordable", () => {
  const outputs = new Float32Array(ACTION_SIZE);
  outputs[21] = 10; // saturate the charge head
  const mask = createMask();
  mask[WAIT] = 1;
  mask[21] = 1;
  const fraction = decide(outputs, mask).chargeFraction;
  assert.ok(fraction !== null && fraction > 0.99);

  // Regenerated charges cap it...
  assert.equal(chargesToSpend(fraction, 3, 100, 100_000), 3);
  // ...and so does the treasury, because the engine bills per charge.
  assert.equal(chargesToSpend(fraction, 3, 100, 250), 2);
  // At least one, since the cast itself was already approved as affordable.
  assert.equal(chargesToSpend(fraction, 3, 100, 0), 1);
  // Nothing regenerated means no charge cast at all.
  assert.equal(chargesToSpend(fraction, 0, 100, 100_000), undefined);
  // A masked-off head never spends.
  assert.equal(chargesToSpend(null, 3, 100, 100_000), undefined);
});

test("the action layout is exactly 22 heads and maps cleanly", () => {
  assert.equal(ACTION_SIZE, 22);
  assert.equal(primaryActionOf(0).kind, "cast");
  assert.equal(primaryActionOf(4).kind, "cast");
  assert.equal(primaryActionOf(5).kind, "invest");
  assert.equal(primaryActionOf(9).kind, "invest");
  assert.equal(primaryActionOf(10).kind, "buyCitizen");
  assert.equal(primaryActionOf(11).kind, "repair");
  assert.equal(primaryActionOf(12).kind, "buyShield");
  assert.equal(primaryActionOf(13).kind, "wait");
  assert.equal(actionName(14), "target[0]");
  assert.equal(actionName(20), "switchGate");
  assert.equal(actionName(21), "chargeFraction");
});

test("a wrong-sized output vector is refused", () => {
  const mask = createMask();
  mask[WAIT] = 1;
  assert.throws(() => decide(new Float32Array(8), mask), /must be 22/);
});

test("legalActions refuses a wrong-sized mask", () => {
  const { match, me, history } = setup();
  const knowledge = knowledgeFor(match, me, history);
  assert.throws(() => legalActions(knowledge, new Uint8Array(4)), /must be 22/);
});
