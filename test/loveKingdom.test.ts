import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import { activateAbility } from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { hasStatus, getStatus } from "../src/engine/status.js";
import { tickMatch } from "../src/engine/tick.js";
import { earn } from "../src/engine/money.js";
import { isKingdomId } from "../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { citizenCost, repairCastle } from "../src/engine/purchases.js";
import { TICK } from "../src/data/balance.js";
import {
  TOUGH_LOVE,
  CUPIDS_ARROW,
  BFFS,
  EMPATHY,
  LOVE_GALORE,
} from "../src/data/loveAbilities.js";

// Love kingdom — a social, manipulative kit: it borrows resources, redirects
// damage, and ties enemy fates together rather than simply out-damaging them.

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** A started match; player 0 is Love, the rest take the given kingdoms. Each
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

const heartland = (n = 3) =>
  arena(["love", ...Array.from({ length: n - 1 }, () => "plains")]);

const noCrit = () => 0.3;

test("Love is a registered kingdom with its full 5-ability kit", () => {
  assert.equal(isKingdomId("love"), true);
  const ids = abilitiesForKingdom("love").map((a) => a.id);
  assert.deepEqual(ids, ["toughLove", "cupidsArrow", "bffs", "empathy", "loveGalore"]);
});

test("Warm Welcome — EVERY citizen is cheaper: the ladder starts at 20 and grows by the same factor", () => {
  const { players } = heartland();
  const [love] = players;
  assert.equal(citizenCost(love), 20); // base 20 (vs 25)
  love.economy.citizensPurchased = 1;
  assert.equal(citizenCost(love), Math.round(20 * 1.10 ** 1)); // 22 — same growth, lower base
  love.economy.citizensPurchased = 2;
  assert.equal(citizenCost(love), Math.round(20 * 1.10 ** 2)); // 24
  // A non-Love kingdom pays the normal 25-based ladder throughout.
  const plains = players[1]!;
  assert.equal(citizenCost(plains), 25);
  plains.economy.citizensPurchased = 2;
  assert.equal(citizenCost(plains), Math.round(25 * 1.10 ** 2));
});

test("Feel the love! — Love receives 10% of any OTHER castle's healing, but not its own", () => {
  const { match, players } = arena(["love", "water"]);
  const [love, water] = players;
  water.castle.hp -= 5000;
  love.castle.hp -= 1000;

  // Water heals itself for 2000 via the generic "heal" effect path (Riptide-style).
  const before = love.castle.hp;
  const r = activateAbility(match, water, {
    id: "selfHeal",
    kind: "utility",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "self" },
    effects: [{ type: "heal", target: "self", params: { amount: 2000 } }],
  });
  assert.equal(r.ok, true);
  assert.equal(water.castle.hp, water.castle.maxHp - 5000 + 2000);
  assert.equal(love.castle.hp, before + 200); // 10% of 2000

  // Love healing itself does NOT grant itself a bonus share (no self-loop).
  const loveBefore = love.castle.hp;
  activateAbility(match, love, {
    id: "selfHeal2",
    kind: "utility",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "self" },
    effects: [{ type: "heal", target: "self", params: { amount: 500 } }],
  });
  assert.equal(love.castle.hp, loveBefore + 500); // no extra 10% on top
});

test("Feel the love! — a REPAIR another kingdom buys also feeds Love", () => {
  const { match, players } = arena(["love", "water"]);
  const [love, water] = players;
  water.castle.hp -= 5000; // must be below max to repair
  love.castle.hp -= 500;

  const before = love.castle.hp;
  const r = repairCastle(match, water);
  assert.equal(r.ok, true);
  // Repair restores 1000 HP; Love gets 10% = 100.
  assert.equal(water.castle.hp, water.castle.maxHp - 5000 + 1000);
  assert.equal(love.castle.hp, before + 100);
});

test("Tough Love: damage, cost, cooldown", () => {
  const { match, players } = heartland();
  const [a, b] = players;
  const before = a.economy.currency;

  const r = activateAbility(match, a, TOUGH_LOVE, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.equal(before - a.economy.currency, 100);
  assert.equal(getCooldown(a, "toughLove"), 3 * TICK.RATE);
});

test("Cupid's Arrow: damage, marks 'infatuated', borrows 2 citizens, and returns them on expiry", () => {
  const { match, players } = heartland();
  const [love, target] = players;
  const targetCitizensBefore = target.economy.citizens;
  const loveCitizensBefore = love.economy.citizens;

  const r = activateAbility(match, love, CUPIDS_ARROW, { targetId: "p1", rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(target.castle.hp, target.castle.maxHp - 400);
  assert.equal(hasStatus(target, "infatuated"), true);
  assert.equal(target.economy.citizens, targetCitizensBefore - 2);
  assert.equal(love.economy.citizens, loveCitizensBefore + 2);

  // The loan travels home when "infatuated" expires naturally (10s = 200 ticks).
  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(target, "infatuated"), false);
  assert.equal(target.economy.citizens, targetCitizensBefore);
  assert.equal(love.economy.citizens, loveCitizensBefore);
});

test("Cupid's Arrow: while infatuated, 20% of damage aimed at Love redirects to the target — Love only takes 80%", () => {
  const { match, players } = arena(["love", "plains", "plains"]);
  const [love, target, attacker] = players;
  activateAbility(match, love, CUPIDS_ARROW, { targetId: target.id, rng: noCrit });
  assert.equal(hasStatus(target, "infatuated"), true);

  const targetHpBefore = target.castle.hp;
  const hit = activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });
  assert.equal(hit.ok, true);
  // Split, not additive: Love takes 80% of the 250, the target absorbs the
  // other 20% — 250 total damage dealt across the two castles, not 300.
  assert.equal(love.castle.hp, love.castle.maxHp - Math.round(250 * 0.8));
  assert.equal(target.castle.hp, targetHpBefore - Math.round(250 * 0.2));
});

test("BFFS!!!: damages BOTH player-selected castles and links their fates", () => {
  const { match, players } = arena(["love", "plains", "plains", "plains"]);
  const [love, primary, second, bystander] = players;

  // Player selects two kingdoms — targetIds = [primary, second].
  const r = activateAbility(match, love, BFFS, { targetIds: [primary.id, second.id], rng: noCrit });
  assert.equal(r.ok, true);
  assert.equal(primary.castle.hp, primary.castle.maxHp - 400);
  assert.equal(second.castle.hp, second.castle.maxHp - 400);
  // The uninvolved third kingdom is untouched (no random selection anymore).
  assert.equal(bystander.castle.hp, bystander.castle.maxHp);
  assert.equal(hasStatus(bystander, "bffsLink"), false);

  const primaryLink = primary.statuses.find((s) => s.id === "bffsLink")!;
  const secondLink = second.statuses.find((s) => s.id === "bffsLink")!;
  assert.equal(primaryLink.linkedPartnerId, second.id);
  assert.equal(secondLink.linkedPartnerId, primary.id);
});

test("BFFS!!!: rejects with SECOND_TARGET_REQUIRED when only one kingdom is given", () => {
  const { match, players } = arena(["love", "plains", "plains"]);
  const [love, primary] = players;
  const before = love.economy.currency;

  // Only a single target — no second selection.
  const r = activateAbility(match, love, BFFS, { targetId: primary.id, rng: noCrit });
  assert.equal(r.ok, false);
  assert.equal(r.error, "SECOND_TARGET_REQUIRED");
  // Rejected cleanly: nothing spent, no damage, no link.
  assert.equal(love.economy.currency, before);
  assert.equal(primary.castle.hp, primary.castle.maxHp);
  assert.equal(hasStatus(primary, "bffsLink"), false);

  // The same second id as the first is not a valid pair either.
  const r2 = activateAbility(match, love, BFFS, { targetIds: [primary.id, primary.id], rng: noCrit });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "SECOND_TARGET_REQUIRED");
});

test("BFFS!!!: damage and statuses landing on a linked castle mirror onto its partner", () => {
  const { match, players } = arena(["love", "plains", "plains"]);
  const [love, primary, second] = players;
  activateAbility(match, love, BFFS, { targetIds: [primary.id, second.id], rng: noCrit });
  assert.equal(hasStatus(second, "bffsLink"), true);

  // A fresh attack on the primary also lands on its linked partner.
  const secondHpBefore = second.castle.hp;
  const hit = activateAbility(match, love, TOUGH_LOVE, { targetId: primary.id, rng: noCrit });
  assert.equal(hit.ok, true);
  assert.equal(second.castle.hp, secondHpBefore - 250);

  // A status landing on the primary also lands on its partner.
  activateAbility(match, love, CUPIDS_ARROW, { targetId: primary.id, rng: noCrit });
  assert.equal(hasStatus(primary, "infatuated"), true);
  assert.equal(hasStatus(second, "infatuated"), true);
});

test("Have some Empathy!: unconditional 100% reflection while active", () => {
  const { match, players } = arena(["love", "plains"]);
  const [love, attacker] = players;
  const r = activateAbility(match, love, EMPATHY);
  assert.equal(r.ok, true);
  assert.equal(hasStatus(love, "empathetic"), true);
  assert.equal(getCooldown(love, "empathy"), 20 * TICK.RATE);

  const attackerHpBefore = attacker.castle.hp;
  const hit = activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });
  assert.equal(hit.ok, true);
  assert.equal(love.castle.hp, love.castle.maxHp - 250); // still takes the hit
  assert.equal(attacker.castle.hp, attackerHpBefore - 250); // reflected in full
});

test("Love Galore: incoming damage is fully negated and converted into healing (halved)", () => {
  const { match, players } = arena(["love", "plains"]);
  const [love, attacker] = players;
  love.castle.hp -= 2000;
  const r = activateAbility(match, love, LOVE_GALORE);
  assert.equal(r.ok, true);
  assert.equal(hasStatus(love, "loveGaloreShield"), true);

  const before = love.castle.hp;
  const hit = activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });
  assert.equal(hit.ok, true);
  // No damage landed; instead healed for half of the 250 that would have hit.
  assert.equal(love.castle.hp, before + 125);
});

test("Love Galore stealth: enemies see a phantom hit, the heal is silent, no reveal yet", () => {
  const { match, players } = arena(["love", "plains"]);
  const [love, attacker] = players;
  love.castle.hp -= 5000;
  activateAbility(match, love, LOVE_GALORE);

  const events: { type: string; targetId?: string; cause?: string; phantom?: boolean }[] = [];
  match.gameState!.events.on((e) => events.push(e as never));

  const before = love.castle.hp;
  activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });

  // Still healed (silently) for half the 250 that would have hit.
  assert.equal(love.castle.hp, before + 125);
  // A phantom damage event was emitted (the decoy), and NO heal event.
  const dmg = events.find((e) => e.type === "damage" && e.targetId === love.id);
  assert.ok(dmg, "a phantom damage event should be emitted during stealth");
  assert.equal(dmg!.phantom, true);
  assert.equal(events.some((e) => e.type === "heal" && e.targetId === love.id), false);
  // Not revealed yet — only 125 of 1500 banked.
  assert.equal(getStatus(love, "loveGaloreShield")!.revealed ?? false, false);
});

test("Love Galore reveals early once the healing threshold (1500) is crossed", () => {
  const { match, players } = arena(["love", "plains"]);
  const [love, attacker] = players;
  // Lots of headroom so every heal actually lands (uncapped) and counts.
  love.castle.maxHp = 1_000_000;
  love.castle.hp = 100_000;
  activateAbility(match, love, LOVE_GALORE);

  const revealed: string[] = [];
  match.gameState!.events.on((e) => {
    if ((e as { type: string }).type === "statusRevealed") revealed.push((e as { statusId: string }).statusId);
  });

  // Bank healing until the 1500 threshold reveals it (element multipliers make
  // the exact per-hit heal fuzzy, so drive it by the outcome, not a hit count).
  const status = getStatus(love, "loveGaloreShield")!;
  for (let i = 0; i < 40 && !status.revealed; i++) {
    attacker.cooldowns = {}; // ignore cooldowns for the test cadence
    activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });
  }
  assert.equal(status.revealed, true);
  assert.ok((status.healAccumulated ?? 0) >= 1500);
  assert.ok(revealed.includes("loveGaloreShield"));

  // After reveal, a hit shows as visible HEALING (not a phantom).
  const events: { type: string; targetId?: string; phantom?: boolean }[] = [];
  match.gameState!.events.on((e) => events.push(e as never));
  attacker.cooldowns = {};
  activateAbility(match, attacker, TOUGH_LOVE, { targetId: love.id, rng: noCrit });
  assert.ok(events.some((e) => e.type === "heal" && e.targetId === love.id));
  assert.equal(events.some((e) => e.type === "damage" && e.phantom), false);
});

test("Love Galore reveals when the stealth window elapses, restarting for a fresh window", () => {
  const { match, players } = arena(["love", "plains"]);
  const [love] = players;
  activateAbility(match, love, LOVE_GALORE);
  const status = getStatus(love, "loveGaloreShield")!;
  const stealthTicks = status.remainingTicks; // 15 s worth
  assert.equal(status.revealed ?? false, false);

  // Run out the stealth window (never crossing the heal threshold).
  for (let i = 0; i < stealthTicks; i++) tickMatch(match);

  const after = getStatus(love, "loveGaloreShield");
  assert.ok(after, "the buff should NOT expire — it reveals and restarts");
  assert.equal(after!.revealed, true);
  // Fresh, full window of the same length.
  assert.ok(after!.remainingTicks > stealthTicks - 2);
});
