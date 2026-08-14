import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility, buyShield } from "../src/engine/purchases.js";
import { processStatusTicks } from "../src/engine/status.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import {
  FOX_SWIPE,
  FOX_FIRE,
  OLD_FRIENDS,
  AZURE_GUIDANCE,
  KITSUNE_RUSH,
  FOX_SWIPE_MEMORY,
  OLD_FRIENDS_SHIELD_DAMAGE,
  FOX_FIRE_INTENSIFY,
} from "../src/data/kitsuneAbilities.js";
import { WATER_BALL } from "../src/data/waterAbilities.js";
import { KITSUNE, TICK } from "../src/data/balance.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Kitsune's designed kit. Everything it does feeds Ancient Memory, and both
// attacks are about making the victim SPEND rather than about raw damage.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function kitsuneMatch(
  victim = "water",
  perks: string[] = [],
): {
  match: Match;
  a: PlayerState;
  b: PlayerState;
} {
  const match = new Match("1234");
  match.addPlayer({ ...matchPlayer("a", "kitsune"), perks: perks as never });
  match.addPlayer(matchPlayer("b", victim));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  earn(a, 1_000_000);
  earn(b, 1_000_000);
  for (const ability of [FOX_SWIPE, FOX_FIRE, OLD_FRIENDS]) {
    assert.equal(unlockOrUpgradeAbility(match, a, ability.id).ok, true);
  }
  a.target = b.id;
  return { match, a, b };
}

// --- Fox Swipe ---------------------------------------------------------------

test("Fox Swipe hits, and tops up Ancient Memory beyond the damage share", () => {
  const { match, a, b } = kitsuneMatch();
  const hpBefore = b.castle.hp;
  a.ancientMemory = 0;

  assert.equal(activateAbility(match, a, FOX_SWIPE, { forceCrit: false }).ok, true);
  assert.ok(b.castle.hp < hpBefore, "Fox Swipe dealt no damage");

  // "Swift Tails" credits a share of the damage; Fox Swipe adds a flat bump on
  // top, so the total is strictly more than either alone.
  const dealt = hpBefore - b.castle.hp;
  const fromDamage = dealt * KITSUNE.MEMORY_PER_DAMAGE;
  assert.ok(
    Math.abs(a.ancientMemory - (fromDamage + FOX_SWIPE_MEMORY)) < 0.001,
    `expected ${fromDamage + FOX_SWIPE_MEMORY}, got ${a.ancientMemory}`,
  );
});

// --- Old Friends -------------------------------------------------------------

test("Old Friends spends itself on a shield and carries nothing over", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 4000;
  const hpBefore = b.castle.hp;

  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);

  assert.equal(b.castle.shield, 4000 - OLD_FRIENDS_SHIELD_DAMAGE);
  assert.equal(b.castle.hp, hpBefore, "damage carried over to the castle");
  // The foxes tore at the shield and left — they never moved in.
  assert.equal(
    b.statuses.some((s) => s.id === "oldFriends"),
    false,
  );
});

test("Old Friends against a thin shield still carries nothing over", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 200; // far less than the bite
  const hpBefore = b.castle.hp;

  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);
  assert.equal(b.castle.shield, 0);
  assert.equal(b.castle.hp, hpBefore, "the overkill leaked onto the castle");
});

test("Old Friends moves IN on an exposed kingdom, with no clock on it", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 0;

  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);
  assert.ok(
    b.statuses.some((s) => s.id === "oldFriends"),
    "the foxes never arrived",
  );

  // No duration: a minute later they are still there and still gnawing.
  const hpBefore = b.castle.hp;
  for (let t = 1; t <= 60 * TICK.RATE; t++) tickMatch(match, t);
  assert.ok(
    b.statuses.some((s) => s.id === "oldFriends"),
    "the foxes wandered off",
  );
  assert.ok(b.castle.hp < hpBefore, "the foxes did no damage");
});

test("buying a shield is what drives the foxes off", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 0;
  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);
  assert.ok(b.statuses.some((s) => s.id === "oldFriends"));

  assert.equal(buyShield(match, b).ok, true);
  assert.equal(
    b.statuses.some((s) => s.id === "oldFriends"),
    false,
    "the shield did not drive them off",
  );
});

test("the foxes feed Kitsune for as long as they are left alone", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 0;
  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);

  a.ancientMemory = 0;
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  const withFoxes = a.ancientMemory;

  // Drive them off, then run the same window again: Memory still climbs from
  // "Swift Tails" alone, but strictly slower.
  assert.equal(buyShield(match, b).ok, true);
  a.ancientMemory = 0;
  for (let t = 5 * TICK.RATE + 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.ok(
    withFoxes > a.ancientMemory,
    `foxes should feed Kitsune faster (${withFoxes} vs ${a.ancientMemory})`,
  );
});

test("Old Friends on a shielded kingdom leaves nothing behind to feed on", () => {
  const { match, a, b } = kitsuneMatch();
  b.castle.shield = 5000;
  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);
  assert.equal(
    b.statuses.some((s) => s.id === "oldFriends"),
    false,
  );
});

// --- Fox Fire ----------------------------------------------------------------

test("Fox Fire burns, and burns hotter every time the victim attacks", () => {
  const { match, a, b } = kitsuneMatch();
  assert.equal(activateAbility(match, a, FOX_FIRE, { forceCrit: false }).ok, true);
  const fire = b.statuses.find((s) => s.id === "foxFire");
  assert.ok(fire, "Fox Fire left no burn");
  assert.equal(fire!.intensity, 1);

  // A quiet victim burns at the base rate.
  const quietBefore = b.castle.hp;
  processStatusTicks(match.gameState!, () => 0.5);
  const quietTick = quietBefore - b.castle.hp;
  assert.ok(quietTick > 0, "the burn did nothing");

  // Swinging fans the flames.
  assert.equal(unlockOrUpgradeAbility(match, b, WATER_BALL.id).ok, true);
  b.target = a.id;
  assert.equal(activateAbility(match, b, WATER_BALL, { forceCrit: false }).ok, true);
  assert.ok(
    Math.abs(
      b.statuses.find((s) => s.id === "foxFire")!.intensity! - FOX_FIRE_INTENSIFY,
    ) < 0.001,
  );

  const angryBefore = b.castle.hp;
  processStatusTicks(match.gameState!, () => 0.5);
  assert.ok(
    angryBefore - b.castle.hp > quietTick,
    "attacking did not make the fire hotter",
  );
});

test("Fox Fire stacks, and a rejected cast never stokes it", () => {
  const { match, a, b } = kitsuneMatch();
  assert.equal(activateAbility(match, a, FOX_FIRE, { forceCrit: false }).ok, true);
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, FOX_FIRE, { forceCrit: false }).ok, true);
  assert.equal(b.statuses.find((s) => s.id === "foxFire")!.stacks, 2);

  // Water Ball with no gold: refused, so the fire must not intensify.
  assert.equal(unlockOrUpgradeAbility(match, b, WATER_BALL.id).ok, true);
  b.economy.currency = 0;
  const before = b.statuses.find((s) => s.id === "foxFire")!.intensity;
  assert.equal(activateAbility(match, b, WATER_BALL, { forceCrit: false }).ok, false);
  assert.equal(b.statuses.find((s) => s.id === "foxFire")!.intensity, before);
});

test("Fox Fire feeds Ancient Memory when it lands", () => {
  const { match, a } = kitsuneMatch();
  a.ancientMemory = 0;
  assert.equal(activateAbility(match, a, FOX_FIRE, { forceCrit: false }).ok, true);
  assert.ok(a.ancientMemory > 0, "Fox Fire fed Kitsune nothing");
});

// --- Azure Guidance ----------------------------------------------------------

test("Azure Guidance doubles how fast Ancient Memory fills", () => {
  const plain = kitsuneMatch();
  plain.a.ancientMemory = 0;
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(plain.match, t);
  const normal = plain.a.ancientMemory;

  const guided = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(guided.match, guided.a, AZURE_GUIDANCE.id).ok, true);
  assert.equal(activateAbility(guided.match, guided.a, AZURE_GUIDANCE).ok, true);
  guided.a.ancientMemory = 0;
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(guided.match, t);

  assert.ok(
    Math.abs(guided.a.ancientMemory - normal * KITSUNE.AZURE_GUIDANCE_MULTIPLIER) < 0.01,
    `expected ~${normal * KITSUNE.AZURE_GUIDANCE_MULTIPLIER}, got ${guided.a.ancientMemory}`,
  );
});

test("Azure Guidance speeds up EVERY source of Memory, not just the trickle", () => {
  const { match, a, b } = kitsuneMatch();
  a.ancientMemory = 0;
  assert.equal(activateAbility(match, a, FOX_SWIPE, { forceCrit: false }).ok, true);
  const plainSwipe = a.ancientMemory;

  const guided = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(guided.match, guided.a, AZURE_GUIDANCE.id).ok, true);
  assert.equal(activateAbility(guided.match, guided.a, AZURE_GUIDANCE).ok, true);
  guided.a.ancientMemory = 0;
  assert.equal(activateAbility(guided.match, guided.a, FOX_SWIPE, { forceCrit: false }).ok, true);

  assert.ok(guided.a.ancientMemory > plainSwipe, "the swipe was not boosted");
  assert.ok(b.castle.hp <= b.castle.maxHp);
});

// --- Kitsune Rush ------------------------------------------------------------

test("Kitsune Rush is refused until the meter is completely full", () => {
  const { match, a } = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, KITSUNE_RUSH.id).ok, true);

  a.ancientMemory = KITSUNE.MEMORY_FULL - 1;
  const early = activateAbility(match, a, KITSUNE_RUSH);
  assert.equal(early.ok, false);
  assert.equal(early.error, "MEMORY_NOT_FULL");

  a.ancientMemory = KITSUNE.MEMORY_FULL;
  assert.equal(activateAbility(match, a, KITSUNE_RUSH).ok, true);
});

test("Kitsune Rush costs no gold — Memory is the whole price", () => {
  const { match, a } = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, KITSUNE_RUSH.id).ok, true);
  a.ancientMemory = KITSUNE.MEMORY_FULL;

  const goldBefore = a.economy.currency;
  assert.equal(activateAbility(match, a, KITSUNE_RUSH).ok, true);
  assert.equal(a.economy.currency, goldBefore, "Kitsune Rush charged gold");
  assert.equal(a.ancientMemory, 0, "the meter was not spent");
});

test("Kitsune Rush halves cooldowns, including ones already running", () => {
  const { match, a } = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, KITSUNE_RUSH.id).ok, true);

  // A cooldown already ticking when the Rush starts.
  setCooldown(a, FOX_FIRE.id, 100);
  a.ancientMemory = KITSUNE.MEMORY_FULL;
  assert.equal(activateAbility(match, a, KITSUNE_RUSH).ok, true);

  // Ten ticks of Rush should burn twenty ticks of cooldown.
  for (let t = 1; t <= 10; t++) tickMatch(match, t);
  assert.ok(
    getCooldown(a, FOX_FIRE.id) <= 80,
    `expected <= 80 remaining, got ${getCooldown(a, FOX_FIRE.id)}`,
  );
});

test("Kitsune Rush doubles gold production while it holds", () => {
  const { match, a } = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, KITSUNE_RUSH.id).ok, true);
  a.economy.citizens = 20;

  applyPassiveIncome(match.gameState!);
  const plain = a.economy.incomePerTick;

  a.ancientMemory = KITSUNE.MEMORY_FULL;
  assert.equal(activateAbility(match, a, KITSUNE_RUSH).ok, true);
  applyPassiveIncome(match.gameState!);

  assert.ok(
    a.economy.incomePerTick > plain,
    `income did not rise (${a.economy.incomePerTick} vs ${plain})`,
  );
});

test("an untouched Kitsune reaches a full meter in three minutes", () => {
  // The floor the ultimate is paced against: no attacks, no Azure Guidance,
  // nothing at all.
  const { match, a } = kitsuneMatch();
  a.ancientMemory = 0;
  for (let t = 1; t <= 180 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(a.ancientMemory, KITSUNE.MEMORY_FULL);
});

test("a full meter does NOT fire Kitsune Rush on its own", () => {
  // The meter filling is not the cast. Nothing in the tick loop may trigger it:
  // it waits, indefinitely, for the player to actually press it.
  const { match, a } = kitsuneMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, KITSUNE_RUSH.id).ok, true);

  for (let t = 1; t <= 200 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(a.ancientMemory, KITSUNE.MEMORY_FULL, "the meter never filled");
  assert.equal(
    a.statuses.some((s) => s.id === "kitsuneRush"),
    false,
    "Kitsune Rush fired itself",
  );

  // It is still sitting there waiting, and casting works the moment it is asked.
  assert.equal(activateAbility(match, a, KITSUNE_RUSH).ok, true);
  assert.ok(a.statuses.some((s) => s.id === "kitsuneRush"));
});

test("Old Friends' bite scales with the attacker's damage buffs", () => {
  // The foxes' bite is DAMAGE, not a flat subtraction — so everything that
  // makes this kingdom hit harder has to make it bite harder too. Nothing
  // user-facing quotes the base figure for exactly this reason.
  const bite = (perks: string[]) => {
    const { match, a, b } = kitsuneMatch("water", perks);
    b.castle.shield = 100_000; // never runs out, so the full bite is measurable
    assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);
    return 100_000 - b.castle.shield;
  };

  const plain = bite([]);
  assert.equal(plain, OLD_FRIENDS_SHIELD_DAMAGE, "unbuffed, it is the base figure");

  // Sharper Swords lifts all outgoing damage…
  assert.ok(
    bite(["sharperSwords"]) > plain,
    "Sharper Swords did not increase the bite",
  );
  // …and Sharper Axes lifts damage against SHIELDS, which is all this is.
  assert.ok(bite(["sharperAxes"]) > plain, "Sharper Axes did not increase the bite");
  // Both together beat either alone — they compose rather than overriding.
  assert.ok(
    bite(["sharperSwords", "sharperAxes"]) > bite(["sharperSwords"]),
    "the two perks did not stack",
  );
});

test("Old Friends' bite still never carries into castle HP, however buffed", () => {
  // The whole identity of the ability: it is spent ENTIRELY on the shield.
  // A buffed bite that overflowed would quietly turn it into a nuke.
  const { match, a, b } = kitsuneMatch("water", ["sharperSwords", "sharperAxes"]);
  b.castle.shield = 10;
  const hpBefore = b.castle.hp;

  assert.equal(activateAbility(match, a, OLD_FRIENDS, { forceCrit: false }).ok, true);

  assert.equal(b.castle.shield, 0, "the shield should be stripped");
  assert.equal(b.castle.hp, hpBefore, "buffed damage carried over to the castle");
});
