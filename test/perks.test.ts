import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { createPlayerState, type PlayerState } from "../src/match/playerState.js";
import { resolveDamage } from "../src/engine/damage.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import { buyShield, unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyStatus, processStatusTicks } from "../src/engine/status.js";
import { earn } from "../src/engine/money.js";
import { PERKS } from "../src/data/balance.js";
import { normalizePerks, hasFullPerkSelection } from "../src/data/perks.js";
import type { PerkId } from "../src/data/perks.js";
import type { MatchPlayer } from "../src/match/types.js";

// Perks (lobby loadout): eight flat bonuses, each read at exactly one place in
// the engine. Every case here pins the magnitude AND that it *stacks* with the
// kingdom passives/abilities already in the chain rather than replacing them.

const matchPlayer = (id: string, kingdomId: string, perks: PerkId[] = []): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks,
  ready: true,
  connected: true,
});

/** An active match of two kingdoms, `a` carrying `perks` and `b` carrying none. */
function activeMatch(
  perks: PerkId[],
  kingdomA = "water",
  kingdomB = "water",
): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", kingdomA, perks));
  match.addPlayer(matchPlayer("b", kingdomB));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return {
    match,
    a: match.gameState!.getPlayer("a")!,
    b: match.gameState!.getPlayer("b")!,
  };
}

/** A bare PlayerState of the given kingdom carrying `perks`. */
function loneState(kingdomId: string, perks: PerkId[]): PlayerState {
  const match = new Match("1234");
  return createPlayerState(
    { id: "x", name: "x", kingdomId: kingdomId as never, perks },
    createMatchConfig(match),
  );
}

// --- selection validation ---------------------------------------------------

test("a perk selection must be distinct, known ids, at most PER_PLAYER", () => {
  assert.deepEqual(normalizePerks([]), []);
  assert.deepEqual(normalizePerks(["deepPockets"]), ["deepPockets"]);
  assert.deepEqual(normalizePerks(["deepPockets", "extraGuards"]), [
    "deepPockets",
    "extraGuards",
  ]);
  // Too many, duplicated, unknown, or not an array at all.
  assert.equal(normalizePerks(["deepPockets", "extraGuards", "extraMedics"]), null);
  assert.equal(normalizePerks(["deepPockets", "deepPockets"]), null);
  assert.equal(normalizePerks(["nonsense"]), null);
  assert.equal(normalizePerks("deepPockets"), null);

  assert.equal(hasFullPerkSelection(undefined), false);
  assert.equal(hasFullPerkSelection(["deepPockets"]), false);
  assert.equal(hasFullPerkSelection(["deepPockets", "extraGuards"]), true);
});

test("canStart requires a full perk set from every playing participant", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "fire", ["deepPockets", "extraGuards"]));
  const b = matchPlayer("b", "water", ["deepPockets"]);
  match.addPlayer(b);
  assert.equal(match.canStart(), false); // b is one perk short
  b.perks = ["deepPockets", "extraMedics"];
  assert.equal(match.canStart(), true);
});

// --- combat perks -----------------------------------------------------------

test("Sharper Swords raises outgoing damage by its pct", () => {
  const plain = activeMatch([]);
  const perked = activeMatch(["sharperSwords"]);
  const opts = { forceCrit: false as const };
  const base = resolveDamage(plain.a, plain.b, 1000, opts).amount;
  const boosted = resolveDamage(perked.a, perked.b, 1000, opts).amount;
  assert.equal(base, 1000);
  assert.equal(boosted, Math.round(1000 * (1 + PERKS.ATTACK_PCT)));
});

test("Sharper Axes stacks multiplicatively with Fire's shield passive", () => {
  // Fire's "Roast!" already multiplies damage against a shielded castle; the
  // perk must compose with it, not replace it.
  const plain = activeMatch([], "fire");
  const perked = activeMatch(["sharperAxes"], "fire");
  for (const s of [plain, perked]) s.b.castle.shield = 100_000; // never overflows
  const opts = { forceCrit: false as const };
  const base = resolveDamage(plain.a, plain.b, 1000, opts).amount;
  const boosted = resolveDamage(perked.a, perked.b, 1000, opts).amount;
  assert.ok(base > 1000, "Fire's passive already boosts shield damage");
  // Compared as a ratio: the perk multiplies mid-pipeline, so the two integer
  // results can differ from each other's rounding by a dollar.
  assert.ok(
    Math.abs(boosted - base * (1 + PERKS.SHIELD_ATTACK_PCT)) <= 1,
    `${boosted} should be ~${base * (1 + PERKS.SHIELD_ATTACK_PCT)}`,
  );
});

test("Extra Guards cuts all incoming damage by its pct", () => {
  const plain = activeMatch([]);
  const perked = activeMatch([]);
  perked.b.perks = ["extraGuards"]; // the DEFENDER holds the perk
  const opts = { forceCrit: false as const };
  const base = resolveDamage(plain.a, plain.b, 1000, opts).amount;
  const cut = resolveDamage(perked.a, perked.b, 1000, opts).amount;
  assert.equal(base, 1000);
  assert.equal(cut, Math.round(1000 * (1 - PERKS.DAMAGE_REDUCTION_PCT)));
});

test("Extra Medics cuts DoT ticks, and stacks with Extra Guards", () => {
  // A synthetic DoT, so no kingdom's named burn/poison resistance interferes.
  const dot = (bearer: PlayerState, match: Match) => {
    applyStatus(
      bearer,
      {
        id: "perkTestDot",
        category: "debuff",
        stacking: "refresh",
        tickEffects: [{ type: "damage", amount: 100 }],
      },
      { sourceId: "a", durationTicks: 100 },
    );
    const before = bearer.castle.hp;
    processStatusTicks(match.gameState!);
    return before - bearer.castle.hp;
  };

  const plain = activeMatch([]);
  assert.equal(dot(plain.b, plain.match), 100);

  const medics = activeMatch([]);
  medics.b.perks = ["extraMedics"];
  assert.equal(dot(medics.b, medics.match), Math.round(100 * (1 - PERKS.DOT_REDUCTION_PCT)));

  // Both perks apply to a DoT tick — they stack rather than overriding.
  const both = activeMatch([]);
  both.b.perks = ["extraMedics", "extraGuards"];
  assert.equal(
    dot(both.b, both.match),
    Math.round(100 * (1 - PERKS.DOT_REDUCTION_PCT) * (1 - PERKS.DAMAGE_REDUCTION_PCT)),
  );
});

// --- utility perks ----------------------------------------------------------

test("Extra Repairs shortens every cooldown by its pct", () => {
  const { a } = activeMatch([]);
  const { a: perked } = activeMatch(["extraRepairs"]);
  setCooldown(a, "zap", 200);
  setCooldown(perked, "zap", 200);
  assert.equal(getCooldown(a, "zap"), 200);
  assert.equal(
    getCooldown(perked, "zap"),
    Math.round(200 * (1 - PERKS.COOLDOWN_REDUCTION_PCT)),
  );
});

test("Deep Pockets adds starting gold on top of a kingdom's own", () => {
  assert.equal(loneState("water", []).economy.currency, 0);
  assert.equal(
    loneState("water", ["deepPockets"]).economy.currency,
    PERKS.STARTING_GOLD,
  );
  // Space's "Blast off!" grants gold too — the perk adds to it.
  const spaceGold = loneState("space", []).economy.currency;
  assert.ok(spaceGold > 0, "Space starts with passive gold");
  assert.equal(
    loneState("space", ["deepPockets"]).economy.currency,
    spaceGold + PERKS.STARTING_GOLD,
  );
});

test("Great Merchants discounts ability unlock prices", () => {
  const { match, a } = activeMatch([], "fire");
  const { match: pMatch, a: perked } = activeMatch(["greatMerchants"], "fire");
  earn(a, 100_000);
  earn(perked, 100_000);
  const before = a.economy.currency;
  const perkedBefore = perked.economy.currency;

  assert.equal(unlockOrUpgradeAbility(match, a, "fireball").ok, true);
  assert.equal(unlockOrUpgradeAbility(pMatch, perked, "fireball").ok, true);

  const paid = before - a.economy.currency;
  const perkedPaid = perkedBefore - perked.economy.currency;
  assert.ok(paid > 0);
  assert.equal(perkedPaid, Math.ceil(paid * (1 - PERKS.UNLOCK_DISCOUNT_PCT)));
});

test("Better Construction reinforces bought and starting shields", () => {
  const { match, a } = activeMatch([]);
  const { match: pMatch, a: perked } = activeMatch(["betterConstruction"]);
  earn(a, 100_000);
  earn(perked, 100_000);
  assert.equal(buyShield(match, a).ok, true);
  assert.equal(buyShield(pMatch, perked).ok, true);
  assert.equal(perked.castle.shield, a.castle.shield + PERKS.SHIELD_BONUS_HP);

  // Earth opens the match already shielded — the perk reinforces that too.
  const earth = loneState("earth", []).castle.shield;
  assert.ok(earth > 0, "Earth starts shielded");
  assert.equal(
    loneState("earth", ["betterConstruction"]).castle.shield,
    earth + PERKS.SHIELD_BONUS_HP,
  );
  // A kingdom that starts bare gains nothing at start — only on purchase.
  assert.equal(loneState("water", ["betterConstruction"]).castle.shield, 0);
});
