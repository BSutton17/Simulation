import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeadlessMatch } from "../simulation/src/headless.js";
import { mulberry32 } from "../simulation/src/rng.js";
import {
  CAST_BASE,
  INVEST_BASE,
  KIT_SLOTS,
  ObservedHistory,
  WAIT,
  createMask,
  knowledgeFor,
  legalActions,
  legalPrimaryCount,
} from "../simulation/src/ai/index.js";
import { activateAbility } from "../src/engine/abilities.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { KINGDOM_IDS, type KingdomId } from "../src/data/kingdoms.js";
import type { Match } from "../src/match/Match.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * The action mask against the engine's own verdict.
 *
 * The mask is a second implementation of rules the engine already owns, and a
 * second implementation is a second thing that can be wrong. Two failure modes
 * matter and they are not symmetric: masking something the engine would ALLOW
 * silently removes a move from the network's repertoire forever, which no
 * runtime error would ever reveal; masking something the engine would REFUSE
 * costs a wasted decision. So both directions are checked against the engine
 * rather than against a restatement of the rules.
 */

interface Fixture {
  match: Match;
  me: PlayerState;
  enemy: PlayerState;
}

/**
 * A fresh match, so an attempted cast never contaminates the next assertion.
 *
 * Three seats rather than two, so there is always an enemy that is NOT the
 * current target — the mask deliberately excludes re-selecting whoever is
 * already targeted, because the engine treats that as a no-op and spending a
 * decision on it would be waste.
 */
function fixture(kingdomId: KingdomId, rich: boolean): Fixture {
  const filler: KingdomId[] = (["water", "fire", "earth"] as KingdomId[]).filter(
    (k) => k !== kingdomId,
  );
  const match = createHeadlessMatch(
    [{ kingdomId }, { kingdomId: filler[0]! }, { kingdomId: filler[1]! }],
    { rng: mulberry32(4242) },
  );
  match.tick = 500; // past every start-of-match cooldown gate
  const state = match.gameState!;
  const me = state.getPlayers()[0]!;
  const enemy = state.getPlayers()[1]!;
  me.target = enemy.id;
  // Unlocked in BOTH fixtures. The unlock gate is not enforced by
  // `activateAbility` at all — it lives in the socket handler
  // (`net/matchHandlers.ts:79`), so the mask is deliberately STRICTER than the
  // engine function on that one point. Holding it constant here keeps this
  // suite comparing the rules the engine actually owns: funds, cooldowns,
  // charges, meters, status bans and targeting.
  for (const ability of abilitiesForKingdom(kingdomId)) {
    if (ability.kind !== "passive") me.unlocked[ability.id] = true;
  }
  if (rich) me.economy.currency = 1_000_000;
  else me.economy.currency = 0;
  return { match, me, enemy };
}

function maskFor(f: Fixture): Uint8Array {
  const knowledge = knowledgeFor(f.match, f.me, new ObservedHistory());
  return legalActions(knowledge, createMask());
}

test("WAIT is legal in every kingdom, rich or broke", () => {
  for (const kingdomId of KINGDOM_IDS) {
    for (const rich of [true, false]) {
      const mask = maskFor(fixture(kingdomId, rich));
      assert.equal(mask[WAIT], 1, `${kingdomId} (rich=${rich}) lost its WAIT action`);
    }
  }
});

test("the mask is never empty, even in a fully locked-down state", () => {
  const f = fixture("water", false);
  f.me.economy.currency = 0;
  f.me.castle.hp = f.me.castle.maxHp; // repair unavailable
  for (const p of f.match.gameState!.getPlayers()) {
    if (p.id !== f.me.id) p.eliminated = true; // nothing to target or attack
  }
  f.me.statuses.push(
    { id: "frozen", sourceId: f.enemy.id, remainingTicks: 100, stacks: 1, blocksAttacks: true },
    { id: "toxicGas", sourceId: f.enemy.id, remainingTicks: 100, stacks: 1, blocksPurchases: true },
    { id: "fireflies", sourceId: f.enemy.id, remainingTicks: 100, stacks: 1, blocksBearerShield: true },
  );
  const mask = maskFor(f);
  assert.equal(legalPrimaryCount(mask), 1, "only WAIT should survive");
  assert.equal(mask[WAIT], 1);
});

test("every cast the mask permits is accepted by the engine", () => {
  const refused: string[] = [];
  for (const kingdomId of KINGDOM_IDS) {
    const probe = maskFor(fixture(kingdomId, true));
    const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
    for (let slot = 0; slot < KIT_SLOTS; slot++) {
      if (probe[CAST_BASE + slot] !== 1) continue;
      // A fresh, identically-configured match per attempt: casting mutates.
      const f = fixture(kingdomId, true);
      const ability = kit[slot]!;
      // ⚠️ SUPPLY THE PAYLOAD THE ABILITY DECLARES, exactly as the controller
      // does. The mask now permits casts whose legality DEPENDS on a payload —
      // BFFS needs a partner, Yin and Yang needs a named choice — so probing
      // them bare would report drift that does not exist while hiding any that
      // does. `controller.ts` builds these from the SECOND_TARGET and
      // CHOICE_PICK heads; this mirrors it.
      const partner = f.match.gameState!
        .getPlayers()
        .find((p) => p.id !== f.me.id && p.id !== f.me.target);
      const result = activateAbility(f.match, f.me, ability, {
        targetId: f.me.target ?? undefined,
        targetIds:
          ability.targeting.secondTarget === true && f.me.target && partner
            ? [f.me.target, partner.id]
            : undefined,
        choice: ability.targeting.choices?.[0],
      });
      if (!result.ok) refused.push(`${kingdomId}/${kit[slot]!.id}: ${result.error}`);
    }
  }
  assert.deepEqual(
    refused,
    [],
    "the mask permitted a cast the engine refused — legality.ts has drifted",
  );
});

test("every cast the mask forbids is refused by the engine", () => {
  const accepted: string[] = [];
  for (const kingdomId of KINGDOM_IDS) {
    // Broke and fully locked: every ability should be masked off, and the
    // engine should independently agree.
    const probe = maskFor(fixture(kingdomId, false));
    const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
    for (let slot = 0; slot < KIT_SLOTS; slot++) {
      if (probe[CAST_BASE + slot] === 1) continue;
      const f = fixture(kingdomId, false);
      const result = activateAbility(f.match, f.me, kit[slot]!, {
        targetId: f.me.target ?? undefined,
      });
      if (result.ok) accepted.push(`${kingdomId}/${kit[slot]!.id}`);
    }
  }
  assert.deepEqual(
    accepted,
    [],
    "the mask forbade a cast the engine allowed — the network has lost a legal move",
  );
});

test("a locked ability can be invested in but not cast", () => {
  // The gate the engine function does NOT apply — so if the mask ever stops
  // applying it, a network could cast abilities it never bought.
  const f = fixture("water", false);
  f.me.unlocked = {};
  f.me.economy.currency = 1_000_000;
  const mask = maskFor(f);
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    assert.equal(mask[CAST_BASE + slot], 0, `slot ${slot} castable while locked`);
    assert.equal(mask[INVEST_BASE + slot], 1, `slot ${slot} not investable`);
  }
});

test("a cooldown closes exactly one cast slot", () => {
  const f = fixture("water", true);
  const kit = abilitiesForKingdom("water").filter((a) => a.kind !== "passive");
  const before = maskFor(f);
  const openSlot = before.findIndex((v, i) => i >= CAST_BASE && i < CAST_BASE + KIT_SLOTS && v === 1);
  assert.ok(openSlot >= 0, "fixture should leave something castable");
  f.me.cooldowns[kit[openSlot - CAST_BASE]!.id] = 200;
  assert.equal(maskFor(f)[openSlot], 0);
});

test("attack bans close attacks but leave utilities open", () => {
  const f = fixture("water", true);
  f.me.statuses.push({
    id: "frozen", sourceId: f.enemy.id, remainingTicks: 100, stacks: 1, blocksAttacks: true,
  });
  const mask = maskFor(f);
  const kit = abilitiesForKingdom("water").filter((a) => a.kind !== "passive");
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    if (kit[slot]!.kind === "attack") {
      assert.equal(mask[CAST_BASE + slot], 0, `${kit[slot]!.id} castable while frozen`);
    }
  }
});

test("purchases follow the engine's own gates", () => {
  const f = fixture("water", true);
  const rich = maskFor(f);
  assert.equal(rich[10], 1, "a rich player should be able to hire");
  assert.equal(rich[11], 0, "a full-HP castle cannot be repaired");
  assert.equal(rich[12], 1, "an unshielded rich player should be able to shield");

  f.me.castle.hp = Math.round(f.me.castle.maxHp * 0.5);
  assert.equal(maskFor(f)[11], 1, "a damaged castle should be repairable");

  f.me.castle.shield = 500;
  assert.equal(maskFor(f)[12], 0, "a standing shield blocks another purchase");
});

test("targeting is masked while the switch cooldown is live", () => {
  const f = fixture("water", true);
  const enemies = [14, 15, 16, 17, 18, 19];
  const open = maskFor(f);
  assert.ok(enemies.some((i) => open[i] === 1), "a fresh seat should be able to aim");

  f.me.target = null;
  f.me.targetSwitchReadyTick = f.match.tick + 100;
  const locked = maskFor(f);
  assert.ok(enemies.every((i) => locked[i] === 0), "switch cooldown was ignored");
  assert.equal(locked[20], 0, "the gate should close when no target is legal");
});

test("an ability whose payload the heads CAN describe is offered", () => {
  // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the point.
  // While the action space had 22 heads it could not carry a second target or a
  // declared choice, so `legality.ts` fenced those abilities off entirely —
  // love/bffs and dark/yinAndYang were unreachable at any price, which no
  // balance change could ever fix. SPREAD_GATE, SECOND_TARGET and CHOICE_PICK
  // describe all three payloads now.
  //
  // The rule is asserted rather than the old list, so an ability added later
  // with a genuinely inexpressible payload still has to be handled deliberately.
  for (const kingdomId of KINGDOM_IDS) {
    const probe = maskFor(fixture(kingdomId, true));
    const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
    for (let slot = 0; slot < KIT_SLOTS; slot++) {
      const ability = kit[slot];
      if (!ability) continue;
      const needsPayload =
        ability.targeting.secondTarget === true || ability.targeting.choices !== undefined;
      if (!needsPayload) continue;
      assert.equal(
        probe[CAST_BASE + slot],
        1,
        `${kingdomId}/${ability.id} needs a payload the heads can now carry, but is masked off`,
      );
    }
  }
});

test("charge fraction is masked off for the fifteen kingdoms without charges", () => {
  for (const kingdomId of KINGDOM_IDS) {
    const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
    const hasCharges = kit.some((a) => a.chargeSystem !== undefined);
    const mask = maskFor(fixture(kingdomId, true));
    if (!hasCharges) {
      assert.equal(mask[21], 0, `${kingdomId} offered a charge fraction it cannot use`);
    }
  }
});

test("a cast is refused when the current target has barred this seat from aiming at it", () => {
  // Regression. The engine applies its targeting bans to the CURRENT selection,
  // not only to a new one: Water's Flood bars its victim from aiming at Water,
  // and a seat that was already targeting Water stays targeting it. A mask that
  // asked only "is the target alive" kept proposing casts the engine refused —
  // 70 of them in a single match, which killed a training run at generation 4.
  const f = fixture("water", true);
  const before = maskFor(f);
  const castable = before.findIndex(
    (v, i) => i >= CAST_BASE && i < CAST_BASE + KIT_SLOTS && v === 1,
  );
  assert.ok(castable >= 0, "fixture should leave something castable");

  // The current target applies a status barring this seat from targeting it.
  f.me.statuses.push({
    id: "flood",
    sourceId: f.enemy.id,
    remainingTicks: 200,
    stacks: 1,
    blocksTargetingSource: true,
  });

  const after = maskFor(f);
  const kit = abilitiesForKingdom("water").filter((a) => a.kind !== "passive");
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    if (kit[slot]!.targeting.mode !== "singleEnemy") continue;
    assert.equal(
      after[CAST_BASE + slot],
      0,
      `${kit[slot]!.id} still offered while the target bars this seat`,
    );
  }
});

test("a barred target is neither attackable nor selectable", () => {
  const f = fixture("water", true);
  f.me.statuses.push({
    id: "flood",
    sourceId: f.enemy.id,
    remainingTicks: 200,
    stacks: 1,
    blocksTargetingSource: true,
  });
  const knowledge = knowledgeFor(f.match, f.me, new ObservedHistory());
  const barred = knowledge.enemies.find((e) => e.id === f.enemy.id)!;
  assert.equal(barred.attackable, false);
  assert.equal(barred.targetable, false);
  // Other kingdoms are unaffected — the ban is per-source, not blanket.
  const other = knowledge.enemies.find((e) => e.id !== f.enemy.id)!;
  assert.equal(other.attackable, true);
});

test("an allEnemies cast needs a living enemy this seat is not barred from", () => {
  // Regression, found by the diagnostics in a seven-seat game. The engine
  // filters allEnemies targets by the same targeting bans and refuses with
  // INVALID_TARGET when the filtered set is empty — so "is anyone alive" is not
  // the question. Caprice is deliberately NOT part of it: its protection covers
  // one named target and an allEnemies cast still lands on everyone else.
  const f = fixture("air", true);
  const kit = abilitiesForKingdom("air").filter((a) => a.kind !== "passive");
  const allEnemiesSlot = kit.findIndex((a) => a.targeting.mode === "allEnemies");
  if (allEnemiesSlot < 0) return; // kingdom has none; nothing to assert

  assert.equal(maskFor(f)[CAST_BASE + allEnemiesSlot], 1, "should start castable");

  // Every living enemy bars this seat from aiming at them.
  for (const enemy of f.match.gameState!.getPlayers()) {
    if (enemy.id === f.me.id) continue;
    f.me.statuses.push({
      id: `flood-${enemy.id}`,
      sourceId: enemy.id,
      remainingTicks: 200,
      stacks: 1,
      blocksTargetingSource: true,
    });
  }

  assert.equal(
    maskFor(f)[CAST_BASE + allEnemiesSlot],
    0,
    "offered an allEnemies cast with every enemy barred",
  );
});


// ---------------------------------------------------------------------------
// The three payloads the action space used to be unable to describe
//
// `legality.ts` refused any cast whose payload the heads could not carry, and
// that refusal never consulted cost — so Love's BFFS and Dark's Yin and Yang
// were unreachable at ANY price, and Air could never spread. SPREAD_GATE,
// SECOND_TARGET and CHOICE_PICK express all three now.
//
// Asserted against the ENGINE, not against the mask: a head that produces a
// payload the engine still refuses would leave the policy learning only that
// the slot is broken.
// ---------------------------------------------------------------------------

test("BFFS is offered, and the engine accepts the second target", () => {
  const f = fixture("love", true);
  const kit = abilitiesForKingdom("love").filter((a) => a.kind !== "passive");
  const slot = kit.findIndex((a) => a.id === "bffs");
  assert.ok(slot >= 0, "love should own bffs");

  assert.equal(maskFor(f)[slot], 1, "bffs must now be a legal cast");

  // A THIRD kingdom is the partner: the engine rejects a second target equal to
  // the primary, which is exactly the mis-cast the old mask avoided by refusing.
  const others = f.match.gameState!.getPlayers().filter(
    (p) => p.id !== f.me.id && p.id !== f.enemy.id,
  );
  const result = activateAbility(f.match, f.me, kit[slot]!, {
    targetId: f.enemy.id,
    targetIds: [f.enemy.id, others[0]!.id],
  });
  assert.equal(result.ok, true, `engine refused BFFS: ${result.ok ? "" : result.error}`);
});

test("Yin and Yang is offered, and the engine accepts a declared choice", () => {
  const f = fixture("dark", true);
  const kit = abilitiesForKingdom("dark").filter((a) => a.kind !== "passive");
  const slot = kit.findIndex((a) => a.id === "yinAndYang");
  assert.ok(slot >= 0, "dark should own yinAndYang");

  assert.equal(maskFor(f)[slot], 1, "yinAndYang must now be a legal cast");

  const choices = kit[slot]!.targeting.choices!;
  assert.ok(choices.length > 0, "the ability should declare its options");
  for (const choice of choices) {
    const fresh = fixture("dark", true);
    const result = activateAbility(fresh.match, fresh.me, kit[slot]!, {
      targetId: fresh.enemy.id,
      choice,
    });
    assert.equal(result.ok, true, `engine refused choice "${choice}"`);
  }
});

test("Air spreads one cast across several kingdoms", () => {
  const f = fixture("air", true);
  const kit = abilitiesForKingdom("air").filter((a) => a.kind !== "passive");
  const breeze = kit.find((a) => a.id === "aLightBreeze")!;

  const enemies = f.match.gameState!.getPlayers().filter((p) => p.id !== f.me.id);
  assert.ok(enemies.length >= 2, "need at least two enemies to spread across");
  const before = enemies.map((e) => e.castle.hp);

  const result = activateAbility(f.match, f.me, breeze, {
    targetId: enemies[0]!.id,
    targetIds: enemies.map((e) => e.id),
  });
  assert.equal(result.ok, true);

  const struck = enemies.filter((e, i) => e.castle.hp < before[i]!).length;
  assert.ok(struck >= 2, `one cast should have hit several kingdoms, hit ${struck}`);
});
