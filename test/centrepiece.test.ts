import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { tickMatch } from "../src/engine/tick.js";
import {
  CENTREPIECES,
  standingCentrepiece,
  centrepieceSpawnedBy,
} from "../src/engine/centrepiece.js";
import { THE_END_OF_THE_WORLD, LAVA_PUNCH } from "../src/data/magmaAbilities.js";
import { CAPRICE, VENOM_SHOT } from "../src/data/insectsAbilities.js";
import { BLACK_HOLE } from "../src/data/spaceAbilities.js";
import { LIGHT_SHOW, LIGHT_SHOW_DELAY } from "../src/data/lightAbilities.js";
import { MAGMA, INSECTS, TICK } from "../src/data/balance.js";
import type { AbilityDefinition } from "../src/engine/abilities.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// The middle of the battlefield is a single exclusive slot.
//
// FOUR abilities claim it: Magma's volcano, Insects' butterfly, Space's black
// hole and Light's disc. They contradict each other outright — the volcano
// needs everyone able to aim at it, Caprice takes everyone's aim away — and
// they would be drawn on top of one another. Only one may stand at a time, and
// the rule is symmetric: whichever lands first owns the centre.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

/**
 * Advances the match `count` ticks from wherever it is.
 *
 * `tickMatch` takes the tick as an argument rather than incrementing one — call
 * it without and `match.tick` becomes `undefined`, at which point every
 * `match.tick < endTick` comparison in the engine is quietly false and a
 * duration test passes for entirely the wrong reason.
 */
function runTicks(match: Match, count: number): void {
  for (let i = 0; i < count; i++) tickMatch(match, match.tick + 1);
}

/** One centrepiece: who casts it, with what, and how long it then holds. */
interface Claim {
  name: string;
  kingdom: string;
  /** Seat id in the table below. */
  seat: string;
  ability: AbilityDefinition;
  /** Ticks it occupies the centre for, once cast. */
  holdsTicks: number;
}

const CLAIMS: readonly Claim[] = [
  {
    name: "The End of the World",
    kingdom: "magma",
    seat: "m",
    ability: THE_END_OF_THE_WORLD,
    holdsTicks: MAGMA.VOLCANO_TIMER_SECONDS * TICK.RATE,
  },
  {
    name: "Caprice",
    kingdom: "insects",
    seat: "i",
    ability: CAPRICE,
    holdsTicks: INSECTS.CAPRICE_SECONDS * TICK.RATE,
  },
  {
    name: "Black Hole",
    kingdom: "space",
    seat: "s",
    ability: BLACK_HOLE,
    holdsTicks: 10 * TICK.RATE,
  },
  {
    name: "Light Show",
    kingdom: "light",
    seat: "l",
    ability: LIGHT_SHOW,
    holdsTicks: LIGHT_SHOW_DELAY,
  },
];

/** A table with every centrepiece kingdom seated, funded and unlocked. */
function table(): { match: Match; seats: Record<string, PlayerState> } {
  const match = new Match("1234");
  for (const c of CLAIMS) match.addPlayer(matchPlayer(c.seat, c.kingdom));
  match.hostId = CLAIMS[0]!.seat;
  match.start(createMatchConfig(match));

  const seats: Record<string, PlayerState> = {};
  for (const c of CLAIMS) {
    const p = match.gameState!.getPlayer(c.seat)!;
    earn(p, 1_000_000);
    // An ability at level 0 would be refused for a reason that has nothing to
    // do with the centre of the field.
    assert.equal(
      unlockOrUpgradeAbility(match, p, c.ability.id).ok,
      true,
      `could not unlock ${c.name}`,
    );
    seats[c.seat] = p;
  }
  // Everyone pointed somewhere legal, so a cast is never refused for want of a
  // target.
  for (const c of CLAIMS) {
    seats[c.seat]!.target = CLAIMS.find((o) => o.seat !== c.seat)!.seat;
  }
  return { match, seats };
}

// --- the registry ------------------------------------------------------------

test("every centre-of-the-field ability is registered", () => {
  // The guard is driven entirely off this list. An ability that spawns
  // something in the middle and is not registered here is invisible to it, and
  // will happily land on top of whatever is already there.
  assert.equal(CENTREPIECES.length, CLAIMS.length);
  for (const c of CLAIMS) {
    assert.ok(
      centrepieceSpawnedBy(c.ability),
      `${c.name} is not registered as a centrepiece`,
    );
  }
  // Registered under the names the players know them by.
  assert.deepEqual(
    [...CENTREPIECES].map((c) => c.name).sort(),
    CLAIMS.map((c) => c.name).sort(),
  );
});

test("ordinary abilities claim nothing", () => {
  // Read off the effects, so nothing has to remember to declare itself — and
  // so this rule cannot creep across the rest of the game.
  assert.equal(centrepieceSpawnedBy(LAVA_PUNCH), null);
  assert.equal(centrepieceSpawnedBy(VENOM_SHOT), null);
});

test("an empty field has nothing standing in it", () => {
  const { match } = table();
  assert.equal(standingCentrepiece(match), null);
});

// --- the exclusion, every pair, both directions ------------------------------

for (const first of CLAIMS) {
  for (const second of CLAIMS) {
    test(`${second.name} cannot be cast while ${first.name} holds the centre`, () => {
      const { match, seats } = table();

      assert.equal(
        activateAbility(match, seats[first.seat]!, first.ability).ok,
        true,
        `${first.name} would not cast on an empty field`,
      );
      assert.equal(
        standingCentrepiece(match)?.name,
        first.name,
        `${first.name} did not take the centre`,
      );

      // Same ability twice is refused for the same reason as any other pair:
      // the rule is about the board, not about which kingdom is casting.
      const caster = seats[second.seat]!;
      caster.cooldowns = {};
      const goldBefore = caster.economy.currency;

      const result = activateAbility(match, caster, second.ability);
      assert.equal(result.ok, false, `${second.name} landed on an occupied centre`);
      assert.equal(result.error, "FIELD_OCCUPIED");

      // The centre is still held by the FIRST one — the refused cast changed
      // nothing about what is standing there.
      assert.equal(standingCentrepiece(match)?.name, first.name);
      // …and cost the caster nothing. This is the difference between "wait for
      // the field to clear" and "you have wasted your ultimate".
      assert.equal(
        caster.economy.currency,
        goldBefore,
        `${second.name} was charged for a refused cast`,
      );
    });
  }
}

// --- the centre reopens ------------------------------------------------------

for (const first of CLAIMS) {
  test(`the centre reopens once ${first.name} is done`, () => {
    const { match, seats } = table();
    assert.equal(activateAbility(match, seats[first.seat]!, first.ability).ok, true);

    // +2 rather than +1: a centrepiece that clears ON its end tick and one that
    // clears the tick after would otherwise need different numbers here.
    runTicks(match, first.holdsTicks + 2);
    assert.equal(
      standingCentrepiece(match),
      null,
      `${first.name} never left the centre`,
    );

    // And every other centrepiece can now take the slot.
    for (const next of CLAIMS) {
      if (next.seat === first.seat) continue;
      const caster = seats[next.seat]!;
      caster.cooldowns = {};
      const result = activateAbility(match, caster, next.ability);
      assert.equal(result.ok, true, `${next.name} still refused on a clear field`);
      // Put it back for the next one in the loop.
      const state = match.gameState!;
      state.volcano = null;
      state.caprice = null;
      state.blackHole = null;
      state.pendingStrikes.length = 0;
      assert.equal(standingCentrepiece(match), null);
    }
  });
}

// --- a broken centrepiece frees the slot immediately -------------------------

test("a volcano broken early frees the centre at once", () => {
  // It clears on death, not merely when its timer would have run out — the
  // guard reads whether it is STANDING, not whether it was ever cast.
  const { match, seats } = table();
  assert.equal(activateAbility(match, seats.m!, THE_END_OF_THE_WORLD).ok, true);

  match.gameState!.volcano!.hp = 0;
  assert.equal(standingCentrepiece(match), null);
  assert.equal(activateAbility(match, seats.i!, CAPRICE).ok, true);
});

// --- what is NOT a centrepiece ----------------------------------------------

test("a Blackjack card in flight does not hold the centre", () => {
  // Joker's delayed strike shares `pendingStrikes` with Light Show but carries
  // a `targetId`: it is one card flying at one kingdom, not a disc over the
  // field. Counting it would let Joker lock out every ultimate in the game by
  // throwing a card.
  const { match, seats } = table();
  match.gameState!.pendingStrikes.push({
    ownerId: seats.l!.id,
    targetId: seats.m!.id,
    abilityId: "blackjackDraw",
    resolveTick: match.tick + 200,
    amount: 500,
    breaksShields: false,
  });

  assert.equal(standingCentrepiece(match), null, "a targeted card took the centre");
  assert.equal(activateAbility(match, seats.i!, CAPRICE).ok, true);
});

test("a standing centrepiece blocks nothing but other centrepieces", () => {
  // The guard is narrow on purpose: the volcano is a target the whole table has
  // to swing at, so the match must keep running normally underneath it.
  const { match, seats } = table();
  assert.equal(activateAbility(match, seats.m!, THE_END_OF_THE_WORLD).ok, true);

  assert.equal(activateAbility(match, seats.m!, LAVA_PUNCH).ok, true);
  assert.equal(activateAbility(match, seats.i!, VENOM_SHOT).ok, true);
});
