import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { FIRENADO } from "../src/data/fireAbilities.js";
import { FLOOD_OF_FROST } from "../src/data/iceAbilities.js";
import { NATURAL_TERRAIN } from "../src/data/earthAbilities.js";
import type { MatchPlayer } from "../src/match/types.js";
import { mulberry32 } from "../simulation/src/rng.js";

/**
 * Ticket #203 — deterministic match execution: a match-level seeded RNG feeds
 * every gameplay system that rolls dice, and engine-generated ids no longer
 * embed Math.random / Date.now. Identical seeds ⇒ identical matches.
 */

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: null,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** A started attacker-vs-water match with the given match-level RNG seed. */
function seededMatch(seed: number, kingdomA = "fire") {
  const match = new Match("DTRM", { rng: mulberry32(seed) });
  match.addPlayer(player("a", kingdomA));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;
  earn(a, 100_000);
  earn(b, 100_000);
  return { match, a, b };
}

/**
 * A chance-heavy scripted scenario, cast WITHOUT pinning options.rng — every
 * roll (crits, Flood of Frost's 35% Chilling Retribution, AfterShock-style
 * procs) must come from the match-level RNG. Returns a full deterministic
 * projection.
 *
 * ICE rather than Fire: this scenario needs an ability whose effect is decided
 * by a coin flip on every cast, and Fire no longer has one — Firenado's Burn
 * is guaranteed now, and Scorching Sun's Ignited rolls on a fifteen-second
 * cadence rather than per cast. Ten independent 35% rolls is what makes two
 * different seeds reliably diverge; a 5% crit chance alone does not.
 */
function runScripted(seed: number) {
  const { match, a, b } = seededMatch(seed, "ice");
  const procs: number[] = [];

  for (let i = 0; i < 10; i++) {
    a.cooldowns = {}; // isolate the dice from cooldown pacing
    const r = activateAbility(match, a, FLOOD_OF_FROST, { targetId: "b" });
    assert.equal(r.ok, true);
    procs.push(b.statuses.some((s) => s.id === "chillingRetribution") ? 1 : 0);
    b.castle.hp = Math.max(b.castle.hp, 5000); // keep the target alive: we are
    // testing dice streams here, not lethality
    tickMatch(match, i + 1); // DoT ticks + expiries also draw from match.rng
  }

  // A buff-granting utility: its engine-generated modifier id must be
  // deterministic too (previously salted with Date.now/Math.random).
  activateAbility(match, b, NATURAL_TERRAIN, {});

  return {
    procs,
    hpB: b.castle.hp,
    hpA: a.castle.hp,
    currencyA: a.economy.currency,
    statusesB: b.statuses.map((s) => ({ id: s.id, remainingTicks: s.remainingTicks, stacks: s.stacks })),
    modifierIdsB: b.modifiers.map((m) => m.id),
    modifierIdsA: a.modifiers.map((m) => m.id),
  };
}

test("identical seeds produce identical matches, ids included", () => {
  const first = runScripted(12345);
  const second = runScripted(12345);
  assert.deepEqual(first, second);
});

test("different seeds produce different outcomes", () => {
  const a = runScripted(1);
  const b = runScripted(2);
  // 16 casts of a 50% proc plus crit rolls — different streams must diverge.
  assert.notDeepEqual(a, b);
});

test("live matches keep working with the default RNG (Math.random)", () => {
  const match = new Match("LIVE"); // no rng option — the live construction path
  match.addPlayer(player("a", "fire"));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  earn(a, 1000);

  const r = activateAbility(match, a, FIRENADO, { targetId: "b" });
  assert.equal(r.ok, true);
  assert.ok(match.gameState!.getPlayer("b")!.castle.hp < 10_000);
});
