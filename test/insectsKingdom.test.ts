import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyDamage } from "../src/engine/combat.js";
import { applyStatus } from "../src/engine/status.js";
import { resolveDamage } from "../src/engine/damage.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import {
  VENOM_SHOT,
  BUTTERFLIES,
  INFECTED,
  BUTTERFLIES_STATUS,
  INFECTED_STATUS,
  CREEPY_CRAWLERS,
  CAPRICE,
} from "../src/data/insectsAbilities.js";
import { squashCrawler, livingCrawlers } from "../src/engine/crawlers.js";
import { capriceIsActive } from "../src/engine/caprice.js";
import { selectTarget } from "../src/engine/targeting.js";
import { WATER_BALL } from "../src/data/waterAbilities.js";
import { INSECTS, TICK } from "../src/data/balance.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Insects' two passives. Both reward not being the kingdom everyone is hitting:
// "Cocoon" turns a share of what does land into income, and "Fruit Fly" pays
// out for being left alone.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function insectsMatch(attacker = "water"): {
  match: Match;
  bug: PlayerState;
  foe: PlayerState;
} {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("bug", "insects"));
  match.addPlayer(matchPlayer("foe", attacker));
  match.hostId = "bug";
  match.start(createMatchConfig(match));
  const bug = match.gameState!.getPlayer("bug")!;
  const foe = match.gameState!.getPlayer("foe")!;
  earn(bug, 1_000_000);
  earn(foe, 1_000_000);
  return { match, bug, foe };
}

/**
 * Silences a kingdom's income. The drain tests measure a treasury shrinking,
 * and passive income is added on the same ticks — without this they would be
 * measuring the NET of the two and reporting the drain as smaller than it is.
 */
function stopIncome(player: PlayerState): void {
  player.economy.citizens = 0;
  player.economy.incomePerTick = 0;
}

/** Ticks the match forward `n` ticks from wherever it currently is. */
function advance(match: Match, n: number): void {
  const start = match.gameState!.tick;
  for (let i = 1; i <= n; i++) tickMatch(match, start + i);
}

// --- Cocoon ------------------------------------------------------------------

test("Cocoon turns part of a caught hit into gold instead of damage", () => {
  const { bug, foe } = insectsMatch();
  bug.economy.currency = 0;

  // rng 0 forces the roll to catch.
  const caught = resolveDamage(foe, bug, 1000, { forceCrit: false, rng: () => 0 });
  assert.ok(caught.cocoonedGold > 0, "nothing was cocooned on a winning roll");
  assert.equal(bug.economy.currency, caught.cocoonedGold, "the gold was not paid out");

  // And that share genuinely does NOT land — the passive is defensive as well
  // as economic. Compared against the same hit with the roll failing.
  const plain = resolveDamage(foe, bug, 1000, { forceCrit: false, rng: () => 0.99 });
  assert.ok(caught.amount < plain.amount, "a cocooned hit still landed in full");
  assert.equal(caught.amount + caught.cocoonedGold, plain.amount);
});

test("Cocoon takes the stated share, on the stated odds", () => {
  const { bug, foe } = insectsMatch();
  const plain = resolveDamage(foe, bug, 1000, { forceCrit: false, rng: () => 0.99 });
  const caught = resolveDamage(foe, bug, 1000, { forceCrit: false, rng: () => 0 });
  assert.equal(caught.cocoonedGold, Math.round(plain.amount * INSECTS.COCOON_GOLD_PCT));

  // Just inside the chance catches; just outside does not.
  const under = resolveDamage(foe, bug, 1000, {
    forceCrit: false,
    rng: () => INSECTS.COCOON_CHANCE - 0.001,
  });
  const over = resolveDamage(foe, bug, 1000, {
    forceCrit: false,
    rng: () => INSECTS.COCOON_CHANCE,
  });
  assert.ok(under.cocoonedGold > 0, "a roll inside the chance did not catch");
  assert.equal(over.cocoonedGold, 0, "a roll outside the chance still caught");
});

test("Cocoon is exclusive to Insects", () => {
  const { bug, foe } = insectsMatch();
  const onFoe = resolveDamage(bug, foe, 1000, { forceCrit: false, rng: () => 0 });
  assert.equal(onFoe.cocoonedGold, 0, "a non-Insects kingdom cocooned a hit");
});

test("Cocoon is rolled per ATTACK, never per damage-over-time tick", () => {
  // A 5% roll twenty times a second is a certainty rather than a surprise, so
  // the roll lives in the attack pipeline and not in `applyDamage`.
  const { bug } = insectsMatch();
  bug.economy.currency = 0;
  for (let i = 0; i < 200; i++) {
    applyDamage(bug, 10, { tick: i });
  }
  assert.equal(bug.economy.currency, 0, "raw damage paid out cocoon gold");
});

// --- Fruit Fly ---------------------------------------------------------------

test("Fruit Fly heals a kingdom nobody has touched", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = 5000;

  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + 2 * TICK.RATE);
  assert.ok(bug.castle.hp > 5000, "an untouched castle did not heal");
});

test("Fruit Fly waits out the idle window before it starts", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = 5000;
  bug.lastDamageTakenTick = 0;

  // One tick short of the window: still nothing.
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE - 1);
  assert.equal(bug.castle.hp, 5000, "it healed before the window elapsed");

  advance(match, 2 * TICK.RATE);
  assert.ok(bug.castle.hp > 5000, "it never started");
});

test("any damage at all resets the clock — a burn suppresses it like a hit", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = 5000;

  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + TICK.RATE);
  assert.ok(bug.castle.hp > 5000);

  // A single point of damage from ANY source restarts the wait.
  applyDamage(bug, 1, { tick: match.gameState!.tick });
  const afterHit = bug.castle.hp;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE - 2);
  assert.equal(bug.castle.hp, afterHit, "it kept healing through being hit");
});

test("Fruit Fly does not overheal past full", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = bug.castle.maxHp;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + 5 * TICK.RATE);
  assert.equal(bug.castle.hp, bug.castle.maxHp);
});

test("Fruit Fly heals at roughly the stated rate", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = 1000;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE);

  const before = bug.castle.hp;
  advance(match, 10 * TICK.RATE); // ten seconds of regeneration
  const gained = bug.castle.hp - before;
  const expected = bug.castle.maxHp * INSECTS.FRUIT_FLY_REGEN_PCT_PER_SECOND * 10;
  // Carried fractions mean it is never exact to the point; within a few is fine.
  assert.ok(
    Math.abs(gained - expected) < 5,
    `expected about ${expected}, got ${gained}`,
  );
});

test("Fruit Fly is exclusive to Insects", () => {
  const { match, foe } = insectsMatch();
  foe.castle.hp = 5000;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + 5 * TICK.RATE);
  assert.equal(foe.castle.hp, 5000, "a non-Insects kingdom regenerated");
});

test("attacking does not stop Insects healing — only being attacked does", () => {
  // The passive is keyed off damage TAKEN, so Insects can keep swinging.
  const { match, bug, foe } = insectsMatch();
  bug.castle.hp = 5000;
  bug.target = foe.id;
  assert.equal(unlockOrUpgradeAbility(match, bug, VENOM_SHOT.id).ok, true);

  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + TICK.RATE);
  const healed = bug.castle.hp;
  assert.ok(healed > 5000);

  assert.equal(
    activateAbility(match, bug, VENOM_SHOT, { forceCrit: false }).ok,
    true,
  );
  advance(match, 2 * TICK.RATE);
  assert.ok(bug.castle.hp > healed, "swinging stopped its own regeneration");
});

test("a dead kingdom does not regenerate", () => {
  const { match, bug } = insectsMatch();
  bug.castle.hp = 0;
  bug.eliminated = true;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + 5 * TICK.RATE);
  assert.equal(bug.castle.hp, 0, "an eliminated castle healed itself");
});

test("a real attack from another kingdom both damages and resets the clock", () => {
  const { match, bug, foe } = insectsMatch();
  bug.castle.hp = 5000;
  foe.target = bug.id;
  assert.equal(unlockOrUpgradeAbility(match, foe, WATER_BALL.id).ok, true);

  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE + TICK.RATE);
  assert.ok(bug.castle.hp > 5000, "it should have been healing");

  // rng 0.99 keeps the cocoon out of it, so this is a plain hit.
  assert.equal(
    activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0.99 }).ok,
    true,
  );
  const afterHit = bug.castle.hp;
  advance(match, INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE - 2);
  assert.equal(bug.castle.hp, afterHit, "the attack did not reset the clock");
});

// --- the attacks -------------------------------------------------------------

/** Gives `player` an unlocked, off-cooldown ability aimed at `at`. */
function arm(match: Match, player: PlayerState, ability: typeof VENOM_SHOT, at: PlayerState): void {
  assert.equal(unlockOrUpgradeAbility(match, player, ability.id).ok, true);
  player.cooldowns = {};
  player.target = at.id;
}

test("Venom Shot poisons on a winning roll, and only damages on a losing one", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, VENOM_SHOT, foe);

  const hp = foe.castle.hp;
  assert.equal(activateAbility(match, bug, VENOM_SHOT, { forceCrit: false, rng: () => 0 }).ok, true);
  assert.ok(foe.castle.hp < hp, "Venom Shot dealt no damage");
  assert.ok(foe.statuses.some((s) => s.id === "venom"), "a winning roll left no venom");

  foe.statuses = [];
  foe.modifiers = [];
  bug.cooldowns = {};
  assert.equal(activateAbility(match, bug, VENOM_SHOT, { forceCrit: false, rng: () => 0.99 }).ok, true);
  assert.equal(foe.statuses.some((s) => s.id === "venom"), false, "a losing roll still poisoned");
});

test("venom stacks and ticks", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, VENOM_SHOT, foe);
  for (let i = 0; i < 2; i++) {
    bug.cooldowns = {};
    assert.equal(activateAbility(match, bug, VENOM_SHOT, { forceCrit: false, rng: () => 0 }).ok, true);
  }
  const venom = foe.statuses.find((s) => s.id === "venom")!;
  assert.equal(venom.stacks, 2);

  const hp = foe.castle.hp;
  advance(match, 5);
  assert.ok(foe.castle.hp < hp, "venom never ticked");
});

test("Butterflies strips damage reduction AND makes the target miss", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, BUTTERFLIES, foe);
  assert.equal(activateAbility(match, bug, BUTTERFLIES, { forceCrit: false }).ok, true);

  const debuff = foe.statuses.find((s) => s.id === "butterflies");
  assert.ok(debuff, "Butterflies applied no debuff");
  assert.equal(debuff.attackMissChance, INSECTS.BUTTERFLIES_MISS_CHANCE);
  // Pinned to the figure the ability card promises the player. The constant is
  // single-source, so a retune here has to be a deliberate edit that also
  // reaches the description rather than a number quietly drifting away from it.
  assert.equal(INSECTS.BUTTERFLIES_MISS_CHANCE, 0.5, "the card says HALF of their attacks miss");
  assert.equal(
    debuff.remainingTicks,
    INSECTS.BUTTERFLIES_SECONDS * TICK.RATE,
    "the debuff does not last the stated 20 seconds",
  );

  // Softer: the same hit now lands harder than it would have.
  const plain = resolveDamage(bug, bug, 1000, { forceCrit: false, rng: () => 0.99 });
  const softened = resolveDamage(bug, foe, 1000, { forceCrit: false, rng: () => 0.99 });
  assert.ok(softened.amount > plain.amount, "damage reduction was not stripped");
});

test("a kingdom with Butterflies fumbles its own attacks", () => {
  const { match, bug, foe } = insectsMatch();
  applyStatus(foe, BUTTERFLIES_STATUS, { sourceId: bug.id, durationTicks: 1000 });
  arm(match, foe, WATER_BALL, bug);

  // A roll inside the miss chance: nothing lands.
  const hp = bug.castle.hp;
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0 }).ok, true);
  assert.equal(bug.castle.hp, hp, "a fumbled attack still landed");

  // …and a roll outside it connects as normal.
  foe.cooldowns = {};
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0.99 }).ok, true);
  assert.ok(bug.castle.hp < hp, "the attack missed when it should have hit");
});

test("Infected sends a fumbled attack back into the fumbler's own castle", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, INFECTED, foe);
  assert.equal(activateAbility(match, bug, INFECTED, { forceCrit: false }).ok, true);
  assert.ok(foe.statuses.some((s) => s.id === "infected"), "Infected applied no status");

  // Butterflies is what actually makes them miss — the pair is the point.
  applyStatus(foe, BUTTERFLIES_STATUS, { sourceId: bug.id, durationTicks: 1000 });
  arm(match, foe, WATER_BALL, bug);

  const mine = bug.castle.hp;
  const theirs = foe.castle.hp;
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0 }).ok, true);
  assert.equal(bug.castle.hp, mine, "the deflected attack still hit its original target");
  assert.ok(foe.castle.hp < theirs, "the fumbled attack was not deflected back");
});

test("Infected does nothing on its own — it needs the miss to fire", () => {
  // The whole design of the pair: landing one without the other is a wasted
  // setup, and Infected on a target that never misses is dead weight.
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, INFECTED, foe);
  assert.equal(activateAbility(match, bug, INFECTED, { forceCrit: false }).ok, true);

  arm(match, foe, WATER_BALL, bug);
  const mine = bug.castle.hp;
  const theirs = foe.castle.hp;
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0.99 }).ok, true);
  assert.ok(bug.castle.hp < mine, "the attack should have connected normally");
  assert.equal(foe.castle.hp, theirs, "an attack that HIT was deflected anyway");
});

test("a fumble without Infected simply misses — nothing rebounds", () => {
  const { match, bug, foe } = insectsMatch();
  applyStatus(foe, BUTTERFLIES_STATUS, { sourceId: bug.id, durationTicks: 1000 });
  arm(match, foe, WATER_BALL, bug);

  const mine = bug.castle.hp;
  const theirs = foe.castle.hp;
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0 }).ok, true);
  assert.equal(bug.castle.hp, mine, "the fumbled attack landed");
  assert.equal(foe.castle.hp, theirs, "it rebounded without Infected");
});

test("a deflected attack cannot rebound forever", () => {
  // The deflection applies effects directly rather than re-entering the cast
  // pipeline, so it can never re-roll the fumble and bounce again.
  const { match, bug, foe } = insectsMatch();
  applyStatus(foe, BUTTERFLIES_STATUS, { sourceId: bug.id, durationTicks: 1000 });
  applyStatus(foe, INFECTED_STATUS, { sourceId: bug.id, durationTicks: 1000 });
  arm(match, foe, WATER_BALL, bug);

  const theirs = foe.castle.hp;
  assert.equal(activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0 }).ok, true);
  const lost = theirs - foe.castle.hp;
  // One swing's worth, not an avalanche of them.
  assert.ok(lost > 0 && lost < 2000, `deflected for ${lost} — that is more than one swing`);
});

// --- Creepy Crawlers ---------------------------------------------------------

test("Creepy Crawlers lands three bugs that eat gold", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, CREEPY_CRAWLERS, foe);
  assert.equal(activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false }).ok, true);
  assert.equal(livingCrawlers(foe), INSECTS.CRAWLER_COUNT);

  stopIncome(foe);
  foe.economy.currency = 10_000;
  advance(match, TICK.RATE); // one second
  const drained = 10_000 - foe.economy.currency;
  const expected = INSECTS.CRAWLER_DRAIN_PER_SECOND * INSECTS.CRAWLER_COUNT;
  assert.ok(
    Math.abs(drained - expected) < 2,
    `expected about ${expected} drained, got ${drained}`,
  );
});

test("it takes two clicks to kill one bug", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, CREEPY_CRAWLERS, foe);
  activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false });

  const first = squashCrawler(match, foe, 0);
  assert.equal(first?.killed, false, "one click killed it");
  assert.equal(livingCrawlers(foe), INSECTS.CRAWLER_COUNT);

  const second = squashCrawler(match, foe, 0);
  assert.equal(second?.killed, true, "the second click did not finish it");
  assert.equal(livingCrawlers(foe), INSECTS.CRAWLER_COUNT - 1);

  // A dead bug cannot be clicked again.
  assert.equal(squashCrawler(match, foe, 0), null);
});

test("the drain eases as bugs are swatted", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, CREEPY_CRAWLERS, foe);
  activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false });

  stopIncome(foe);
  foe.economy.currency = 10_000;
  advance(match, TICK.RATE);
  const withThree = 10_000 - foe.economy.currency;

  squashCrawler(match, foe, 0);
  squashCrawler(match, foe, 0); // one down
  foe.economy.currency = 10_000;
  advance(match, TICK.RATE);
  const withTwo = 10_000 - foe.economy.currency;

  // Swatting the first is worth something immediately — the whole reason the
  // bugs drain independently rather than as one lump.
  assert.ok(withTwo < withThree, "killing a bug did not slow the drain");
});

test("killing the last bug ends the swarm outright", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, CREEPY_CRAWLERS, foe);
  activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false });

  for (let i = 0; i < INSECTS.CRAWLER_COUNT; i++) {
    squashCrawler(match, foe, i);
    squashCrawler(match, foe, i);
  }
  assert.equal(livingCrawlers(foe), 0);
  assert.equal(
    foe.statuses.some((s) => s.id === "creepyCrawlers"),
    false,
    "the swarm lingered after the last bug died",
  );

  stopIncome(foe);
  foe.economy.currency = 10_000;
  advance(match, 2 * TICK.RATE);
  assert.equal(foe.economy.currency, 10_000, "it kept draining with no bugs left");
});

test("a drain can empty a treasury but never overdraw it", () => {
  const { match, bug, foe } = insectsMatch();
  arm(match, bug, CREEPY_CRAWLERS, foe);
  activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false });
  stopIncome(foe);
  foe.economy.currency = 5;
  advance(match, 5 * TICK.RATE);
  assert.equal(foe.economy.currency, 0);
});

test("a squash with nothing to swat is refused", () => {
  const { match, bug, foe } = insectsMatch();
  assert.equal(squashCrawler(match, foe, 0), null);
  arm(match, bug, CREEPY_CRAWLERS, foe);
  activateAbility(match, bug, CREEPY_CRAWLERS, { forceCrit: false });
  // Out-of-range indices are refused rather than crashing or wrapping.
  assert.equal(squashCrawler(match, foe, -1), null);
  assert.equal(squashCrawler(match, foe, 99), null);
});

// --- Caprice -----------------------------------------------------------------

test("Caprice puts a butterfly on the field for its duration", () => {
  const { match, bug } = insectsMatch();
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  assert.ok(capriceIsActive(match), "no butterfly appeared");
  advance(match, INSECTS.CAPRICE_SECONDS * TICK.RATE);
  assert.equal(capriceIsActive(match), false, "the butterfly outstayed its clock");
  assert.equal(match.gameState!.caprice, null);
});

test("Caprice scrambles everyone else, and never the caster", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("bug", "insects"));
  match.addPlayer(matchPlayer("a", "water"));
  match.addPlayer(matchPlayer("b", "fire"));
  match.hostId = "bug";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const bug = state.getPlayer("bug")!;
  const a = state.getPlayer("a")!;
  earn(bug, 1_000_000);

  bug.target = a.id;
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  // The caster keeps their own aim.
  assert.equal(bug.target, a.id, "the caster was scrambled too");
  // Everyone else has been pointed somewhere, and never at Insects.
  for (const p of [state.getPlayer("a")!, state.getPlayer("b")!]) {
    assert.ok(p.target, `${p.id} was left with no target`);
    assert.notEqual(p.target, bug.id, "the scramble aimed someone at Insects");
  }
});

test("nobody may aim at Insects while the butterfly holds", () => {
  const { match, bug, foe } = insectsMatch();
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  const attempt = selectTarget(match, foe, bug.id);
  assert.equal(attempt.ok, false, "a kingdom aimed at Insects through its own ultimate");
});

test("nobody but Insects may re-aim at all while it holds", () => {
  // Being able to re-pick between scrambles would hand back exactly the
  // control the ability takes away.
  const match = new Match("1234");
  match.addPlayer(matchPlayer("bug", "insects"));
  match.addPlayer(matchPlayer("a", "water"));
  match.addPlayer(matchPlayer("b", "fire"));
  match.hostId = "bug";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const bug = state.getPlayer("bug")!;
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;
  earn(bug, 1_000_000);

  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  assert.equal(selectTarget(match, a, b.id).ok, false, "a scrambled kingdom re-aimed");
  // …but Insects itself still picks freely.
  assert.equal(selectTarget(match, bug, a.id).ok, true, "the caster lost its own aim");
});

test("a scrambled kingdom can end up on itself, and may actually fire", () => {
  // "It is possible for a player to target themselves" — with teeth. A silent
  // refusal to fire would be a lockout rather than the joke.
  const { match, bug, foe } = insectsMatch();
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  // With only Insects and one other kingdom, the pool is just that kingdom —
  // so the scramble necessarily points them at themselves.
  assert.equal(foe.target, foe.id, "the only legal pick was not taken");

  assert.equal(unlockOrUpgradeAbility(match, foe, WATER_BALL.id).ok, true);
  foe.cooldowns = {};
  const hp = foe.castle.hp;
  const fired = activateAbility(match, foe, WATER_BALL, { forceCrit: false, rng: () => 0.99 });
  assert.equal(fired.ok, true, "a self-targeted cast was refused outright");
  assert.ok(foe.castle.hp < hp, "the self-targeted attack did nothing");
});

test("normal self-targeting is still refused once the butterfly leaves", () => {
  const { match, bug, foe } = insectsMatch();
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  activateAbility(match, bug, CAPRICE, { forceCrit: false });
  advance(match, INSECTS.CAPRICE_SECONDS * TICK.RATE);

  assert.equal(unlockOrUpgradeAbility(match, foe, WATER_BALL.id).ok, true);
  foe.cooldowns = {};
  const fired = activateAbility(match, foe, WATER_BALL, {
    targetId: foe.id,
    forceCrit: false,
  });
  assert.equal(fired.ok, false, "self-targeting stayed legal after Caprice ended");
});

test("Caprice keeps re-rolling for as long as it is up", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("bug", "insects"));
  for (const [id, k] of [["a", "water"], ["b", "fire"], ["c", "ice"]] as const) {
    match.addPlayer(matchPlayer(id, k));
  }
  match.hostId = "bug";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  const bug = state.getPlayer("bug")!;
  earn(bug, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, bug, CAPRICE.id).ok, true);
  assert.equal(activateAbility(match, bug, CAPRICE, { forceCrit: false }).ok, true);

  // Watch one kingdom over several seconds: with three legal destinations it
  // should not sit on one the whole time.
  const watched = state.getPlayer("a")!;
  const seen = new Set<string>();
  for (let i = 0; i < 10 * TICK.RATE; i++) {
    tickMatch(match, state.tick + 1);
    if (watched.target) seen.add(watched.target);
  }
  assert.ok(seen.size > 1, "the scramble never moved anyone after the first roll");
});
