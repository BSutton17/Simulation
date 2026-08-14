import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility, buyCitizen } from "../src/engine/purchases.js";
import { applyDamage } from "../src/engine/combat.js";
import { tickStatuses } from "../src/engine/status.js";
import { earn } from "../src/engine/money.js";
import {
  SHADOW_STRIKE,
  YIN_AND_YANG,
  YIN_YANG_DURATION,
  UNLIMITED_RAGE,
  NEVER_ENDING_NIGHTMARE,
  INFINITUM_TENEBRAE,
} from "../src/data/darkAbilities.js";
import { WATER_ABILITIES } from "../src/data/waterAbilities.js";
import { DARK } from "../src/data/balance.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Dark's kit: profit from being hit, and make the victim lose either way.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

/** A Dark player `a` against a plain `b`, with Dark's kit already bought. */
function darkMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "dark"));
  match.addPlayer(matchPlayer("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  earn(a, 1_000_000);
  for (const id of [
    SHADOW_STRIKE.id,
    YIN_AND_YANG.id,
    UNLIMITED_RAGE.id,
    NEVER_ENDING_NIGHTMARE.id,
    INFINITUM_TENEBRAE.id,
  ]) {
    assert.equal(unlockOrUpgradeAbility(match, a, id).ok, true);
  }
  a.target = b.id;
  return { match, a, b };
}

const cast = (
  match: Match,
  a: PlayerState,
  ability: typeof SHADOW_STRIKE,
  choice?: string,
) => activateAbility(match, a, ability, { forceCrit: false, rng: () => 0.5, choice });

// --- Shadow Strike ----------------------------------------------------------

test("Shadow Strike is a plain damaging basic attack", () => {
  const { match, a, b } = darkMatch();
  const hpBefore = b.castle.hp;
  assert.equal(cast(match, a, SHADOW_STRIKE).ok, true);
  assert.ok(b.castle.hp < hpBefore, "Shadow Strike dealt no damage");
});

// --- Yin and Yang: the rigged wager -----------------------------------------

test("Yin and Yang requires the caster to name a side", () => {
  const { match, a } = darkMatch();
  const noPick = activateAbility(match, a, YIN_AND_YANG, { forceCrit: false });
  assert.equal(noPick.ok, false);
  assert.equal(noPick.error, "CHOICE_REQUIRED");

  const badPick = activateAbility(match, a, YIN_AND_YANG, {
    forceCrit: false,
    choice: "sideways",
  });
  assert.equal(badPick.ok, false);
  assert.equal(badPick.error, "CHOICE_REQUIRED");
});

test("yin: buying a citizen settles the wager in FULL", () => {
  const { match, a, b } = darkMatch();
  assert.equal(cast(match, a, YIN_AND_YANG, "yin").ok, true);
  earn(b, 10_000);

  const hpBefore = b.castle.hp;
  assert.equal(buyCitizen(match, b).ok, true);
  assert.equal(hpBefore - b.castle.hp, 700); // guessed wrong → full
  assert.equal(b.statuses.some((s) => s.id === "yinYang"), false, "wager not spent");
});

test("yin: refusing to buy still costs HALF when the window closes", () => {
  const { match, a, b } = darkMatch();
  assert.equal(cast(match, a, YIN_AND_YANG, "yin").ok, true);

  const hpBefore = b.castle.hp;
  for (let i = 0; i < YIN_YANG_DURATION; i++) tickStatuses(match.gameState!);
  assert.equal(hpBefore - b.castle.hp, 350); // read Dark right → half
  assert.equal(b.statuses.some((s) => s.id === "yinYang"), false);
});

test("yang: refusing to buy settles the wager in FULL", () => {
  const { match, a, b } = darkMatch();
  assert.equal(cast(match, a, YIN_AND_YANG, "yang").ok, true);

  const hpBefore = b.castle.hp;
  for (let i = 0; i < YIN_YANG_DURATION; i++) tickStatuses(match.gameState!);
  assert.equal(hpBefore - b.castle.hp, 700); // guessed wrong → full
});

test("yang: buying a citizen still costs HALF", () => {
  const { match, a, b } = darkMatch();
  assert.equal(cast(match, a, YIN_AND_YANG, "yang").ok, true);
  earn(b, 10_000);

  const hpBefore = b.castle.hp;
  assert.equal(buyCitizen(match, b).ok, true);
  assert.equal(hpBefore - b.castle.hp, 350); // read Dark right → half
});

test("the wager settles exactly once, however the victim moves after", () => {
  const { match, a, b } = darkMatch();
  assert.equal(cast(match, a, YIN_AND_YANG, "yin").ok, true);
  earn(b, 100_000);

  assert.equal(buyCitizen(match, b).ok, true);
  const afterSettle = b.castle.hp;
  // A second hire, and the whole window elapsing, cost nothing more.
  assert.equal(buyCitizen(match, b).ok, true);
  for (let i = 0; i < YIN_YANG_DURATION + 5; i++) tickStatuses(match.gameState!);
  assert.equal(b.castle.hp, afterSettle);
});

// --- Unlimited Rage: the meter ----------------------------------------------

test("the rage meter fills by exactly the damage absorbed", () => {
  const { a } = darkMatch();
  assert.equal(a.rageMeter, 0);

  applyDamage(a, 400, { tick: 1 });
  assert.equal(a.rageMeter, 400);

  // A bigger hit is worth proportionally more — the total is what matters.
  // Kept below RAGE_FULL so this checks accumulation, not the cap.
  applyDamage(a, 600, { tick: 2 });
  assert.equal(a.rageMeter, 1_000);
});

test("damage eaten by a shield still feeds the meter, and it caps at full", () => {
  const { a } = darkMatch();
  a.castle.shield = 500;
  applyDamage(a, 500, { tick: 1 });
  assert.equal(a.castle.hp, a.castle.maxHp, "the shield should have eaten it");
  assert.equal(a.rageMeter, 500, "shielded damage did not charge rage");

  applyDamage(a, 999_999, { tick: 2 });
  assert.equal(a.rageMeter, DARK.RAGE_FULL);
});

test("Unlimited Rage cannot be cast until the meter is completely full", () => {
  const { match, a, b } = darkMatch();
  a.rageMeter = DARK.RAGE_FULL - 1;

  const tooSoon = cast(match, a, UNLIMITED_RAGE);
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.error, "NOT_ENRAGED");
  assert.equal(b.castle.hp, b.castle.maxHp, "a rejected cast still did damage");
});

test("a full meter fires, blinds the victim, and empties", () => {
  const { match, a, b } = darkMatch();
  a.rageMeter = DARK.RAGE_FULL;

  const hpBefore = b.castle.hp;
  assert.equal(cast(match, a, UNLIMITED_RAGE).ok, true);
  assert.ok(b.castle.hp < hpBefore, "Unlimited Rage dealt no damage");
  assert.ok(
    b.statuses.some((s) => s.id === "darkened"),
    "the victim was not blinded",
  );
  assert.equal(a.rageMeter, 0, "the meter was not spent");
});

test("the meter refills after being spent", () => {
  const { match, a } = darkMatch();
  a.rageMeter = DARK.RAGE_FULL;
  assert.equal(cast(match, a, UNLIMITED_RAGE).ok, true);
  assert.equal(a.rageMeter, 0);

  applyDamage(a, 250, { tick: 5 });
  assert.equal(a.rageMeter, 250);
});

// --- Never-ending Nightmare: stripped back to the basics --------------------

/** Buys `b` (Water) its whole kit so the lock has something to bite on. */
function armVictim(match: Match, b: PlayerState): void {
  earn(b, 1_000_000);
  for (const ability of WATER_ABILITIES) {
    assert.equal(unlockOrUpgradeAbility(match, b, ability.id).ok, true);
  }
  b.target = "a";
}

test("the nightmare bars every attack but the victim's basic", () => {
  const { match, a, b } = darkMatch();
  armVictim(match, b);
  assert.equal(cast(match, a, NEVER_ENDING_NIGHTMARE).ok, true);

  const [basic, medium] = WATER_ABILITIES;
  const ultimate = WATER_ABILITIES.find((x) => x.kind === "ultimate")!;

  const blockedMedium = activateAbility(match, b, medium!, { forceCrit: false });
  assert.equal(blockedMedium.ok, false);
  assert.equal(blockedMedium.error, "BASIC_ATTACKS_ONLY");

  const blockedUltimate = activateAbility(match, b, ultimate, { forceCrit: false });
  assert.equal(blockedUltimate.ok, false);
  assert.equal(blockedUltimate.error, "BASIC_ATTACKS_ONLY");

  // The basic attack still goes through.
  assert.equal(activateAbility(match, b, basic!, { forceCrit: false }).ok, true);
});

test("the victim's utilities stay legal under the nightmare", () => {
  const { match, a, b } = darkMatch();
  armVictim(match, b);
  assert.equal(cast(match, a, NEVER_ENDING_NIGHTMARE).ok, true);

  const utility = WATER_ABILITIES.find((x) => x.kind === "utility")!;
  assert.equal(activateAbility(match, b, utility, { forceCrit: false }).ok, true);
});

test("the nightmare lifts after exactly three attacks", () => {
  const { match, a, b } = darkMatch();
  armVictim(match, b);
  assert.equal(cast(match, a, NEVER_ENDING_NIGHTMARE).ok, true);

  const basic = WATER_ABILITIES[0]!;
  const medium = WATER_ABILITIES[1]!;
  for (let i = 0; i < 3; i++) {
    b.cooldowns = {};
    assert.equal(
      activateAbility(match, b, basic, { forceCrit: false }).ok,
      true,
      `basic attack ${i + 1} was refused`,
    );
  }

  assert.equal(b.statuses.some((s) => s.id === "neverEndingNightmare"), false);
  b.cooldowns = {};
  assert.equal(activateAbility(match, b, medium, { forceCrit: false }).ok, true);
});

test("a refused cast does not burn one of the three attacks", () => {
  const { match, a, b } = darkMatch();
  armVictim(match, b);
  assert.equal(cast(match, a, NEVER_ENDING_NIGHTMARE).ok, true);
  const medium = WATER_ABILITIES[1]!;

  for (let i = 0; i < 5; i++) {
    b.cooldowns = {};
    assert.equal(activateAbility(match, b, medium, { forceCrit: false }).ok, false);
  }
  const lock = b.statuses.find((s) => s.id === "neverEndingNightmare");
  assert.ok(lock, "the lock lifted off rejected casts");
  assert.equal(lock!.basicAttacksRemaining, 3);
});

// --- Infinitum Tenebrae: the endless dark -----------------------------------

test("Infinitum Tenebrae hits three kingdoms at FULL damage each", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "dark"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "water"));
  match.addPlayer(matchPlayer("d", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const victims = ["b", "c", "d"].map((id) => match.gameState!.getPlayer(id)!);
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, SHADOW_STRIKE.id).ok, true);
  assert.equal(unlockOrUpgradeAbility(match, a, INFINITUM_TENEBRAE.id).ok, true);

  // A baseline single-target hit, buffed identically, for comparison.
  a.target = victims[0]!.id;
  assert.equal(cast(match, a, INFINITUM_TENEBRAE).ok, true);
  a.cooldowns = {};
  const solo = victims[0]!.castle.hp;
  assert.equal(
    activateAbility(match, a, SHADOW_STRIKE, { forceCrit: false, rng: () => 0.5 }).ok,
    true,
  );
  const soloDamage = solo - victims[0]!.castle.hp;
  assert.ok(soloDamage > 0);

  // Now the same attack across all three: each takes the SAME full amount —
  // no division, unlike Air's spread.
  a.cooldowns = {};
  const before = victims.map((v) => v.castle.hp);
  assert.equal(
    activateAbility(match, a, SHADOW_STRIKE, {
      forceCrit: false,
      rng: () => 0.5,
      targetIds: victims.map((v) => v.id),
    }).ok,
    true,
  );
  victims.forEach((v, i) => {
    assert.equal(before[i]! - v.castle.hp, soloDamage, `victim ${v.id} took a split share`);
  });
});

test("Infinitum Tenebrae darkens every screen it touches, and buffs the damage", () => {
  const { match, a, b } = darkMatch();

  // Unbuffed baseline.
  const plainBefore = b.castle.hp;
  assert.equal(cast(match, a, SHADOW_STRIKE).ok, true);
  const plain = plainBefore - b.castle.hp;
  assert.equal(b.statuses.some((s) => s.id === "darkened"), false);

  assert.equal(cast(match, a, INFINITUM_TENEBRAE).ok, true);
  a.cooldowns = {};
  const buffedBefore = b.castle.hp;
  assert.equal(cast(match, a, SHADOW_STRIKE).ok, true);
  const buffed = buffedBefore - b.castle.hp;

  assert.ok(buffed > plain, `expected a damage buff (${buffed} vs ${plain})`);
  assert.ok(
    b.statuses.some((s) => s.id === "darkened"),
    "the attack did not darken the victim",
  );
});

test("without the buff Dark still only strikes one kingdom", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "dark"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  const c = match.gameState!.getPlayer("c")!;
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, SHADOW_STRIKE.id).ok, true);

  assert.equal(
    activateAbility(match, a, SHADOW_STRIKE, {
      forceCrit: false,
      rng: () => 0.5,
      targetIds: [b.id, c.id],
    }).ok,
    true,
  );
  assert.ok(b.castle.hp < b.castle.maxHp, "the first target was not hit");
  assert.equal(c.castle.hp, c.castle.maxHp, "a second target was hit without the buff");
});

test("the meter fills at 1250 absorbed and returns 1500", () => {
  // Both numbers are tuning the user set explicitly, so they are pinned rather
  // than left to "it dealt some damage". The threshold was lowered from 2000
  // to make the ability reachable more often; the payload deliberately did not
  // change, so Rage arrives sooner rather than hitting harder.
  assert.equal(DARK.RAGE_FULL, 1250);

  const { match, a, b } = darkMatch();
  // Exactly the stated punishment fills it — no more, no less.
  applyDamage(a, 1_249, { tick: 1 });
  assert.equal(a.rageMeter, 1_249);
  assert.equal(cast(match, a, UNLIMITED_RAGE).ok, false, "fired below full");

  applyDamage(a, 1, { tick: 2 });
  assert.equal(a.rageMeter, DARK.RAGE_FULL);

  const hpBefore = b.castle.hp;
  assert.equal(cast(match, a, UNLIMITED_RAGE).ok, true);
  assert.equal(hpBefore - b.castle.hp, 1500);
});
