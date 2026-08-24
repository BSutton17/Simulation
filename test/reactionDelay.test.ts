import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { earn } from "../src/engine/money.js";
import { activateAbility } from "../src/engine/abilities.js";
import { tickMatch } from "../src/engine/tick.js";
import { TICK } from "../src/data/balance.js";
import { OLD_FRIENDS } from "../src/data/kitsuneAbilities.js";
import { NetworkController } from "../simulation/src/ai/controller.js";
import { buildNetwork } from "../simulation/src/neat/index.js";
import { readFileSync } from "node:fs";
import type { MatchPlayer } from "../src/match/types.js";

/**
 * A bot takes a human moment to notice a threat before answering it.
 *
 * ⚠️ ANSWERING ON THE TICK IT LANDS REFUNDS WHAT THESE ABILITIES COST. Roulette,
 * the Slot Machine, Creepy Crawlers, Fireflies, Old Friends and Light Show all
 * charge a moment of ATTENTION, and a reaction with no delay pays none of it.
 */

const MIN = Math.round(0.5 * TICK.RATE);
const MAX = Math.round(1.5 * TICK.RATE);
/** A decision runs every `DEFAULT_DECISION_PERIOD` ticks, so answers land on that grid. */
const CADENCE = 5;

/** Ticks between the siege landing and the shield going up, or -1. */
function ticksToAnswer(seed: number, gold: number, topUpAt = -1): number {
  const match = new Match("R1");
  for (const [id, kingdomId] of [["p0", "kitsune"], ["p1", "fire"]] as const) {
    match.addPlayer({ id, socketId: null, name: id, kingdomId, ready: true, connected: true } as never as MatchPlayer);
  }
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const caster = state.getPlayer("p0")!;
  const victim = state.getPlayer("p1")!;
  earn(caster, 50_000);
  earn(victim, gold);
  caster.unlocked["oldFriends"] = true;

  let r = seed;
  const rng = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const controller = new NetworkController(victim, {
    network: buildNetwork(JSON.parse(readFileSync("models/hard.json", "utf8")).genome), rng, difficulty: "hard",
  });

  let tick = 1000;
  match.tick = tick;
  activateAbility(match, caster, OLD_FRIENDS, { targetId: "p1" });
  for (let i = 0; i < 300; i++) {
    if (i === topUpAt) earn(victim, 2000);
    controller.act({ match, player: victim, tick, rng } as never);
    if (match.phase === "active") tickMatch(match, tick);
    if (victim.castle.shield > 0) return i;
    tick += 1;
    match.tick = tick;
  }
  return -1;
}

test("a threat is answered after a human pause, not on the tick it lands", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const answers = seeds.map((s) => ticksToAnswer(s, 2_000));

  for (const [i, at] of answers.entries()) {
    assert.ok(at >= 0, `seed ${seeds[i]} never answered at all`);
    assert.ok(at >= MIN, `seed ${seeds[i]} answered in ${at} ticks, faster than the ${MIN}-tick floor`);
    assert.ok(at <= MAX + CADENCE, `seed ${seeds[i]} took ${at} ticks, past ${MAX} plus one decision`);
  }
  // A fixed delay would be as inhuman as none at all.
  assert.ok(new Set(answers).size > 1, "the pause must vary between occurrences");
});

test("a seat that could not afford the answer is not made to wait twice", () => {
  // It has already been delayed by circumstance. Given 2000 gold at tick 200,
  // it must shield at the next decision rather than sit out a fresh pause.
  for (const seed of [1, 2, 3, 4]) {
    const at = ticksToAnswer(seed, 0, 200);
    assert.ok(at >= 200, `seed ${seed} shielded at ${at}, before it could afford one`);
    assert.ok(at <= 200 + CADENCE, `seed ${seed} waited until ${at}, a delay it should have been spared`);
  }
});

test("the pause never costs the seat the defence it committed to", () => {
  // ⚠️ THE FIRST VERSION OF THIS DID. A seat holding 2001 gold spent down to 240
  // against a 300 shield while its 1.5 s reaction ran, and never defended at
  // all — the delay had quietly cancelled the answer. Gold for a committed
  // response is reserved, so every seed above answers.
  const answers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => ticksToAnswer(s, 2_000));
  assert.equal(answers.filter((a) => a < 0).length, 0, "every seat must still answer");
});
