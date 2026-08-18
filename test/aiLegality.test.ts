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
      const result = activateAbility(f.match, f.me, kit[slot]!, {
        targetId: f.me.target ?? undefined,
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

test("abilities needing payload the action space cannot express are masked off", () => {
  // Love's BFFS!!! wants a second distinct enemy; Dark's Yin and Yang wants the
  // caster to name a side. The 22 heads supply neither, and the engine rejects
  // both up-front, so they must never be proposed. Located by metadata here
  // exactly as legality.ts locates them, so this stays honest if the data moves.
  const blocked: string[] = [];
  for (const kingdomId of KINGDOM_IDS) {
    const kit = abilitiesForKingdom(kingdomId).filter((a) => a.kind !== "passive");
    const mask = maskFor(fixture(kingdomId, true));
    for (let slot = 0; slot < KIT_SLOTS; slot++) {
      const targeting = kit[slot]!.targeting;
      if (targeting.secondTarget === true || targeting.choices !== undefined) {
        blocked.push(`${kingdomId}/${kit[slot]!.id}`);
        assert.equal(
          mask[CAST_BASE + slot],
          0,
          `${kit[slot]!.id} was offered but cannot be cast by this action space`,
        );
      }
    }
  }
  // The fixture must actually contain such abilities, or this proves nothing.
  assert.deepEqual(blocked.sort(), ["dark/yinAndYang", "love/bffs"]);
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
