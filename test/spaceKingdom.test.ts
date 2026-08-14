import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import { activateAbility, supernovaLevel } from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { hasStatus } from "../src/engine/status.js";
import { selectTarget } from "../src/engine/targeting.js";
import { besiegerIncomeMultiplier } from "../src/engine/passives.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { isKingdomId } from "../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { TICK } from "../src/data/balance.js";
import {
  SHOOTING_STAR,
  SATURNS_RINGS,
  SUPERNOVA,
  ORIONS_BELT,
  BLACK_HOLE,
} from "../src/data/spaceAbilities.js";

// Space kingdom — the offensive bully. Its kit revolves around a shared
// Supernova meter (Shooting Star / Saturn's Rings / Orion's Belt misses fill
// it; Supernova spends it), plus two field-wide mechanics (Supernova's forced
// redirect and the Black Hole ultimate).

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** A started match; player 0 is Space, the rest take the given kingdoms. Each
 *  player is topped up with cash so cost is never the thing under test. */
function arena(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

const cosmos = (n = 3) =>
  arena(["space", ...Array.from({ length: n - 1 }, () => "plains")]);

// No-crit, no-proc rng: 0.3 clears the 5% crit gate and 50% redirect gate the
// way each test wants (see individual comments).
const noCrit = () => 0.3;

test("Space is a registered kingdom with its full 5-ability kit", () => {
  assert.equal(isKingdomId("space"), true);
  const ids = abilitiesForKingdom("space").map((a) => a.id);
  assert.deepEqual(ids, [
    "shootingStar",
    "saturnsRings",
    "supernova",
    "orionsBeltAbility",
    "blackHole",
  ]);
});

test("Blast off! — Space starts the game with 150 gold", () => {
  const match = new Match("1234");
  match.addPlayer(player("p0", "space"));
  match.addPlayer(player("p1", "plains"));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  assert.equal(match.gameState!.getPlayer("p0")!.economy.currency, 150);
  // A non-Space kingdom starts broke.
  assert.equal(match.gameState!.getPlayer("p1")!.economy.currency, 0);
});

test("Vast Universe — income scales +10% per kingdom targeting Space", () => {
  const { players } = cosmos(4);
  const [space, b, c, d] = players;
  assert.equal(besiegerIncomeMultiplier(space, players), 1); // nobody yet
  b.target = space.id;
  assert.ok(Math.abs(besiegerIncomeMultiplier(space, players) - 1.1) < 1e-9);
  c.target = space.id;
  d.target = space.id;
  assert.ok(Math.abs(besiegerIncomeMultiplier(space, players) - 1.3) < 1e-9);
});

test("Shooting Star: damage, cost, cooldown, and Supernova charge", () => {
  const { match, players } = cosmos();
  const [a, b] = players;
  a.unlocked.supernova = true; // charge only fills once Supernova is bought
  const before = a.economy.currency;

  const r = activateAbility(match, a, SHOOTING_STAR, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.equal(before - a.economy.currency, 100);
  assert.equal(getCooldown(a, "shootingStar"), 3 * TICK.RATE);
  assert.equal(a.supernovaMeter, 25); // trickles meter xp
});

test("the Supernova meter cannot charge until Supernova is unlocked", () => {
  const { match, players } = cosmos();
  const [a, b] = players;
  assert.equal(a.unlocked.supernova, undefined); // fresh player, nothing bought

  // Every charge source is a no-op while locked — damage still lands normally.
  activateAbility(match, a, SHOOTING_STAR, { targetId: "p1", rng: noCrit });
  assert.equal(a.supernovaMeter, 0);
  assert.equal(b.castle.hp, b.castle.maxHp - 250);

  activateAbility(match, a, SATURNS_RINGS, { targetId: "p1", rng: noCrit });
  assert.equal(a.supernovaMeter, 0);

  // Buying Supernova flips the gate open — the very next charge lands (advance
  // past Shooting Star's cooldown first so the recast is legal).
  a.unlocked.supernova = true;
  for (let t = 1; t <= 3 * TICK.RATE; t++) tickMatch(match, t);
  activateAbility(match, a, SHOOTING_STAR, { targetId: "p1", rng: noCrit });
  assert.equal(a.supernovaMeter, 25);
});

test("Supernova meter levels follow the ramping thresholds (50/150/250)", () => {
  assert.equal(supernovaLevel(0), 0);
  assert.equal(supernovaLevel(49), 0);
  assert.equal(supernovaLevel(50), 1);
  assert.equal(supernovaLevel(149), 1);
  assert.equal(supernovaLevel(150), 2);
  assert.equal(supernovaLevel(249), 2);
  assert.equal(supernovaLevel(250), 3);
  assert.equal(supernovaLevel(9999), 3);
});

test("Saturn's Rings deals 9x50 and charges 45 xp", () => {
  const { match, players } = cosmos();
  const [a, b] = players;
  a.unlocked.supernova = true;
  const r = activateAbility(match, a, SATURNS_RINGS, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 450); // 9 rings x 50
  assert.equal(a.supernovaMeter, 45); // 9 x 5 — just shy of level 1
  assert.equal(supernovaLevel(a.supernovaMeter), 0);
});

test("Supernova can't fire at level 0 (no charge)", () => {
  const { match, players } = cosmos();
  const [a] = players;
  a.supernovaMeter = 49; // still level 0 (needs 50 for L1)
  const r = activateAbility(match, a, SUPERNOVA, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_SUPERNOVA");
});

test("Supernova L1 deals 500 and empties the meter", () => {
  const { match, players } = cosmos();
  const [a, b] = players;
  a.supernovaMeter = 50; // level 1
  const r = activateAbility(match, a, SUPERNOVA, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 500);
  assert.equal(a.supernovaMeter, 0); // consumed
});

test("Supernova L2 hijacks the field onto the victim, then restores it", () => {
  const { match, players } = arena(["space", "plains", "plains", "plains"]);
  const [a, victim, bystander, other] = players;
  bystander.target = other.id; // a pre-existing selection to restore later
  a.supernovaMeter = 150; // level 2

  // rng 0.3: no crit (>0.05) but the 50% redirect fires (<0.5).
  const r = activateAbility(match, a, SUPERNOVA, { targetId: victim.id, rng: () => 0.3 });
  assert.equal(r.ok, true);
  assert.equal(victim.castle.hp, victim.castle.maxHp - 1000);

  // Every OTHER kingdom is forced onto the victim and locked; the victim isn't.
  assert.equal(bystander.target, victim.id);
  assert.equal(a.target, victim.id);
  assert.equal(hasStatus(bystander, "supernovaLock"), true);
  assert.equal(hasStatus(victim, "supernovaLock"), false);

  // Locked players cannot swap away.
  assert.equal(selectTarget(match, bystander, other.id).error, "TARGET_LOCKED");

  // After the redirect elapses, the pre-existing selection is restored.
  for (let t = 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(bystander, "supernovaLock"), false);
  assert.equal(bystander.target, other.id);
});

test("Supernova L2 may also whiff its hijack (chance not met)", () => {
  const { match, players } = arena(["space", "plains", "plains"]);
  const [a, victim, bystander] = players;
  bystander.target = null;
  a.supernovaMeter = 150; // level 2
  // rng 0.9: no crit, and 0.9 >= 0.5 so the redirect does NOT fire.
  const r = activateAbility(match, a, SUPERNOVA, { targetId: victim.id, rng: () => 0.9 });
  assert.equal(r.ok, true);
  assert.equal(hasStatus(bystander, "supernovaLock"), false);
});

test("Orion's Belt: incoming attacks can miss and the miss feeds the meter", () => {
  // Two Space players so the attacker has a real attack to swing.
  const { match, players } = arena(["space", "space"]);
  const [belted, attacker] = players;
  belted.unlocked.supernova = true; // charge only fills once Supernova is bought
  const r = activateAbility(match, belted, ORIONS_BELT);
  assert.equal(r.ok, true);
  assert.equal(hasStatus(belted, "orionsBelt"), true);
  assert.equal(getCooldown(belted, "orionsBeltAbility"), 20 * TICK.RATE);

  // rng 0 forces the 50% miss. The attack whiffs entirely; the belt bearer
  // gains a meter point and takes no damage.
  const before = belted.castle.hp;
  const miss = activateAbility(match, attacker, SHOOTING_STAR, { targetId: belted.id, rng: () => 0 });
  assert.equal(miss.ok, true);
  assert.equal(belted.castle.hp, before); // whiffed
  assert.equal(belted.supernovaMeter, 50); // miss charged the belt bearer a full level
});

test("Orion's Belt: a landed attack still hits (chance not met)", () => {
  const { match, players } = arena(["space", "space"]);
  const [belted, attacker] = players;
  activateAbility(match, belted, ORIONS_BELT);
  // rng 0.9: no miss (>=0.5), no crit (>=0.05) — a clean hit for 250.
  const hit = activateAbility(match, attacker, SHOOTING_STAR, { targetId: belted.id, rng: () => 0.9 });
  assert.equal(hit.ok, true);
  assert.equal(belted.castle.hp, belted.castle.maxHp - 250);
});

test("Black Hole swallows every attack, then dumps on a kingdom that stayed out", () => {
  const { match, players } = arena(["space", "space", "plains"]);
  const [owner, attacker, bystander] = players;

  const open = activateAbility(match, owner, BLACK_HOLE);
  assert.equal(open.ok, true);
  assert.ok(match.gameState!.blackHole);
  assert.equal(match.gameState!.blackHole!.endTick, 10 * TICK.RATE); // opened at tick 0

  // An attack during the hole lands nothing on its target — it's pooled.
  const swing = activateAbility(match, attacker, SHOOTING_STAR, { targetId: bystander.id, rng: () => 0.9 });
  assert.equal(swing.ok, true);
  assert.equal(bystander.castle.hp, bystander.castle.maxHp); // absorbed, no damage
  assert.equal(match.gameState!.blackHole!.accumulated, 250);
  assert.equal(match.gameState!.blackHole!.lastAttackerId, attacker.id);
  assert.deepEqual(match.gameState!.blackHole!.fedBy, [attacker.id]);

  // On collapse the pool goes to the kingdom that never fed it. Whoever threw a
  // punch already paid by having it swallowed; the player who sat the window
  // out is the one the collapse is for.
  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(match.gameState!.blackHole, null);
  assert.equal(bystander.castle.hp, bystander.castle.maxHp - 250);
  assert.equal(attacker.castle.hp, attacker.castle.maxHp, "the feeder was taxed twice");
});

test("Black Hole falls back to the last feeder when the whole field engaged", () => {
  const { match, players } = arena(["space", "space", "plains"]);
  const [owner, first, second] = players;

  assert.equal(activateAbility(match, owner, BLACK_HOLE).ok, true);
  assert.equal(
    activateAbility(match, first, SHOOTING_STAR, { targetId: second.id, rng: () => 0.9 }).ok,
    true,
  );
  assert.equal(
    activateAbility(match, second, SHOOTING_STAR, { targetId: first.id, rng: () => 0.9 }).ok,
    true,
  );
  // Nobody stayed out, so there is no bystander to prefer.
  assert.equal(match.gameState!.blackHole!.fedBy.length, 2);
  assert.equal(match.gameState!.blackHole!.lastAttackerId, second.id);

  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(second.castle.hp, second.castle.maxHp - 500);
  assert.equal(first.castle.hp, first.castle.maxHp);
});

test("Black Hole never dumps on Space — its owner or any other", () => {
  // The hole is Space's own instrument; it does not turn on the kingdom that
  // understands it. With nobody else alive there is simply nothing to hit.
  const { match, players } = arena(["space", "space"]);
  const [owner, otherSpace] = players;

  assert.equal(activateAbility(match, owner, BLACK_HOLE).ok, true);
  assert.equal(
    activateAbility(match, otherSpace, SHOOTING_STAR, { targetId: owner.id, rng: () => 0.9 }).ok,
    true,
  );
  assert.equal(match.gameState!.blackHole!.accumulated, 250);

  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(match.gameState!.blackHole, null);
  assert.equal(owner.castle.hp, owner.castle.maxHp, "Space was hit by its own black hole");
  assert.equal(
    otherSpace.castle.hp,
    otherSpace.castle.maxHp,
    "a second Space took the dump",
  );
});

test("Black Hole skips Space and dumps on a kingdom that can take it", () => {
  const { match, players } = arena(["space", "space", "plains"]);
  const [owner, otherSpace, plains] = players;

  assert.equal(activateAbility(match, owner, BLACK_HOLE).ok, true);
  // BOTH non-owners feed it, so neither is a bystander — the only thing
  // separating them is that one of them is Space.
  assert.equal(
    activateAbility(match, otherSpace, SHOOTING_STAR, { targetId: plains.id, rng: () => 0.9 }).ok,
    true,
  );
  assert.equal(
    activateAbility(match, plains, SHOOTING_STAR, { targetId: owner.id, rng: () => 0.9 }).ok,
    true,
  );

  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(otherSpace.castle.hp, otherSpace.castle.maxHp, "Space took the dump");
  assert.equal(plains.castle.hp, plains.castle.maxHp - 500);
});

