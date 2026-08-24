import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreScenario, DEFAULT_FITNESS, maxScore } from "../simulation/src/training/fitness.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * Saving up is worth something, scaled to what the kingdom's own kit costs.
 *
 * ⚠️ NOTHING PAID FOR SAVING AND FIVE TERMS PAID FOR SPENDING — activity counts
 * casts, variety distinct abilities, combo sequences, ultimate reaching one,
 * resource shields and repairs. Measured across all sixteen kingdoms in a duel,
 * median holdings were 42-96 gold against dearest abilities of 300-1345: NOT
 * ONE kingdom could ever afford its own most expensive ability.
 */

function combat(peakCurrency?: number) {
  return {
    casts: 20, abilitiesUsed: new Set(["waterBall"]), castSequence: ["waterBall"],
    exemptCasts: new Set<number>(), damageDealt: 5_000, damageReceived: 5_000,
    shieldAbsorbed: 0, kills: 1, healingReceived: 0, shieldedVsLightShow: 0,
    volcanoDamage: 0, volcanoShare: 0, siegesLifted: 0, debtsCleared: 0, debtPromptness: 0,
    ...(peakCurrency === undefined ? {} : { peakCurrency }),
  };
}
function context(kingdom: string, peakCurrency?: number) {
  return {
    scenarioId: "x", format: "duel", seats: 2, kingdom, seat: 0, combat: combat(peakCurrency),
    behaviour: {
      casts: 20, invests: 3, citizens: 5, repairs: 1, shields: 1, retargets: 2, waits: 10,
      decisions: 100, forcedWaits: 0, distinctAbilities: 2, kitSize: 5,
      castSequence: ["waterBall"], exemptCasts: new Set<number>(), ultimateCasts: 0,
    },
  };
}
const record = {
  index: 0, seed: 1, winnerId: "p0", winnerKingdom: "water", endedAtTick: 500, timedOut: false,
  players: [
    { id: "p0", name: "p0", kingdomId: "water", hp: 9_000, shield: 0, citizens: 10, currency: 500, eliminatedAtTick: null },
    { id: "p1", name: "p1", kingdomId: "fire", hp: 0, shield: 0, citizens: 10, currency: 0, eliminatedAtTick: 500 },
  ],
};
const liquidityOf = (kingdom: string, peak?: number): number =>
  (scoreScenario(record as never, "p0", context(kingdom, peak) as never, DEFAULT_FITNESS) as unknown as {
    terms: Record<string, number>;
  }).terms.liquidity!;

test("saving more pays more, up to what the kingdom's dearest ability costs", () => {
  assert.equal(liquidityOf("water", 0), 0);
  assert.ok(liquidityOf("water", 700) > liquidityOf("water", 200));
  assert.ok(liquidityOf("water", 1345) > liquidityOf("water", 700));
});

test("hoarding past the dearest ability pays nothing extra", () => {
  // Otherwise the term would reward a turtle that banks and never plays.
  const dearest = Math.max(
    ...abilitiesForKingdom("water" as never).filter((a) => a.kind !== "passive").map((a) => a.cost),
  );
  assert.equal(liquidityOf("water", dearest), liquidityOf("water", dearest * 10));
  assert.equal(liquidityOf("water", dearest), DEFAULT_FITNESS.liquidityWeight);
});

test("it is scaled per kingdom, not a flat number", () => {
  // ⚠️ A FLAT TARGET WOULD MEAN DIFFERENT THINGS. Light's dearest ability is
  // 340 and Water's 1345, so one figure would ask Light to save a little and
  // Water to save four times as much for the same reward.
  const same = 400;
  assert.ok(
    liquidityOf("light", same) > liquidityOf("water", same),
    "400 gold should go further for a kingdom with a cheaper kit",
  );
});

test("a context without the tally scores zero rather than NaN", () => {
  // A silent NaN propagates into selection and is invisible until a run stalls.
  const value = liquidityOf("water", undefined);
  assert.equal(value, 0);
  assert.ok(Number.isFinite(value));
});

test("the term is counted in the score and in the ceiling", () => {
  // It was added to the breakdown but not to the sum once already, so it was
  // computed and thrown away — a reward that could never change any decision.
  const withNone = scoreScenario(record as never, "p0", context("water", 0) as never, DEFAULT_FITNESS);
  const withLots = scoreScenario(record as never, "p0", context("water", 999_999) as never, DEFAULT_FITNESS);
  assert.ok(withLots.score > withNone.score, "saving must move the total score");
  assert.ok(maxScore(DEFAULT_FITNESS) >= withLots.score, "the ceiling must cover it");
});

test("winning still outweighs every shaping term combined", () => {
  const f = DEFAULT_FITNESS;
  const shaping =
    f.placementWeight + f.survivalWeight + f.combatWeight + f.activityWeight + f.varietyWeight +
    f.comboWeight + f.ultimateWeight + f.defenseWeight + f.resourceWeight + f.liquidityWeight;
  assert.ok(shaping < f.winWeight, `shaping ${shaping} must stay under winWeight ${f.winWeight}`);
});

test("every kingdom has a dearest ability the term can scale against", () => {
  for (const k of KINGDOM_IDS) {
    const kit = abilitiesForKingdom(k).filter((a) => a.kind !== "passive");
    assert.ok(kit.length > 0, `${k} has no castable abilities`);
    assert.ok(Math.max(...kit.map((a) => a.cost)) > 0, `${k} has no priced ability`);
  }
});
