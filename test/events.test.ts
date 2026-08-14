import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { tickMatch } from "../src/engine/tick.js";
import {
  buyCitizen,
  buyShield,
  repairCastle,
  unlockOrUpgradeAbility,
} from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import type { GameplayEvent } from "../src/engine/events.js";
import type { MatchPlayer } from "../src/match/types.js";
import { FIREBALL, SCORCHING_SUN, FIRENADO, BLAZING_DETERMINATION } from "../src/data/fireAbilities.js";
import { RIPTIDE } from "../src/data/waterAbilities.js";
import { mulberry32 } from "../simulation/src/rng.js";
import { runSimulation } from "../simulation/src/index.js";
import type { SimulationObserver } from "../simulation/src/index.js";

/**
 * Ticket #204 — the gameplay event framework: every significant gameplay
 * occurrence publishes a typed event, and emission never affects gameplay.
 */

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: null,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function arena(seed = 7) {
  const match = new Match("EVNT", { rng: mulberry32(seed) });
  match.addPlayer(player("a", "fire"));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;
  earn(a, 100_000);
  earn(b, 100_000);
  const events: GameplayEvent[] = [];
  state.events.on((e) => events.push(e));
  const ofType = <T extends GameplayEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<GameplayEvent, { type: T }> => e.type === type);
  return { match, state, a, b, events, ofType };
}

test("casts publish abilityCast and damage with full breakdowns", () => {
  const { match, a, ofType } = arena();

  const r = activateAbility(match, a, FIREBALL, { targetId: "b" });
  assert.equal(r.ok, true);

  const casts = ofType("abilityCast");
  assert.equal(casts.length, 1);
  assert.deepEqual(casts[0], {
    type: "abilityCast",
    tick: match.tick,
    casterId: "a",
    abilityId: "fireball",
    targetIds: ["b"],
    cost: 100,
    chargesUsed: undefined,
  });

  const hits = ofType("damage");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.sourceId, "a");
  assert.equal(hits[0]!.targetId, "b");
  assert.equal(hits[0]!.cause, "fireball");
  assert.equal(hits[0]!.element, "fire");
  assert.equal(hits[0]!.amount, hits[0]!.absorbedByShield + hits[0]!.dealtToHp);
  assert.ok(hits[0]!.dealtToHp > 0);
});

test("statuses publish on apply, tick (DoT), and expiry", () => {
  const { match, a, b, ofType } = arena();

  // Firenado, not Scorching Sun: Scorching Sun IGNITES now (a mark that rolls
  // for a burn later), so it is no longer the ability that demonstrates a
  // straightforward apply → tick → expire lifecycle.
  activateAbility(match, a, FIRENADO, { targetId: "b" });
  const applied = ofType("statusApplied");
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.statusId, "burn");
  assert.equal(applied[0]!.targetId, "b");
  assert.equal(applied[0]!.sourceId, "a");
  assert.ok(applied[0]!.durationTicks > 0);

  // Run the burn out: DoT damage events accrue, then the status expires.
  const duration = b.statuses.find((s) => s.id === "burn")!.remainingTicks;
  for (let t = 1; t <= duration + 1; t++) tickMatch(match, t);

  const dots = ofType("damage").filter((e) => e.cause === "status:burn");
  assert.ok(dots.length > 0, "expected burn DoT damage events");
  assert.equal(dots[0]!.sourceId, "a"); // attributed to the burner

  const expired = ofType("statusExpired").filter((e) => e.statusId === "burn");
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.playerId, "b");
});

test("a usage-exhausted buff (Blazing Determination) reports statusExpired when consumed", () => {
  const { match, a, ofType } = arena();

  // Apply the one-shot damage buff to self.
  const buff = activateAbility(match, a, BLAZING_DETERMINATION, {});
  assert.equal(buff.ok, true);
  assert.ok(ofType("statusApplied").some((e) => e.statusId === "blazingDetermination"));
  assert.equal(
    ofType("statusExpired").filter((e) => e.statusId === "blazingDetermination").length,
    0, // not gone yet — it ends by being USED, not by timing out
  );

  // Spend it on the next attack: the buff is consumed and pruned, which must now
  // publish statusExpired so VFX/replays learn the buff ended.
  const hit = activateAbility(match, a, FIREBALL, { targetId: "b" });
  assert.equal(hit.ok, true);

  const expired = ofType("statusExpired").filter((e) => e.statusId === "blazingDetermination");
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.playerId, "a");
});

test("heals publish with the actual amount restored", () => {
  const { match, b, ofType } = arena();
  b.castle.hp = 9_900; // only 100 missing; Riptide restores 50% max

  const r = activateAbility(match, b, RIPTIDE, {});
  assert.equal(r.ok, true);
  const heals = ofType("heal");
  assert.equal(heals.length, 1);
  assert.equal(heals[0]!.targetId, "b");
  assert.equal(heals[0]!.amount, 100); // clamped to what was actually healed
  assert.equal(heals[0]!.cause, "riptide");
});

test("economy purchases publish purchase / citizensChanged / shieldGained / heal", () => {
  const { match, a, ofType } = arena();

  buyCitizen(match, a);
  assert.deepEqual(ofType("purchase")[0], {
    type: "purchase",
    tick: match.tick,
    playerId: "a",
    kind: "citizen",
    cost: 25,
  });
  assert.equal(ofType("citizensChanged")[0]!.delta, 1);
  assert.equal(ofType("citizensChanged")[0]!.total, 11);

  buyShield(match, a);
  const shield = ofType("shieldGained")[0]!;
  assert.equal(shield.amount, 1750);
  assert.equal(shield.total, 1750);
  assert.equal(shield.cause, "purchase");

  a.castle.hp = 5_000;
  repairCastle(match, a);
  assert.ok(ofType("purchase").some((e) => e.kind === "repair" && e.cost === 500));
  assert.ok(ofType("heal").some((e) => e.cause === "repair" && e.amount === 1000));

  unlockOrUpgradeAbility(match, a, "fireball");
  const unlock = ofType("purchase").find((e) => e.kind === "unlock")!;
  assert.equal(unlock.itemId, "fireball");
  assert.equal(unlock.cost, 50);
});

test("cooldown completion and eliminations publish through the tick loop", () => {
  const { match, a, b, ofType } = arena();

  activateAbility(match, a, FIREBALL, { targetId: "b" });
  const cooldown = a.cooldowns["fireball"]!;
  for (let t = 1; t <= cooldown; t++) tickMatch(match, t);
  const ready = ofType("cooldownReady");
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0], {
    type: "cooldownReady",
    tick: cooldown,
    playerId: "a",
    abilityId: "fireball",
  });

  // A killing blow: eliminated + matchEnded (2-player match) both publish.
  b.castle.hp = 1;
  activateAbility(match, a, FIREBALL, { targetId: "b" });
  tickMatch(match, cooldown + 1);
  assert.equal(ofType("eliminated")[0]!.playerId, "b");
  assert.deepEqual(ofType("matchEnded")[0], {
    type: "matchEnded",
    tick: cooldown + 1,
    winnerId: "a",
  });
});

test("emission never affects gameplay: monitored and silent matches are identical", () => {
  const play = (listen: boolean) => {
    const match = new Match("PURE", { rng: mulberry32(99) });
    match.addPlayer(player("a", "fire"));
    match.addPlayer(player("b", "water"));
    match.hostId = "a";
    match.start(createMatchConfig(match));
    const state = match.gameState!;
    const a = state.getPlayer("a")!;
    earn(a, 100_000);
    if (listen) {
      // A listener that also throws — even a broken observer must not leak
      // into gameplay.
      state.events.on(() => {
        throw new Error("misbehaving observer");
      });
    }
    for (let t = 1; t <= 60; t++) {
      if (t % 5 === 0) {
        a.cooldowns = {};
        activateAbility(match, a, SCORCHING_SUN, { targetId: "b" });
      }
      tickMatch(match, t);
    }
    const b = state.getPlayer("b")!;
    return {
      hpB: b.castle.hp,
      statuses: b.statuses.map((s) => ({ id: s.id, remainingTicks: s.remainingTicks, stacks: s.stacks })),
      currencyA: a.economy.currency,
    };
  };

  assert.deepEqual(play(true), play(false));
});

test("simulation observers receive the event stream", () => {
  const counts = new Map<string, number>();
  const observer: SimulationObserver = {
    onEvent: (e) => counts.set(e.type, (counts.get(e.type) ?? 0) + 1),
  };
  const result = runSimulation({
    matches: 1,
    seed: 404,
    players: [{ kingdomId: "fire" }, { kingdomId: "water" }],
    observers: [observer],
  });

  assert.equal(result.records[0]!.timedOut, false);
  // A full match must have produced the core event families.
  for (const type of [
    "abilityCast",
    "damage",
    "purchase",
    "citizensChanged",
    "cooldownReady",
    "eliminated",
    "matchEnded",
  ]) {
    assert.ok((counts.get(type) ?? 0) > 0, `expected ${type} events`);
  }
});
