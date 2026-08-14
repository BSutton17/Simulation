import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { computeStat } from "../src/engine/modifiers.js";
import { perkDamageMultiplier, PERK_SUPPRESSION_STAT } from "../src/engine/perks.js";
import { earn } from "../src/engine/money.js";
import {
  SYMBOL_POOL,
  classifySpin,
  outcomeFor,
  describeOutcome,
  spinSlotMachine,
  SPIN_REVEAL_TICKS,
  type SlotSymbol,
} from "../src/engine/slotMachine.js";
import { SLOT_MACHINE } from "../src/data/jokerAbilities.js";
import { SHIELD, TICK } from "../src/data/balance.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Joker's Slot Machine. The payout table is the design; these tests pin the
// strip's composition (which IS the published odds), the classification, and
// the machine's grip on the victim's economy.

const matchPlayer = (
  id: string,
  kingdomId: string,
  perks: MatchPlayer["perks"] = [],
): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks,
  ready: true,
  connected: true,
});

function slotMatch(perks: MatchPlayer["perks"] = []) {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "joker"));
  match.addPlayer(matchPlayer("b", "water", perks));
  match.addPlayer(matchPlayer("c", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, SLOT_MACHINE.id).ok, true);
  return {
    match,
    a,
    b: match.gameState!.getPlayer("b")!,
    c: match.gameState!.getPlayer("c")!,
  };
}

/** An RNG that returns the given values in order, then repeats the last. */
const scripted = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
};

/** The roll that lands on a given symbol from the 36-slot strip. */
const rollFor = (symbol: SlotSymbol) =>
  SYMBOL_POOL.indexOf(symbol) / SYMBOL_POOL.length;

// --- The strip --------------------------------------------------------------

test("the reel strip is 36 symbols in the published weights", () => {
  assert.equal(SYMBOL_POOL.length, 36);
  const count = (s: SlotSymbol) => SYMBOL_POOL.filter((x) => x === s).length;
  assert.equal(count("🪙"), 10);
  assert.equal(count("🗡️"), 8);
  assert.equal(count("🛡️"), 6);
  assert.equal(count("🏰"), 5);
  assert.equal(count("👑"), 4);
  assert.equal(count("💎"), 2);
  assert.equal(count("7️⃣"), 1);
});

test("three independent reels give the published match odds", () => {
  // Enumerate the whole 36³ space rather than trusting a stated percentage.
  let none = 0;
  let pair = 0;
  let triple = 0;
  for (const x of SYMBOL_POOL) {
    for (const y of SYMBOL_POOL) {
      for (const z of SYMBOL_POOL) {
        const kind = classifySpin([x, y, z]).match;
        if (kind === "none") none++;
        else if (kind === "pair") pair++;
        else triple++;
      }
    }
  }
  const total = 36 ** 3;
  assert.ok(Math.abs((none / total) * 100 - 51.31) < 0.01, `${(none / total) * 100}`);
  assert.ok(Math.abs((pair / total) * 100 - 44.56) < 0.01, `${(pair / total) * 100}`);
  assert.ok(Math.abs((triple / total) * 100 - 4.13) < 0.01, `${(triple / total) * 100}`);
});

test("spins classify into no-match, pair, and triple", () => {
  assert.deepEqual(classifySpin(["🪙", "🗡️", "🛡️"]), { match: "none", symbol: null });
  assert.deepEqual(classifySpin(["🪙", "🪙", "🛡️"]), { match: "pair", symbol: "🪙" });
  // A pair split by the odd reel still counts.
  assert.deepEqual(classifySpin(["🪙", "🛡️", "🪙"]), { match: "pair", symbol: "🪙" });
  assert.deepEqual(classifySpin(["🛡️", "🪙", "🪙"]), { match: "pair", symbol: "🪙" });
  assert.deepEqual(classifySpin(["7️⃣", "7️⃣", "7️⃣"]), { match: "triple", symbol: "7️⃣" });
});

test("the payout table matches the design", () => {
  assert.deepEqual(outcomeFor("none", null), { kind: "damage", amount: 2000 });
  assert.deepEqual(outcomeFor("pair", "🪙"), { kind: "damage", amount: 1000 });
  assert.deepEqual(outcomeFor("triple", "🪙"), { kind: "damage", amount: 500 });
  assert.equal(outcomeFor("pair", "🗡️").kind, "slowIncome");
  assert.equal(outcomeFor("triple", "🗡️").kind, "raiseCooldowns");
  assert.equal(outcomeFor("pair", "🏰").kind, "suppressPerks");
  assert.deepEqual(outcomeFor("triple", "🏰"), { kind: "nothing" });
  assert.deepEqual(outcomeFor("triple", "👑"), { kind: "shield" });
  assert.deepEqual(outcomeFor("triple", "7️⃣"), { kind: "healPercent", pct: 1 });
});

test("the result text never leaks a percentage", () => {
  for (const kind of ["none", "pair", "triple"] as const) {
    for (const symbol of ["🪙", "🗡️", "🛡️", "🏰", "👑", "💎", "7️⃣"] as const) {
      const text = describeOutcome(outcomeFor(kind, kind === "none" ? null : symbol));
      assert.equal(text.includes("%"), false, `"${text}" leaks a percentage`);
    }
  }
});

// --- The machine's grip -----------------------------------------------------

test("the ultimate hands every OTHER kingdom a machine and freezes their gold", () => {
  const { match, a, b, c } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);

  assert.ok(b.pendingSpin, "b was not given a machine");
  assert.ok(c.pendingSpin, "c was not given a machine");
  assert.equal(a.pendingSpin, null, "Joker gave itself a machine");
  assert.equal(b.pendingSpin!.sourceId, a.id);

  // Income stops dead while the spin is owed — and Joker's keeps flowing.
  b.economy.citizens = 50;
  const jokerBefore = a.economy.currency;
  const victimBefore = b.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.equal(b.economy.currency, victimBefore, "a frozen treasury still earned");
  assert.equal(b.economy.incomePerTick, 0);
  assert.ok(a.economy.currency > jokerBefore, "Joker's own income stopped too");
});

test("pulling the lever frees the gold and settles the debt", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  b.economy.citizens = 50;

  // Two 🪙 then a 🛡️: a coin pair, a plain 1000 hit.
  const spin = spinSlotMachine(
    match,
    b,
    scripted(rollFor("🪙"), rollFor("🪙"), rollFor("🛡️")),
  );
  assert.ok(spin);
  assert.equal(spin!.match, "pair");
  assert.equal(b.castle.maxHp - b.castle.hp, 1000);

  assert.equal(b.pendingSpin, null, "the debt was not settled");
  const before = b.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.ok(b.economy.currency > before, "gold production did not resume");
});

test("spinning without a machine is refused", () => {
  const { match, b } = slotMatch();
  assert.equal(spinSlotMachine(match, b), null);
});

test("a second machine doesn't stack on someone already stuck at one", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  const first = b.pendingSpin;
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  assert.equal(b.pendingSpin, first);
});

test("the result is held back until revealTick so every screen agrees", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  match.tick = 100;
  spinSlotMachine(match, b, scripted(rollFor("🪙"), rollFor("🗡️"), rollFor("🛡️")));

  assert.ok(b.lastSpin);
  assert.equal(b.lastSpin!.revealTick, 100 + SPIN_REVEAL_TICKS);
  assert.equal(b.lastSpin!.symbols.length, 3);
  assert.equal(b.lastSpin!.outcome, "Took 2000 damage"); // no match
});

// --- The outcomes -----------------------------------------------------------

test("a no-match deals the heavy hit", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  spinSlotMachine(match, b, scripted(rollFor("🪙"), rollFor("🗡️"), rollFor("🛡️")));
  assert.equal(b.castle.maxHp - b.castle.hp, 2000);
});

test("the gold-production nerfs last a long time — that is their sting", () => {
  const sword = outcomeFor("pair", "🗡️");
  const shield = outcomeFor("pair", "🛡️");
  assert.equal(sword.kind, "slowIncome");
  assert.equal(shield.kind, "slowIncome");
  assert.equal((sword as { durationTicks: number }).durationTicks, 45 * TICK.RATE);
  assert.equal((shield as { durationTicks: number }).durationTicks, 30 * TICK.RATE);
});

test("a sword pair slows gold production", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  spinSlotMachine(match, b, scripted(rollFor("🗡️"), rollFor("🗡️"), rollFor("🪙")));
  assert.equal(computeStat(b, "income", 100), 25); // 75% slower
});

test("a crown pair lengthens cooldowns", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  spinSlotMachine(match, b, scripted(rollFor("👑"), rollFor("👑"), rollFor("🪙")));
  assert.equal(computeStat(b, "cooldown", 100), 125); // +25%
});

test("a castle pair switches the victim's perks off, then back on", () => {
  const { match, a, b } = slotMatch(["sharperSwords", "extraGuards"]);
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  assert.ok(perkDamageMultiplier(b) > 1, "the perk was not active to begin with");

  spinSlotMachine(match, b, scripted(rollFor("🏰"), rollFor("🏰"), rollFor("🪙")));
  assert.ok(computeStat(b, PERK_SUPPRESSION_STAT, 0) > 0);
  assert.equal(perkDamageMultiplier(b), 1, "perks survived the suppression");

  // The suppression is a timed modifier, so it lifts on its own.
  b.modifiers = [];
  assert.ok(perkDamageMultiplier(b) > 1, "perks did not come back");
});

test("a crown triple hands over a full shield", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  spinSlotMachine(match, b, scripted(rollFor("👑"), rollFor("👑"), rollFor("👑")));
  assert.equal(b.castle.shield, SHIELD.STANDARD_HP);
});

test("triple sevens heal the castle to full", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  b.castle.hp = 1;
  spinSlotMachine(match, b, scripted(rollFor("7️⃣"), rollFor("7️⃣"), rollFor("7️⃣")));
  assert.equal(b.castle.hp, b.castle.maxHp);
});

test("a castle triple is the designed dud", () => {
  const { match, a, b } = slotMatch();
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);
  const before: PlayerState = JSON.parse(JSON.stringify(b));
  spinSlotMachine(match, b, scripted(rollFor("🏰"), rollFor("🏰"), rollFor("🏰")));
  assert.equal(b.castle.hp, before.castle.hp);
  assert.equal(b.castle.shield, before.castle.shield);
  assert.equal(b.modifiers.length, 0);
  assert.equal(b.lastSpin!.outcome, "Nothing happened");
});
