import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyStatus } from "../src/engine/status.js";
import { earn } from "../src/engine/money.js";
import {
  buildDeck,
  damageForRank,
  drawBlackjackCard,
  ACE_RANK,
  DAMAGE_PER_RANK,
  FACE_CARD_DAMAGE,
  JOKER_CARD_DAMAGE,
  DIAMOND_DAMAGE_MULTIPLIER,
} from "../src/engine/blackjack.js";
import { computeStat } from "../src/engine/modifiers.js";
import {
  ACE_OF_SPADES,
  BLACKJACK,
  BLACKJACK_IMPACT_DELAY,
  LUCKY_DRAW,
  STACKED_DECK_STATUS,
  STACKED_DECK_DURATION,
} from "../src/data/jokerAbilities.js";
import { resolvePendingStrikes } from "../src/engine/abilities.js";
import { describeResult, placeRouletteBet } from "../src/engine/roulette.js";
import { ROULETTE } from "../src/data/jokerAbilities.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Joker gambles. These tests pin the deck's composition and payouts, the one
// lever Joker has on its own odds, and Lucky Draw's two-roll structure.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function jokerMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "joker"));
  match.addPlayer(matchPlayer("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  earn(a, 1_000_000);
  for (const id of [ACE_OF_SPADES.id, BLACKJACK.id, LUCKY_DRAW.id]) {
    assert.equal(unlockOrUpgradeAbility(match, a, id).ok, true);
  }
  a.target = b.id;
  return { match, a, b };
}

// --- The deck ---------------------------------------------------------------

test("the deck is a real 52 cards plus two jokers", () => {
  const { a } = jokerMatch();
  const deck = buildDeck(a);
  assert.equal(deck.length, 54);
  assert.equal(deck.filter((c) => c.rank === null).length, 2); // the jokers
  // Four of every rank, Ace through King.
  for (let rank = 1; rank <= 13; rank++) {
    assert.equal(deck.filter((c) => c.rank === rank).length, 4, `rank ${rank}`);
  }
});

test("cards pay out by rank, with face cards and jokers flat", () => {
  assert.equal(damageForRank(2), 2 * DAMAGE_PER_RANK); // 150 — the worst draw
  assert.equal(damageForRank(7), 7 * DAMAGE_PER_RANK); // 525
  assert.equal(damageForRank(10), 10 * DAMAGE_PER_RANK); // 750
  for (const face of [11, 12, 13]) {
    assert.equal(damageForRank(face), FACE_CARD_DAMAGE);
  }
  // The Ace counts as 11 — 825, second only to a joker.
  assert.equal(damageForRank(1), ACE_RANK * DAMAGE_PER_RANK); // 825
  assert.equal(ACE_RANK, 11);
  assert.ok(damageForRank(1) > FACE_CARD_DAMAGE, "an Ace should beat a face card");
  assert.ok(damageForRank(1) < JOKER_CARD_DAMAGE, "only a joker beats an Ace");
  // The 2 is now the deck's floor.
  assert.equal(damageForRank(2), 150);

  const { a } = jokerMatch();
  const joker = buildDeck(a).find((c) => c.rank === null)!;
  assert.equal(joker.damage, JOKER_CARD_DAMAGE);
});

test("a draw is uniform over the deck — every copy is its own entry", () => {
  const { a } = jokerMatch();
  // rng() = 0 takes the first card, ~1 the last.
  assert.equal(drawBlackjackCard(a, () => 0).rank, 1); // an Ace
  assert.equal(drawBlackjackCard(a, () => 0.9999).rank, null); // a joker
});

// --- Ace of Spades: stacking the deck ---------------------------------------

test("Ace of Spades strips the 2s and 3s from Joker's own deck", () => {
  const { match, a, b } = jokerMatch();
  assert.equal(buildDeck(a).length, 54);

  const hpBefore = b.castle.hp;
  assert.equal(
    activateAbility(match, a, ACE_OF_SPADES, { forceCrit: false, rng: () => 0.5 }).ok,
    true,
  );
  assert.ok(b.castle.hp < hpBefore, "Ace of Spades dealt no damage");

  // Eight cards gone: four 2s and four 3s.
  const stacked = buildDeck(a);
  assert.equal(stacked.length, 46);
  assert.equal(stacked.some((c) => c.rank === 2 || c.rank === 3), false);
  // Everything else is untouched.
  assert.equal(stacked.filter((c) => c.rank === 4).length, 4);
  assert.equal(stacked.filter((c) => c.rank === null).length, 2);
});

test("the deck refills once the strip expires", () => {
  const { match, a } = jokerMatch();
  assert.equal(
    activateAbility(match, a, ACE_OF_SPADES, { forceCrit: false, rng: () => 0.5 }).ok,
    true,
  );
  assert.equal(buildDeck(a).length, 46);

  const strip = a.statuses.find((s) => s.id === STACKED_DECK_STATUS.id)!;
  assert.equal(strip.remainingTicks, STACKED_DECK_DURATION);
  a.statuses = a.statuses.filter((s) => s.id !== STACKED_DECK_STATUS.id);
  assert.equal(buildDeck(a).length, 54);
});

test("stripping the deck raises the AVERAGE draw but not the floor", () => {
  const { a } = jokerMatch();
  const mean = (p: PlayerState) => {
    const deck = buildDeck(p);
    return deck.reduce((sum, c) => sum + c.damage, 0) / deck.length;
  };
  const before = mean(a);
  applyStatus(a, STACKED_DECK_STATUS, { sourceId: a.id, durationTicks: 100 });
  assert.ok(mean(a) > before, `expected a better average (${mean(a)} vs ${before})`);

  // Aces survive the strip — they are among the BEST cards now, so removing
  // them would be Ace of Spades sabotaging its own draw.
  assert.equal(buildDeck(a).filter((c) => c.rank === 1).length, 4);
  // With the 2s and 3s gone the floor rises to the 4.
  assert.equal(Math.min(...buildDeck(a).map((c) => c.damage)), 4 * DAMAGE_PER_RANK);
});

// --- Blackjack --------------------------------------------------------------

test("Blackjack hits for the card it draws — when the card arrives", () => {
  const { match, a, b } = jokerMatch();
  // rng() = 0 draws the deck's first card (an Ace, 825).
  const hpBefore = b.castle.hp;
  assert.equal(
    activateAbility(match, a, BLACKJACK, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );

  // Nothing yet: the card is still being revealed on everyone's screen.
  assert.equal(b.castle.hp, hpBefore, "the victim was hurt before the card landed");
  assert.equal(match.gameState!.pendingStrikes.length, 1);

  match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(match);
  assert.equal(hpBefore - b.castle.hp, ACE_RANK * DAMAGE_PER_RANK);
});

test("a card in flight hurts nobody but its own target", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "joker"));
  match.addPlayer(matchPlayer("b", "water"));
  match.addPlayer(matchPlayer("c", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  const c = match.gameState!.getPlayer("c")!;
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, BLACKJACK.id).ok, true);
  a.target = b.id;

  assert.equal(
    activateAbility(match, a, BLACKJACK, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(match);

  assert.ok(b.castle.hp < b.castle.maxHp, "the target was not hit");
  assert.equal(c.castle.hp, c.castle.maxHp, "a bystander was hit");
  assert.equal(a.castle.hp, a.castle.maxHp, "Joker hit itself");
});

test("Blackjack's worst and best draws are the deck's own extremes", () => {
  const worst = jokerMatch();
  // The last card is a joker; the 2s sit early, right after the four Aces.
  assert.equal(
    activateAbility(worst.match, worst.a, BLACKJACK, {
      forceCrit: false,
      rng: () => 4 / 54, // first 2 in the deck
    }).ok,
    true,
  );
  worst.match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(worst.match);
  assert.equal(worst.b.castle.maxHp - worst.b.castle.hp, 2 * DAMAGE_PER_RANK);

  const best = jokerMatch();
  assert.equal(
    activateAbility(best.match, best.a, BLACKJACK, {
      forceCrit: false,
      rng: () => 0.9999, // a joker
    }).ok,
    true,
  );
  best.match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(best.match);
  assert.equal(best.b.castle.maxHp - best.b.castle.hp, JOKER_CARD_DAMAGE);
});

// --- Lucky Draw -------------------------------------------------------------

test("Lucky Draw always lands something", () => {
  // Whatever the rolls are, one of the five faces fires — there is no miss.
  for (const roll of [0, 0.5, 0.99]) {
    const { match, a } = jokerMatch();
    // Leave room for a heal to be observable; otherwise the heal face is
    // indistinguishable from nothing happening on a full-health castle.
    a.castle.hp = a.castle.maxHp - 3000;
    assert.equal(
      activateAbility(match, a, LUCKY_DRAW, { forceCrit: false, rng: () => roll }).ok,
      true,
    );
    const landed =
      a.statuses.length > 0 ||
      a.castle.shield > 0 ||
      a.castle.hp > a.castle.maxHp - 3000;
    assert.ok(landed, `a draw at roll ${roll} did nothing`);
  }
});

test("a draw picks exactly ONE of the five faces", () => {
  // The second roll selects the face: 0 → first, ~1 → last.
  const buff = jokerMatch();
  assert.equal(
    activateAbility(buff.match, buff.a, LUCKY_DRAW, { forceCrit: false, rng: () => 0 }).ok,
    true,
  );
  assert.deepEqual(
    buff.a.statuses.map((s) => s.id),
    ["luckyAttack"],
    "expected exactly the first face, and only it",
  );
  assert.equal(buff.a.castle.shield, 0);
});

test("the shield and heal faces land instantly", () => {
  // Face 4 of 5 (index 3) is the free shield; index 4 is the heal.
  const shielded = jokerMatch();
  let call = 0;
  assert.equal(
    activateAbility(shielded.match, shielded.a, LUCKY_DRAW, {
      forceCrit: false,
      rng: () => (call++ === 0 ? 0 : 3 / 5),
    }).ok,
    true,
  );
  assert.equal(shielded.a.castle.shield, 1000);
  assert.equal(shielded.a.statuses.length, 0, "the shield face is not a status");

  const healed = jokerMatch();
  healed.a.castle.hp = healed.a.castle.maxHp - 2000;
  call = 0;
  assert.equal(
    activateAbility(healed.match, healed.a, LUCKY_DRAW, {
      forceCrit: false,
      rng: () => (call++ === 0 ? 0 : 4 / 5),
    }).ok,
    true,
  );
  assert.equal(healed.a.castle.hp, healed.a.castle.maxHp - 1250); // 750 back
});

test("every one of the five faces is reachable", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const { match, a } = jokerMatch();
    let call = 0;
    assert.equal(
      activateAbility(match, a, LUCKY_DRAW, {
        forceCrit: false,
        rng: () => (call++ === 0 ? 0 : i / 5),
      }).ok,
      true,
    );
    const outcome =
      a.statuses[0]?.id ??
      (a.castle.shield > 0 ? "shield" : a.castle.hp < a.castle.maxHp ? "heal" : "none");
    seen.add(outcome);
  }
  assert.equal(seen.size, 5, `expected five distinct faces, saw ${[...seen]}`);
});

// --- Roulette: two points of view, one describer -----------------------------

test("a roulette verdict reads in second person for the bettor", () => {
  const lost = describeResult({ pocket: 17, color: "black", bet: "red", won: false, damage: 750, healed: 0 });
  assert.match(lost, /you missed/);
  assert.match(lost, /750 damage/);

  const won = describeResult({ pocket: 3, color: "red", bet: "red", won: true, damage: 375, healed: 0 });
  assert.match(won, /you called it/);

  const green = describeResult({ pocket: 0, color: "green", bet: "green", won: true, damage: 0, healed: 2000 });
  assert.match(green, /you hit green/);
});

test("the same verdict names the victim for everyone else watching", () => {
  // Joker's mirror shows OTHER kingdoms' wheels, so it must never say "you".
  const lost = describeResult(
    { pocket: 17, color: "black", bet: "red", won: false, damage: 750, healed: 0 },
    "Alice",
  );
  assert.match(lost, /Alice took 750 damage/);
  assert.doesNotMatch(lost, /\byou\b/i);

  const won = describeResult(
    { pocket: 3, color: "red", bet: "red", won: true, damage: 375, healed: 0 },
    "Alice",
  );
  assert.match(won, /Alice called it/);
  assert.doesNotMatch(won, /\byou\b/i);

  const green = describeResult(
    { pocket: 0, color: "green", bet: "green", won: true, damage: 0, healed: 2000 },
    "Alice",
  );
  assert.match(green, /Alice hit green/);
  assert.doesNotMatch(green, /\byou\b/i);
});

test("a settled bet carries both points of view", () => {
  const { match, a, b } = jokerMatch();
  b.name = "Alice";
  assert.equal(unlockOrUpgradeAbility(match, a, ROULETTE.id).ok, true);
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  placeRouletteBet(match, b, "red");

  const bet = b.lastBet!;
  assert.ok(bet.outcome.length > 0);
  // The bettor is addressed directly; everyone else is told about them.
  assert.match(bet.outcome, /\byou\b/i);
  assert.match(bet.publicOutcome, /Alice/);
  assert.doesNotMatch(bet.publicOutcome, /\byou\b/i);
});

// --- Blackjack: the suits ----------------------------------------------------

test("every card carries a suit, one of each per rank; jokers carry none", () => {
  const { a } = jokerMatch();
  const deck = buildDeck(a);
  for (let rank = 1; rank <= 13; rank++) {
    const suits = deck.filter((c) => c.rank === rank).map((c) => c.suit).sort();
    assert.deepEqual(suits, ["clubs", "diamonds", "hearts", "spades"], `rank ${rank}`);
  }
  // A joker is suitless — the deck's best card is pure damage, no rider.
  assert.equal(deck.filter((c) => c.rank === null).every((c) => c.suit === null), true);
});

test("diamonds hit 10% harder; the other suits hit for the plain rank", () => {
  const { a } = jokerMatch();
  const sevens = buildDeck(a).filter((c) => c.rank === 7);
  const diamond = sevens.find((c) => c.suit === "diamonds")!;
  const spade = sevens.find((c) => c.suit === "spades")!;
  assert.equal(spade.damage, 7 * DAMAGE_PER_RANK); // 525
  assert.equal(diamond.damage, Math.round(7 * DAMAGE_PER_RANK * DIAMOND_DAMAGE_MULTIPLIER)); // 578
  assert.ok(diamond.damage > spade.damage);
});

/** Draws a specific suit of a specific rank by picking its index in the deck. */
function drawIndex(player: PlayerState, predicate: (c: ReturnType<typeof buildDeck>[number]) => boolean) {
  const deck = buildDeck(player);
  const i = deck.findIndex(predicate);
  assert.ok(i >= 0, "no such card in the deck");
  return () => i / deck.length;
}

function landBlackjack(match: Match, a: PlayerState, rng: () => number) {
  assert.equal(activateAbility(match, a, BLACKJACK, { forceCrit: false, rng }).ok, true);
  match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(match);
}

test("a spade blunts the victim's own attacks", () => {
  const { match, a, b } = jokerMatch();
  landBlackjack(match, a, drawIndex(a, (c) => c.rank === 7 && c.suit === "spades"));
  const spade = b.statuses.find((s) => s.id === "blackjackSpade");
  assert.ok(spade, "no spade rider landed");
  assert.equal(computeStat(b, "damage", 1000), 900); // -10%
});

test("a club skims the victim's gold production", () => {
  const { match, a, b } = jokerMatch();
  landBlackjack(match, a, drawIndex(a, (c) => c.rank === 7 && c.suit === "clubs"));
  assert.ok(b.statuses.some((s) => s.id === "blackjackClub"), "no club rider landed");
  assert.equal(computeStat(b, "income", 100), 85); // -15%
});

test("a heart leaves the victim exposed to everything", () => {
  const { match, a, b } = jokerMatch();
  landBlackjack(match, a, drawIndex(a, (c) => c.rank === 7 && c.suit === "hearts"));
  assert.ok(b.statuses.some((s) => s.id === "blackjackHeart"), "no heart rider landed");
  assert.equal(computeStat(b, "damageTaken", 1000), 1150); // +15% taken
});

test("a diamond leaves NO rider — its whole bonus is the damage", () => {
  const { match, a, b } = jokerMatch();
  landBlackjack(match, a, drawIndex(a, (c) => c.rank === 7 && c.suit === "diamonds"));
  assert.equal(
    b.statuses.some((s) => s.id.startsWith("blackjack")),
    false,
    "a diamond applied a status it shouldn't have",
  );
});

test("the rider lands WITH the card, never before it", () => {
  // The victim must not learn the suit while the card is still in the air —
  // that would spoil the reveal the whole cinematic is built around.
  const { match, a, b } = jokerMatch();
  const rng = drawIndex(a, (c) => c.rank === 7 && c.suit === "spades");
  assert.equal(activateAbility(match, a, BLACKJACK, { forceCrit: false, rng }).ok, true);
  assert.equal(b.statuses.some((s) => s.id === "blackjackSpade"), false, "the rider arrived early");

  match.tick += BLACKJACK_IMPACT_DELAY;
  resolvePendingStrikes(match);
  assert.ok(b.statuses.some((s) => s.id === "blackjackSpade"), "the rider never arrived");
});
