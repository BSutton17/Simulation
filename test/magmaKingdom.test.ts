import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility, resolveAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyStatus, processStatusTicks } from "../src/engine/status.js";
import { earn } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { tickMatch } from "../src/engine/tick.js";
import { VOLCANO_TARGET_ID } from "../src/match/GameState.js";
import {
  damageVolcano,
  resolveVolcano,
  applyVolcanoStatus,
  VOLCANO_HP_PER_PLAYER,
} from "../src/engine/volcano.js";
import { FIRENADO } from "../src/data/fireAbilities.js";
import { WATER_BALL } from "../src/data/waterAbilities.js";
import {
  LAVA_PUNCH,
  ERUPTION,
  FLOOR_IS_LAVA,
  SMOKE_SCREEN,
  THE_END_OF_THE_WORLD,
  MAGMA_BURN_STATUS,
  MAGMA_BURN_DURATION,
} from "../src/data/magmaAbilities.js";
import { BURN_STATUS } from "../src/data/fireAbilities.js";
import { FOX_FIRE_STATUS } from "../src/data/kitsuneAbilities.js";
import { MAGMA, TICK } from "../src/data/balance.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Magma is a burn kingdom whose damage arrives over time and goes through
// shields ("Hotter fire"). These pin the three designed abilities.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function magmaMatch(other = "water"): {
  match: Match;
  a: PlayerState;
  b: PlayerState;
} {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "magma"));
  match.addPlayer(matchPlayer("b", other));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  earn(a, 1_000_000);
  earn(b, 1_000_000);
  for (const ability of [LAVA_PUNCH, ERUPTION, FLOOR_IS_LAVA]) {
    assert.equal(unlockOrUpgradeAbility(match, a, ability.id).ok, true);
  }
  a.target = b.id;
  return { match, a, b };
}

// --- Lava Punch --------------------------------------------------------------

test("Lava Punch always hits, and burns on a winning roll", () => {
  const { match, a, b } = magmaMatch();
  const hpBefore = b.castle.hp;

  // rng below the chance: the burn lands.
  assert.equal(
    activateAbility(match, a, LAVA_PUNCH, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  assert.ok(b.castle.hp < hpBefore, "Lava Punch dealt no damage");
  assert.ok(
    b.statuses.some((s) => s.id === MAGMA_BURN_STATUS.id),
    "the burn never landed",
  );
});

test("Lava Punch still lands its damage when the burn roll fails", () => {
  const { match, a, b } = magmaMatch();
  const hpBefore = b.castle.hp;

  // rng above the chance: damage only.
  assert.equal(
    activateAbility(match, a, LAVA_PUNCH, { forceCrit: false, rng: () => 0.99 }).ok,
    true,
  );
  assert.ok(b.castle.hp < hpBefore, "a failed burn roll cost the damage too");
  assert.equal(
    b.statuses.some((s) => s.id === MAGMA_BURN_STATUS.id),
    false,
    "the burn landed on a losing roll",
  );
});

test("the burn chance is the stated 35%", () => {
  assert.equal(MAGMA.LAVA_PUNCH_BURN_CHANCE, 0.35);
  const burnEffect = LAVA_PUNCH.effects.find((e) => e.type === "status");
  assert.equal(burnEffect?.chance, MAGMA.LAVA_PUNCH_BURN_CHANCE);
});

// --- Eruption ----------------------------------------------------------------

test("Eruption hits hard, and only sometimes burns", () => {
  const { match, a, b } = magmaMatch();
  const hpBefore = b.castle.hp;

  // The damage is the point of Eruption; the burn is a bonus. Lighting people
  // reliably is Lava Punch's job.
  assert.equal(
    activateAbility(match, a, ERUPTION, { forceCrit: false, rng: () => 0.99 }).ok,
    true,
  );
  assert.ok(hpBefore - b.castle.hp >= 400, "Eruption hit softly");
  assert.ok(
    !b.statuses.some((s) => s.id === MAGMA_BURN_STATUS.id),
    "a losing roll should not burn",
  );

  // A winning roll does light them.
  a.cooldowns = {};
  assert.equal(
    activateAbility(match, a, ERUPTION, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  assert.ok(
    b.statuses.some((s) => s.id === MAGMA_BURN_STATUS.id),
    "a winning roll should burn",
  );
});

test("Eruption's burn chance is the stated 20%", () => {
  // Pinned against the constant rather than the literal, so a balance change
  // moves this test with it instead of breaking it.
  const roll = resolveAbility(ERUPTION, 0).effects[1].chance;
  assert.equal(roll, MAGMA.ERUPTION_BURN_CHANCE);
  assert.equal(roll, 0.2);
});

// --- Hotter fire (the passive, through a real Magma burn) --------------------

test("a Magma burn goes through a shield untouched", () => {
  const { match, a, b } = magmaMatch();
  b.castle.shield = 5000;
  const shieldBefore = b.castle.shield;
  const hpBefore = b.castle.hp;

  // rng 0 forces the burn: Eruption only rolls it now, and this test is about
  // where the burn LANDS, not whether it caught.
  assert.equal(
    activateAbility(match, a, ERUPTION, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  // The direct hit is absorbed as normal...
  assert.ok(b.castle.shield < shieldBefore, "the shield took nothing at all");

  // ...but the burn ticks straight onto the castle.
  const shieldAfterHit = b.castle.shield;
  const hpAfterHit = b.castle.hp;
  processStatusTicks(match.gameState!, () => 0.5);
  assert.equal(b.castle.shield, shieldAfterHit, "the shield absorbed the burn");
  assert.ok(b.castle.hp < hpAfterHit, "the burn did nothing");
  assert.equal(hpAfterHit, hpBefore, "the direct hit leaked past the shield");
});

// --- Floor is Lava -----------------------------------------------------------

/** Runs one burn tick and reports the damage it did. */
function burnTick(match: Match, victim: PlayerState): number {
  const before = victim.castle.hp;
  processStatusTicks(match.gameState!, () => 0.5);
  return before - victim.castle.hp;
}

test("Floor is Lava makes every burn on the field hit harder", () => {
  const { match, a, b } = magmaMatch();
  applyStatus(b, MAGMA_BURN_STATUS, {
    sourceId: a.id,
    durationTicks: MAGMA_BURN_DURATION,
  });
  const plain = burnTick(match, b);
  assert.ok(plain > 0);

  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
  const molten = burnTick(match, b);

  assert.ok(molten > plain, `expected a hotter burn (${molten} vs ${plain})`);
  assert.equal(molten, Math.round(plain * MAGMA.LAVA_FLOOR_BURN_MULTIPLIER));
});

test("Floor is Lava fans OTHER kingdoms' burns too, not just Magma's", () => {
  // Fire's Burn and Kitsune's foxfire are both fire — the floor does not care
  // who lit them.
  for (const status of [BURN_STATUS, FOX_FIRE_STATUS]) {
    const { match, a, b } = magmaMatch();
    applyStatus(b, status, { sourceId: b.id, durationTicks: 10 * TICK.RATE });
    const plain = burnTick(match, b);
    assert.ok(plain > 0, `${status.id} did no damage to begin with`);

    assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
    assert.ok(
      burnTick(match, b) > plain,
      `${status.id} was not fanned by the lava floor`,
    );
  }
});

test("Floor is Lava does NOT amplify damage-over-time that isn't a burn", () => {
  const { match, a, b } = magmaMatch("nature");
  const poison = {
    id: "testPoison",
    name: "Test Poison",
    category: "debuff" as const,
    stacking: "refresh" as const,
    tickEffects: [{ type: "damage" as const, amount: 20 }],
  };
  applyStatus(b, poison, { sourceId: b.id, durationTicks: 10 * TICK.RATE });
  const plain = burnTick(match, b);

  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
  assert.equal(burnTick(match, b), plain, "a non-burn DoT was amplified");
});

test("the floor cools, and burns go back to normal", () => {
  const { match, a, b } = magmaMatch();
  applyStatus(b, MAGMA_BURN_STATUS, {
    sourceId: a.id,
    durationTicks: 10_000,
  });
  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
  const molten = burnTick(match, b);

  // Past the duration the floor is cold again.
  match.gameState!.tick =
    match.tick + MAGMA.LAVA_FLOOR_DURATION_SECONDS * TICK.RATE + 1;
  const cooled = burnTick(match, b);
  assert.ok(cooled < molten, `expected a cooler burn (${cooled} vs ${molten})`);
});

// --- Smoke Screen ------------------------------------------------------------

test("Smoke Screen singes and blinds everyone aiming at Magma", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "magma"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "fire"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  const c = match.gameState!.getPlayer("c")!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, SMOKE_SCREEN.id).ok, true);

  b.target = a.id; // aiming at Magma
  c.target = b.id; // aiming elsewhere
  const bBefore = b.castle.hp;
  const cBefore = c.castle.hp;

  assert.equal(activateAbility(match, a, SMOKE_SCREEN).ok, true);

  assert.ok(b.castle.hp < bBefore, "the kingdom aiming at Magma was untouched");
  assert.ok(b.statuses.some((s) => s.id === "smokeScreen"), "no blind landed");
  assert.equal(c.castle.hp, cBefore, "a kingdom aiming elsewhere was hit");
  assert.equal(c.statuses.some((s) => s.id === "smokeScreen"), false);
});

// --- The End of the World ----------------------------------------------------

test("the volcano is sized off the living kingdoms", () => {
  const { match, a } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  const volcano = match.gameState!.volcano!;
  assert.ok(volcano, "no volcano appeared");
  assert.equal(volcano.maxHp, VOLCANO_HP_PER_PLAYER * 2); // two living kingdoms
  assert.equal(volcano.hp, volcano.maxHp);
  assert.equal(volcano.ownerId, a.id);
});

test("everyone but Magma can target and hit the volcano", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  // Magma cannot help — it is the one kingdom the eruption spares.
  assert.equal(selectTarget(match, a, VOLCANO_TARGET_ID).ok, false);

  assert.equal(selectTarget(match, b, VOLCANO_TARGET_ID).ok, true);
  assert.equal(unlockOrUpgradeAbility(match, b, WATER_BALL.id).ok, true);
  const hpBefore = match.gameState!.volcano!.hp;
  assert.equal(activateAbility(match, b, WATER_BALL, { forceCrit: false }).ok, true);
  assert.ok(match.gameState!.volcano!.hp < hpBefore, "the swing did nothing");
  assert.equal(match.gameState!.volcano!.contributions[b.id]! > 0, true);
});

test("an eruption charges the whole field ONE shared shortfall", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "magma"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "fire"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  const c = match.gameState!.getPlayer("c")!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  // b helps, c does nothing at all — and it makes no difference to the bill.
  damageVolcano(match, b.id, 1000);

  const aBefore = a.castle.hp;
  const bBefore = b.castle.hp;
  const cBefore = c.castle.hp;
  match.tick = match.gameState!.volcano!.endTick;
  resolveVolcano(match);

  assert.equal(a.castle.hp, aBefore, "Magma was hit by its own volcano");
  const owed = MAGMA.VOLCANO_ERUPTION_YIELD - 1000;
  assert.equal(bBefore - b.castle.hp, owed);
  assert.equal(
    cBefore - c.castle.hp,
    owed,
    "the free-rider was charged differently — the bill is shared",
  );
});

test("a field that collectively covers the yield walks away clean", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  // Enough between them to cover the whole yield, without breaking it.
  damageVolcano(match, b.id, MAGMA.VOLCANO_ERUPTION_YIELD);
  const before = b.castle.hp;
  match.tick = match.gameState!.volcano!.endTick;
  resolveVolcano(match);
  assert.equal(b.castle.hp, before, "a covered shortfall still charged the field");
});

test("breaking the volcano in time spares everyone", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  damageVolcano(match, b.id, match.gameState!.volcano!.maxHp);
  const before = b.castle.hp;
  resolveVolcano(match);

  assert.equal(match.gameState!.volcano, null, "the volcano is still standing");
  assert.equal(b.castle.hp, before, "a broken volcano still erupted");
});

test("overkill on the volcano is not credited", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  const maxHp = match.gameState!.volcano!.maxHp;
  const dealt = damageVolcano(match, b.id, maxHp + 99_999);
  assert.equal(dealt, maxHp, "overkill was counted");
  assert.equal(match.gameState!.volcano!.contributions[b.id], maxHp);
});

test("the volcano is sized off ALIVE kingdoms, not the room", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "magma"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "fire"));
  match.addPlayer(matchPlayer("d", "ice"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);

  // Two of the four are already out — the wall is built for who is left, not
  // for who joined the room.
  match.gameState!.getPlayer("c")!.eliminated = true;
  match.gameState!.getPlayer("d")!.eliminated = true;

  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);
  assert.equal(match.gameState!.volcano!.maxHp, VOLCANO_HP_PER_PLAYER * 2);
});

test("an eliminated kingdom is not charged by the eruption", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "magma"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "fire"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const c = match.gameState!.getPlayer("c")!;
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  c.eliminated = true;
  const cBefore = c.castle.hp;
  match.tick = match.gameState!.volcano!.endTick;
  resolveVolcano(match);
  assert.equal(c.castle.hp, cBefore, "a dead kingdom was charged");
});


// --- Balance: the lava floor spares its owner --------------------------------

test("Floor is Lava does not fan a burn on Magma itself", () => {
  const { match, a, b } = magmaMatch("fire");
  // A burn on MAGMA, lit by someone else.
  applyStatus(a, BURN_STATUS, { sourceId: b.id, durationTicks: 10 * TICK.RATE });
  const plain = burnTick(match, a);
  assert.ok(plain > 0);

  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
  assert.equal(
    burnTick(match, a),
    plain,
    "Magma was burned harder by its own floor",
  );
});

test("…but everyone else on that floor still burns hotter", () => {
  const { match, a, b } = magmaMatch();
  applyStatus(b, MAGMA_BURN_STATUS, {
    sourceId: a.id,
    durationTicks: MAGMA_BURN_DURATION,
  });
  const plain = burnTick(match, b);
  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA).ok, true);
  assert.ok(burnTick(match, b) > plain, "the floor stopped working entirely");
});

// --- Balance: a shield softens the burn without stopping it ------------------

test("a shield softens Magma's burn but never blocks it", () => {
  const { match, a, b } = magmaMatch();
  applyStatus(b, MAGMA_BURN_STATUS, {
    sourceId: a.id,
    durationTicks: MAGMA_BURN_DURATION,
  });

  b.castle.shield = 5000;
  const shieldBefore = b.castle.shield;
  const shielded = burnTick(match, b);
  assert.ok(shielded > 0, "the shield blocked the burn outright");
  assert.equal(b.castle.shield, shieldBefore, "the shield absorbed the burn");

  b.castle.shield = 0;
  const bare = burnTick(match, b);
  assert.ok(bare > shielded, `a shield should soften it (${shielded} vs ${bare})`);
  assert.equal(shielded, MAGMA.SHIELDED_BURN_TICK, "the softened tick is wrong");
});

test("Floor is Lava sharpens Magma's own attacks while it holds", () => {
  const { match, a, b } = magmaMatch();

  const punch = () => {
    a.cooldowns = {};
    b.castle.hp = 100_000;
    assert.equal(activateAbility(match, a, LAVA_PUNCH, { forceCrit: false, rng: () => 0.99 }).ok, true);
    return 100_000 - b.castle.hp;
  };

  const cold = punch();
  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA, { forceCrit: false }).ok, true);
  const molten = punch();

  // The burn multiplier is weather that helps everyone; this lift is Magma's
  // alone, and is what stops the ability being purely altruistic.
  assert.ok(molten > cold, "Floor is Lava did not sharpen Magma's attacks");
  const ratio = molten / cold;
  assert.ok(
    Math.abs(ratio - MAGMA.LAVA_FLOOR_ATTACK_MULTIPLIER) < 0.02,
    `expected roughly ${MAGMA.LAVA_FLOOR_ATTACK_MULTIPLIER}x, got ${ratio}`,
  );
});

test("the attack lift runs on the lava's own clock", () => {
  const { match, a } = magmaMatch();
  assert.equal(activateAbility(match, a, FLOOR_IS_LAVA, { forceCrit: false }).ok, true);

  const buff = a.statuses.find((s) => s.id === "moltenGround");
  assert.ok(buff, "Floor is Lava did not buff Magma");
  // Buffed on cold ground would be a free extension of the ability.
  assert.equal(
    buff.remainingTicks,
    MAGMA.LAVA_FLOOR_DURATION_SECONDS * TICK.RATE,
    "the buff outlives (or dies before) the lava",
  );
});

test("the volcano actually STANDS for its duration once cast", () => {
  // The user-facing symptom of getting this wrong is "I used the ultimate and
  // no volcano appeared" — which is what happens if it resolves on the same
  // tick it spawns, or if the tick loop tears it down early.
  const { match, a } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);
  assert.ok(match.gameState!.volcano, "no volcano the moment it was cast");

  const timer = MAGMA.VOLCANO_TIMER_SECONDS * TICK.RATE;
  // Still standing one tick short of its clock.
  for (let i = 1; i < timer; i++) {
    tickMatch(match, i);
    assert.ok(
      match.gameState!.volcano,
      `the volcano vanished on tick ${i} of ${timer}`,
    );
  }
  // …and gone once the clock is up.
  tickMatch(match, timer);
  assert.equal(match.gameState!.volcano, null, "the volcano outlived its clock");
});

test("the volcano's synced countdown falls as its clock runs down", () => {
  // `ticksRemaining` is derived in gameSync from `endTick - state.tick`; if the
  // two clocks ever diverge the client's countdown is wrong from the first
  // frame. This pins them to the same clock.
  const { match, a } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  const state = match.gameState!;
  const remaining = () => state.volcano!.endTick - state.tick;
  const atCast = remaining();
  assert.equal(atCast, MAGMA.VOLCANO_TIMER_SECONDS * TICK.RATE);

  for (let i = 1; i <= 40; i++) tickMatch(match, i);
  assert.ok(state.volcano, "the volcano should still be standing");
  assert.equal(remaining(), atCast - 40, "the countdown is on a different clock");
});

// --- statuses on the volcano -------------------------------------------------

test("an attack's burn lands on the volcano, not just its damage", () => {
  // An attack that silently drops half of itself when pointed at the volcano
  // is worse than one whose second half is visibly doing nothing.
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);
  assert.equal(selectTarget(match, b, VOLCANO_TARGET_ID).ok, true);

  assert.equal(
    activateAbility(match, b, FIRENADO, { targetId: VOLCANO_TARGET_ID, forceCrit: false }).ok,
    true,
  );
  const burn = match.gameState!.volcano!.statuses.find((s) => s.id === "burn");
  assert.ok(burn, "Firenado's guaranteed burn was dropped on the volcano");
  assert.equal(burn.sourceId, b.id);
});

test("a burn on the volcano actually burns it down, credited to whoever set it", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);
  assert.equal(selectTarget(match, b, VOLCANO_TARGET_ID).ok, true);
  assert.equal(
    activateAbility(match, b, FIRENADO, { targetId: VOLCANO_TARGET_ID, forceCrit: false }).ok,
    true,
  );

  const state = match.gameState!;
  const afterHit = state.volcano!.hp;
  const creditedAfterHit = state.volcano!.contributions[b.id] ?? 0;

  for (let i = 1; i <= 20; i++) tickMatch(match, i);

  assert.ok(state.volcano, "the volcano should still be standing");
  assert.ok(state.volcano!.hp < afterHit, "the burn did nothing to the volcano");
  // Setting a fire on it counts toward breaking it, exactly as swinging does.
  assert.ok(
    (state.volcano!.contributions[b.id] ?? 0) > creditedAfterHit,
    "DoT damage was not credited to the kingdom that set it",
  );
});

test("a status the mountain cannot feel still rides on it", () => {
  // A freeze has no attack to stop and no income to halt, so it does nothing
  // here — but it must still be APPLIED rather than silently discarded.
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  const inert = { id: "frozen", name: "Frozen", category: "crowdControl" as const, stacking: "refresh" as const };
  applyVolcanoStatus(match, b.id, inert, 10 * TICK.RATE);

  const held = match.gameState!.volcano!.statuses.find((s) => s.id === "frozen");
  assert.ok(held, "the volcano refused a status it cannot feel");
  const hp = match.gameState!.volcano!.hp;
  for (let i = 1; i <= 10; i++) tickMatch(match, i);
  assert.equal(match.gameState!.volcano!.hp, hp, "an inert status damaged the volcano");
});

test("a stacking DoT builds on the volcano the way it would on a castle", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  applyVolcanoStatus(match, b.id, MAGMA_BURN_STATUS, 10 * TICK.RATE);
  applyVolcanoStatus(match, b.id, MAGMA_BURN_STATUS, 10 * TICK.RATE);
  const burn = match.gameState!.volcano!.statuses.find((s) => s.id === MAGMA_BURN_STATUS.id)!;
  assert.equal(burn.stacks, 2, "the burn did not stack on the volcano");
});

test("volcano statuses expire on their own clock", () => {
  const { match, a, b } = magmaMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, THE_END_OF_THE_WORLD.id).ok, true);
  assert.equal(activateAbility(match, a, THE_END_OF_THE_WORLD).ok, true);

  applyVolcanoStatus(match, b.id, MAGMA_BURN_STATUS, 5);
  for (let i = 1; i <= 6; i++) tickMatch(match, i);
  assert.equal(
    match.gameState!.volcano!.statuses.length,
    0,
    "a status outlived its duration on the volcano",
  );
});
