import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_STATUS,
  FLOOD,
  FLUID_ASSIMILATION,
  RIPTIDE,
  WATERFALL,
  WATER_BALL,
} from "../src/data/waterAbilities.js";
import { baseDamage, declaredDamage } from "./support/derive.js";
import { activateAbility, purchaseUpgrade, resolveAbility } from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { applyStatus, getStatus, hasStatus, processStatusTicks } from "../src/engine/status.js";
import { resolveDamage } from "../src/engine/damage.js";
import { applyPassiveIncome, computeIncome } from "../src/engine/economy.js";
import { earn } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { tickMatch } from "../src/engine/tick.js";
import { TICK } from "../src/data/balance.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

const player = (id: string, kingdomId: KingdomId): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** water (w) vs fire (f) vs air (n — neutral bystander). */
function pond(): { match: Match; w: PlayerState; f: PlayerState; n: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("w", "water"));
  match.addPlayer(player("f", "plains"));
  match.addPlayer(player("n", "air"));
  match.hostId = "w";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [w, f, n] = [gs.getPlayer("w")!, gs.getPlayer("f")!, gs.getPlayer("n")!];
  for (const p of [w, f, n]) earn(p, 10_000);
  return { match, w, f, n };
}

// --- #81: passives applied automatically by the engine -------------------------

test("We're In This Together: water citizens produce $1.35/s vs the base $1.20/s", () => {
  const { w, f } = pond();
  // 10 citizens: water 10 × $0.0675/tick = $0.675; Fire 10 × $0.06 = $0.6.
  assert.equal(computeIncome(w), 0.675);
  assert.equal(computeIncome(f), 0.6);

  w.economy.citizens = 20; // flat per-citizen rate: 20 × 0.0675
  assert.equal(computeIncome(w), 1.35);
});

test("production passive flows through the real income phase", () => {
  const { match, w, f } = pond();
  const w0 = w.economy.currency;
  const f0 = f.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.ok(Math.abs((w.economy.currency - w0) - 0.675) < 0.0001); // floating point tolerance
  assert.ok(Math.abs((f.economy.currency - f0) - 0.6) < 0.0001); // floating point tolerance
});

test("Fountain of Youth: burn lasts 40% shorter on Water — and only on Water", () => {
  const { w, f } = pond();
  const burn = { id: "burn", category: "debuff" as const, stacking: "refresh" as const };
  assert.equal(applyStatus(w, burn, { sourceId: "f", durationTicks: 100 }).remainingTicks, 60);
  assert.equal(applyStatus(f, burn, { sourceId: "w", durationTicks: 100 }).remainingTicks, 100);
  // Other statuses on Water are unaffected.
  assert.equal(
    applyStatus(w, CURRENT_STATUS, { sourceId: "f", durationTicks: 100 }).remainingTicks,
    100,
  );
});

test("Fountain of Youth: 15% less damage from Fire attacks — other elements full", () => {
  const { w, f } = pond();
  const fire = resolveDamage(f, w, 400, { element: "fire", forceCrit: false });
  assert.equal(fire.amount, 340); // 400 × 0.85

  const neutral = resolveDamage(f, w, 400, { forceCrit: false });
  assert.equal(neutral.amount, 400); // element unknown → no resistance

  // And fire into a non-Water kingdom is not reduced.
  const intoFire = resolveDamage(w, f, 400, { element: "fire", forceCrit: false });
  assert.equal(intoFire.amount, 400);
});

test("Fountain of Youth: 15% less DoT tick damage (Burn/Poison/Father Time) on Water", () => {
  const { match, w, f } = pond();
  const gs = match.gameState!;
  // A burn dealing 100/tick lands on Water and on a non-Water bystander.
  const burn = {
    id: "burn",
    category: "debuff" as const,
    stacking: "refresh" as const,
    tickEffects: [{ type: "damage" as const, amount: 100 }],
  };
  applyStatus(w, burn, { sourceId: "f", durationTicks: 100 });
  applyStatus(f, burn, { sourceId: "w", durationTicks: 100 });
  w.castle.hp = 10_000;
  f.castle.hp = 10_000;
  processStatusTicks(gs);
  assert.equal(w.castle.hp, 10_000 - 85); // 100 × 0.85 (Fountain of Youth)
  assert.equal(f.castle.hp, 10_000 - 100); // full on a non-Water kingdom
});

test("Fountain of Youth: 15% less damage from Meteor Shower (a named direct-damage ability)", () => {
  const { match, w, f } = pond();
  // A plain damage ability whose id is in Fountain of Youth's sources is cut
  // 15% against Water; an otherwise-identical ability whose id isn't, is not.
  const dmgAbility = (id: string) => ({
    id,
    kind: "attack" as const,
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" as const },
    effects: [{ type: "damage" as const, target: "target" as const, params: { amount: 400 } }],
  });
  w.castle.hp = 10_000;
  activateAbility(match, f, dmgAbility("meteorShower"), { targetId: "w", forceCrit: false, rng: () => 0.99 });
  assert.equal(w.castle.hp, 10_000 - 340); // 400 × 0.85

  w.castle.hp = 10_000;
  activateAbility(match, f, dmgAbility("rockThrow"), { targetId: "w", forceCrit: false, rng: () => 0.99 });
  assert.equal(w.castle.hp, 10_000 - 400); // not a listed source → full damage
});

// --- #82: Water Ball -------------------------------------------------------------

test("Water Ball is a working attack on the shared framework", () => {
  const { match, w, f } = pond();
  const r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - baseDamage(WATER_BALL));
});

// --- #83: the Current status -------------------------------------------------------

test("Current tracks duration and expires through the tick loop", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  const current = getStatus(f, "current")!;
  assert.equal(current.remainingTicks, 8 * TICK.RATE);
  assert.equal(current.sourceId, "w");

  for (let t = 1; t <= 8 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(f, "current"), false);
});

// --- #84: Waterfall ---------------------------------------------------------------

test("Waterfall damages and applies Current to the selected target", () => {
  const { match, w, f } = pond();
  selectTarget(match, w, "f");
  const r = activateAbility(match, w, WATERFALL, { forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - baseDamage(WATERFALL));
  assert.equal(hasStatus(f, "current"), true);
});

// --- #85: Water attack healing during Current ---------------------------------------

test("Water attacks heal Water based on damage dealt, only while Current is active", () => {
  const { match, w, f } = pond();
  w.castle.hp = 5000;

  // No Current yet → Water Ball does not heal.
  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, 5000);

  // Waterfall applies Current after its damage, so the *next* attack heals.
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, 5000);

  for (let t = 1; t <= WATER_BALL.cooldownTicks; t++) tickMatch(match, t);
  const hpBefore = w.castle.hp;
  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  // Water heals 40% of the damage its attack dealt while Current is up.
  assert.equal(w.castle.hp, hpBefore + Math.round(baseDamage(WATER_BALL) * 0.4));
});

test("healing counts shield-absorbed damage and never exceeds max HP", () => {
  const { match, w, f } = pond();
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 1000 });
  f.castle.shield = 10_000; // everything absorbed
  w.castle.hp = w.castle.maxHp - 10; // nearly full

  activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(w.castle.hp, w.castle.maxHp); // 120 heal capped at +10
});

// --- #86/#87: Flood damage and duration ---------------------------------------------

test("Flood deals heavy damage and bans targeting Water for 5 seconds", () => {
  const { match, w, f } = pond();
  const r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10_000 - baseDamage(FLOOD));
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 5 * TICK.RATE);
});

test("Flood lasts twice as long against a Current-affected target", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(hasStatus(f, "current"), true);

  for (let t = 1; t <= WATERFALL.cooldownTicks; t++) tickMatch(match, t);
  // Current (8 s) has expired by now (10 s passed) — reapply it fresh.
  activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 10 * TICK.RATE);
});

// --- #88: the Flood targeting restriction --------------------------------------------

test("a flooded kingdom cannot target Water but can target anyone else", () => {
  const { match, w, f, n } = pond();
  match.tick = 1000; // clear of all switch cooldowns
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });

  assert.equal(selectTarget(match, f, "w").error, "INVALID_TARGET");
  assert.deepEqual(selectTarget(match, f, "n"), { ok: true }); // others fine

  // Ability casts with an explicit target are equally bound.
  const cast = activateAbility(match, f, WATER_BALL, { targetId: "w", forceCrit: false });
  assert.equal(cast.error, "INVALID_TARGET");
  // …but attacking the bystander works.
  const other = activateAbility(match, f, { ...WATER_BALL, id: "fball2" }, { targetId: "n", forceCrit: false });
  assert.equal(other.ok, true);
});

test("Flood severs an existing lock-on onto Water and waives the switch cooldown", () => {
  const { match, w, f, n } = pond();
  match.tick = 10;
  selectTarget(match, f, "w"); // f is aiming at Water, switch cooldown armed

  match.tick = 20; // still inside f's switch cooldown
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(f.target, null); // forced off Water
  assert.deepEqual(selectTarget(match, f, "n"), { ok: true }); // immediate re-aim
});

test("the ban lifts when Flood expires", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(f, "flooded"), false);
  assert.deepEqual(selectTarget(match, f, "w"), { ok: true });
});

// --- #89 (reworked): Fluid Assimilation -----------------------------------------------

test("Fluid Assimilation bars every enemy from targeting Water for 5 seconds", () => {
  const { match, w, f, n } = pond();
  match.tick = 1000; // clear of all switch cooldowns
  const r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  // Every living enemy is marked; Water itself is not.
  assert.equal(hasStatus(f, "assimilated"), true);
  assert.equal(hasStatus(n, "assimilated"), true);
  assert.equal(hasStatus(w, "assimilated"), false);
  // Neither enemy may target (and thus attack) Water; other targets stay valid.
  assert.equal(selectTarget(match, f, "w").ok, false);
  assert.equal(selectTarget(match, n, "w").ok, false);
  assert.deepEqual(selectTarget(match, f, "n"), { ok: true });
});

test("Fluid Assimilation severs an existing lock-on onto Water", () => {
  const { match, w, f } = pond();
  match.tick = 1000;
  assert.deepEqual(selectTarget(match, f, "w"), { ok: true });
  assert.equal(f.target, "w");
  activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(f.target, null); // lock broken the moment the mist rises
});

test("the Fluid Assimilation ban lifts after 5 seconds", () => {
  const { match, w, f } = pond();
  activateAbility(match, w, FLUID_ASSIMILATION);
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(f, "assimilated"), false);
  assert.deepEqual(selectTarget(match, f, "w"), { ok: true });
});

// --- #90: Riptide ----------------------------------------------------------------------

test("Riptide restores 50% max HP and grows citizens by 5%, refreshing income", () => {
  const { match, w } = pond();
  w.castle.hp = 2000;
  const r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 2000 + 5000); // 50% of 10,000
  assert.equal(w.economy.citizens, 11); // round(10 × 1.05)
  // Income refreshed at once: 11 × $0.0675 = $0.7425.
  assert.equal(w.economy.incomePerTick, 0.7425);
});

test("Riptide healing is capped at max HP", () => {
  const { match, w } = pond();
  w.castle.hp = 8000;
  activateAbility(match, w, RIPTIDE);
  assert.equal(w.castle.hp, 10_000);
});

// --- #100: Water Ability Upgrades ---------------------------------------------------

test("Water Ball upgrades (Lv 1 -> 4) modify damage and cooldown values", () => {
  const { match, w, f } = pond();
  
  // Lv 2: the damage tier resolves to what the upgrade path declares.
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  let r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - declaredDamage(WATER_BALL, 1));

  // Lv 3: the cooldown tier resolves to what the upgrade path declares.
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "waterBall"), resolveAbility(WATER_BALL, 2).cooldownTicks);

  // Lv 4: a further damage tier, strictly above Lv2's.
  purchaseUpgrade(match, w, WATER_BALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATER_BALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - declaredDamage(WATER_BALL, 3));
  assert.ok(declaredDamage(WATER_BALL, 3) > declaredDamage(WATER_BALL, 1));
});

test("Waterfall upgrades (Lv 1 -> 5) increase damage, status duration, reduce cooldown, and boost healing", () => {
  const { match, w, f } = pond();
  
  // Lv 2: the damage tier resolves to what the upgrade path declares.
  purchaseUpgrade(match, w, WATERFALL);
  let r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - declaredDamage(WATERFALL, 1));

  // Lv 3: Duration +2 s (8 s -> 10 s)
  purchaseUpgrade(match, w, WATERFALL);
  w.castle.hp = 10000;
  f.castle.hp = 10000;
  w.cooldowns = {};
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.ok(
    getStatus(f, "current")!.remainingTicks >
      (WATERFALL.effects[1].params.durationTicks ?? 0),
    "the Lv3 tier should extend Current",
  );

  // Lv 4: Cooldown -10% (10 s -> 9 s)
  purchaseUpgrade(match, w, WATERFALL);
  w.cooldowns = {};
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "waterfall"), resolveAbility(WATERFALL, 3).cooldownTicks);

  // Lv 5: lifesteal ratio pinned at 40% (same as the new base ratio)
  purchaseUpgrade(match, w, WATERFALL);
  w.cooldowns = {};
  f.castle.hp = 10000;
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 1000 });
  w.castle.hp = 8000;
  r = activateAbility(match, w, WATERFALL, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  // Lifesteal is a RATIO of the damage this cast actually dealt.
  const wfDealt = 10000 - f.castle.hp;
  const wfRatio = resolveAbility(WATERFALL, 4).effects[0].params.lifesteal!.ratio;
  assert.equal(w.castle.hp, 8000 + Math.round(wfDealt * wfRatio));
});

test("Flood upgrades (Lv 1 -> 5) boost damage, lockout, cooldown, and increase healing", () => {
  const { match, w, f } = pond();
  
  // Lv 2: the damage tier resolves to what the upgrade path declares.
  purchaseUpgrade(match, w, FLOOD);
  let r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(f.castle.hp, 10000 - declaredDamage(FLOOD, 1));

  // Lv 3: Lockout duration +2 s (5 s -> 7 s)
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getStatus(f, "flooded")!.remainingTicks, 7 * TICK.RATE);

  // Lv 4: Cooldown -10% (20 s -> 18 s)
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "flood"), 18 * TICK.RATE);

  // Lv 5: Increased healing from Flood — lifesteal 40% -> 125%
  purchaseUpgrade(match, w, FLOOD);
  w.cooldowns = {};
  f.castle.hp = 10000;
  applyStatus(f, CURRENT_STATUS, { sourceId: "w", durationTicks: 100 });
  w.castle.hp = 8000;
  r = activateAbility(match, w, FLOOD, { targetId: "f", forceCrit: false });
  assert.equal(r.ok, true);
  const floodDealt = 10000 - f.castle.hp;
  const floodRatio = resolveAbility(FLOOD, 4).effects[0].params.lifesteal!.ratio;
  assert.equal(w.castle.hp, 8000 + Math.round(floodDealt * floodRatio));
  assert.ok(floodRatio > FLOOD.effects[0].params.lifesteal!.ratio, "Lv5 boosts healing");
});

test("Fluid Assimilation upgrades (Lv 1 -> 3) extend the ban and reduce cooldown", () => {
  const { match, w, f } = pond();

  // Lv 2: protection 5 s -> 12 s.
  purchaseUpgrade(match, w, FLUID_ASSIMILATION);
  let r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  const mark = f.statuses.find((s) => s.id === "assimilated")!;
  assert.equal(mark.remainingTicks, 12 * TICK.RATE);

  // Lv 3: Reduce cooldown by 15% (15 s -> 12.75 s = 255 ticks)
  purchaseUpgrade(match, w, FLUID_ASSIMILATION);
  w.cooldowns = {};
  r = activateAbility(match, w, FLUID_ASSIMILATION);
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "fluidAssimilation"), 255);
});

test("Riptide upgrades (Lv 1 -> 3) increase healing, citizen gain, and reduce cooldown", () => {
  const { match, w } = pond();
  
  // Lv 2: Heal 50% -> 70% HP, citizen gain 5% -> 10%
  purchaseUpgrade(match, w, RIPTIDE);
  w.castle.hp = 2000;
  w.economy.citizens = 10;
  let r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(w.castle.hp, 2000 + 7000); // 70%
  assert.equal(w.economy.citizens, 11); // round(10 × 1.1)

  // Lv 3: Reduce cooldown by 15% (90 s -> 76.5 s = 1530 ticks)
  purchaseUpgrade(match, w, RIPTIDE);
  w.cooldowns = {};
  r = activateAbility(match, w, RIPTIDE);
  assert.equal(r.ok, true);
  assert.equal(getCooldown(w, "riptide"), 1530);
});
