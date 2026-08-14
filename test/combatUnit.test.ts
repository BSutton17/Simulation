import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDamage } from "../src/engine/damage.js";
import { applyDamage } from "../src/engine/combat.js";
import { addModifier, tickModifiers } from "../src/engine/modifiers.js";
import { applyStatus, hasStatus, getStatus, tickStatuses } from "../src/engine/status.js";
import { setCooldown, getCooldown, isReady, tickCooldowns } from "../src/engine/cooldowns.js";
import { selectTarget } from "../src/engine/targeting.js";
import { TARGETING } from "../src/data/balance.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * T5.1 — combat framework unit tests: each combat subsystem (damage, modifiers,
 * statuses, targeting, cooldowns, combo container) behaves correctly on its own
 * and stays independent of its neighbors. Complements the per-ticket suites
 * (damage/combat/targeting/abilities .test.ts) with cross-subsystem isolation
 * checks. NOTE: combo *logic* has no engine yet — only its container is
 * asserted here; full combo tests arrive with that ticket.
 */

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

function activeMatch(): { match: Match; a: PlayerState; b: PlayerState; c: PlayerState } {
  const match = new Match("1234");
  for (const id of ["a", "b", "c"]) match.addPlayer(player(id));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  return { match, a: gs.getPlayer("a")!, b: gs.getPlayer("b")!, c: gs.getPlayer("c")! };
}

test("damage calculation is independent of the defender's statuses and cooldowns", () => {
  const { match, a, b } = activeMatch();
  applyStatus(b, { id: "burn", category: "debuff", stacking: "refresh" }, { sourceId: "a", durationTicks: 100 });
  setCooldown(b, "fireball", 50);

  // Neither the status nor the cooldown changes the pure damage math.
  assert.equal(resolveDamage(a, b, 250, { forceCrit: false }).amount, 250);
});

test("a temporary damage buff expires on schedule and stops affecting damage", () => {
  const { match, a, b } = activeMatch();
  addModifier(a, { id: "surge", stat: "damage", op: "mult", value: 2, sourceId: "a", remainingTicks: 3 });

  assert.equal(resolveDamage(a, b, 100, { forceCrit: false }).amount, 200);
  for (let i = 0; i < 3; i++) tickModifiers(match.gameState!);
  assert.equal(resolveDamage(a, b, 100, { forceCrit: false }).amount, 100);
});

test("modifiers on different stats never interfere", () => {
  const { match, a, b } = activeMatch();
  addModifier(a, { id: "i", stat: "income", op: "mult", value: 5, sourceId: "a", remainingTicks: null });
  addModifier(a, { id: "c", stat: "critChance", op: "add", value: -1, sourceId: "a", remainingTicks: null });

  // Neither income nor critChance modifiers touch the "damage" stat.
  assert.equal(resolveDamage(a, b, 100, { forceCrit: false }).amount, 100);
});

test("status stacking respects its cap while damage and cooldowns proceed", () => {
  const { match, a } = activeMatch();
  const def = { id: "venom", category: "debuff" as const, stacking: "stack" as const, maxStacks: 3 };
  for (let i = 0; i < 5; i++) applyStatus(a, def, { sourceId: "b", durationTicks: 10 });
  assert.equal(getStatus(a, "venom")!.stacks, 3); // capped

  applyDamage(a, 500); // damage does not disturb statuses
  assert.equal(hasStatus(a, "venom"), true);
});

test("statuses and cooldowns tick independently of each other", () => {
  const { match, a } = activeMatch();
  const state = match.gameState!;
  applyStatus(a, { id: "chill", category: "debuff", stacking: "refresh" }, { sourceId: "b", durationTicks: 2 });
  setCooldown(a, "spike", 4);

  tickStatuses(state);
  tickCooldowns(state);
  assert.equal(getStatus(a, "chill")!.remainingTicks, 1);
  assert.equal(getCooldown(a, "spike"), 3);

  tickStatuses(state);
  assert.equal(hasStatus(a, "chill"), false); // expired
  assert.equal(getCooldown(a, "spike"), 3);   // cooldown untouched by status expiry
  tickCooldowns(state); tickCooldowns(state); tickCooldowns(state);
  assert.equal(isReady(a, "spike"), true);
});

test("target selection is unaffected by ability cooldowns", () => {
  const { match, a } = activeMatch();
  setCooldown(a, "fireball", 999); // ability cooldowns are a separate system
  assert.deepEqual(selectTarget(match, a, "b"), { ok: true });
});

test("the target switch cooldown is independent per player", () => {
  const { match, a, b } = activeMatch();
  match.tick = 0;
  selectTarget(match, a, "b"); // arms a's switch cooldown only
  assert.deepEqual(selectTarget(match, b, "c"), { ok: true });
  assert.equal(a.targetSwitchReadyTick, TARGETING.SWITCH_COOLDOWN_TICKS);
});

test("shield absorption does not disturb modifiers or statuses on the defender", () => {
  const { match, a, b } = activeMatch();
  b.castle.shield = 1000;
  addModifier(b, { id: "r", stat: "damageTaken", op: "mult", value: 0.5, sourceId: "b", remainingTicks: null });
  applyStatus(b, { id: "wet", category: "debuff", stacking: "refresh" }, { sourceId: "a", durationTicks: 50 });

  const resolved = resolveDamage(a, b, 400, { forceCrit: false }); // 400 × 0.5 = 200
  applyDamage(b, resolved.amount);
  assert.equal(b.castle.shield, 800);
  assert.equal(b.modifiers.length, 1); // both survive the hit
  assert.equal(hasStatus(b, "wet"), true);
});

test("the combo container exists per player and starts empty (engine pending)", () => {
  const { a, b, c } = activeMatch();
  for (const p of [a, b, c]) assert.deepEqual(p.combos, []);
});
