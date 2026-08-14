import { SHIELD, TICK } from "../data/balance.js";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { applyDamage } from "./combat.js";
import { addModifier } from "./modifiers.js";
import { healCastle } from "./abilities.js";
import { recalcIncome } from "./economy.js";
import { PERK_SUPPRESSION_STAT } from "./perks.js";
import { param } from "./parameters.js";

/**
 * Joker's Slot Machine (its ultimate). Every other kingdom is handed a machine
 * and their gold production stops dead until they pull the lever. The spin is
 * mostly bad and occasionally spectacular, and there is no way to decline it —
 * the only choice is how long you are willing to go without income.
 *
 * The reel pool below is a literal 36-symbol strip, so the published odds are
 * the strip's own rather than a hand-written probability table: three
 * independent draws give 51.31% no-match, 44.56% a pair, 4.13% a triple.
 */

export type SlotSymbol = "🪙" | "🗡️" | "🛡️" | "🏰" | "👑" | "💎" | "7️⃣";

/**
 * One reel strip: 36 symbols, weighted by how many copies each gets. Draws are
 * uniform over this array, so changing a weight changes the odds directly.
 */
export const SYMBOL_POOL: readonly SlotSymbol[] = [
  ...Array<SlotSymbol>(10).fill("🪙"),
  ...Array<SlotSymbol>(8).fill("🗡️"),
  ...Array<SlotSymbol>(6).fill("🛡️"),
  ...Array<SlotSymbol>(5).fill("🏰"),
  ...Array<SlotSymbol>(4).fill("👑"),
  ...Array<SlotSymbol>(2).fill("💎"),
  ...Array<SlotSymbol>(1).fill("7️⃣"),
];

/** How a spin's three symbols came up. */
export type SlotMatchKind = "none" | "pair" | "triple";

/** What a spin does to whoever pulled the lever. */
export type SlotOutcome =
  | { kind: "damage"; amount: number }
  | { kind: "slowIncome"; pct: number; durationTicks: number }
  | { kind: "raiseCooldowns"; pct: number; durationTicks: number }
  | { kind: "suppressPerks"; durationTicks: number }
  | { kind: "shield" }
  | { kind: "healPercent"; pct: number }
  | { kind: "nothing" };

/** The payout table, by symbol and by how many of it came up. */
const OUTCOMES: Record<SlotSymbol, { pair: SlotOutcome; triple: SlotOutcome }> = {
  "🪙": {
    pair: { kind: "damage", amount: 1000 },
    triple: { kind: "damage", amount: 500 },
  },
  "🗡️": {
    // The economy nerfs bite for a long time — that is the sting, not the rate.
    pair: { kind: "slowIncome", pct: 0.75, durationTicks: 45 * TICK.RATE },
    triple: { kind: "raiseCooldowns", pct: 0.5, durationTicks: 20 * TICK.RATE },
  },
  "🛡️": {
    pair: { kind: "slowIncome", pct: 0.5, durationTicks: 30 * TICK.RATE },
    triple: { kind: "raiseCooldowns", pct: 0.25, durationTicks: 10 * TICK.RATE },
  },
  "🏰": {
    pair: { kind: "suppressPerks", durationTicks: 20 * TICK.RATE },
    triple: { kind: "nothing" },
  },
  "👑": {
    pair: { kind: "raiseCooldowns", pct: 0.25, durationTicks: 10 * TICK.RATE },
    triple: { kind: "shield" },
  },
  "💎": {
    pair: { kind: "suppressPerks", durationTicks: 10 * TICK.RATE },
    triple: { kind: "healPercent", pct: 0.5 },
  },
  "7️⃣": {
    pair: { kind: "healPercent", pct: 0.25 },
    triple: { kind: "healPercent", pct: 1 },
  },
};

/** Nothing matched — the most likely result, and a plain heavy hit. */
const NO_MATCH_OUTCOME: SlotOutcome = { kind: "damage", amount: 2000 };

/** How long the reels visibly spin before the result is public (client + Joker
 *  both use this, so the reveal lands at the same moment for everyone). */
export const SPIN_REVEAL_TICKS = 4 * TICK.RATE; // 4 s

export interface SlotSpin {
  symbols: [SlotSymbol, SlotSymbol, SlotSymbol];
  match: SlotMatchKind;
  /** The symbol that matched, for a pair or triple; null for no match. */
  symbol: SlotSymbol | null;
  outcome: SlotOutcome;
}

/** Classifies three symbols into no-match / pair / triple. */
export function classifySpin(
  symbols: readonly [SlotSymbol, SlotSymbol, SlotSymbol],
): { match: SlotMatchKind; symbol: SlotSymbol | null } {
  const [a, b, c] = symbols;
  if (a === b && b === c) return { match: "triple", symbol: a };
  if (a === b) return { match: "pair", symbol: a };
  if (a === c) return { match: "pair", symbol: a };
  if (b === c) return { match: "pair", symbol: b };
  return { match: "none", symbol: null };
}

/** The outcome for a classified spin. */
export function outcomeFor(
  match: SlotMatchKind,
  symbol: SlotSymbol | null,
): SlotOutcome {
  if (match === "none" || symbol === null) return NO_MATCH_OUTCOME;
  return match === "triple" ? OUTCOMES[symbol].triple : OUTCOMES[symbol].pair;
}

/** Rolls three independent reels off the strip. */
export function rollSymbols(
  rng: () => number,
): [SlotSymbol, SlotSymbol, SlotSymbol] {
  const pull = (): SlotSymbol =>
    SYMBOL_POOL[
      Math.min(SYMBOL_POOL.length - 1, Math.floor(rng() * SYMBOL_POOL.length))
    ]!;
  return [pull(), pull(), pull()];
}

/**
 * A short, player-facing description of what a spin did. Percentages are
 * deliberately omitted — the machine says what happened, not by how much, and
 * players learn the table by playing.
 */
export function describeOutcome(outcome: SlotOutcome): string {
  switch (outcome.kind) {
    case "damage":
      return `Took ${outcome.amount} damage`;
    case "slowIncome":
      return "Gold production slowed";
    case "raiseCooldowns":
      return "Cooldowns lengthened";
    case "suppressPerks":
      return "Perks suppressed";
    case "shield":
      return "Received a full shield";
    case "healPercent":
      return outcome.pct >= 1 ? "Fully healed" : "Healed";
    case "nothing":
      return "Nothing happened";
  }
}

/**
 * Applies a spin's outcome to the player who pulled the lever. Effects are flat
 * and unresisted — the machine is not an attack, it is a verdict.
 */
export function applySlotOutcome(
  match: Match,
  player: PlayerState,
  outcome: SlotOutcome,
  sourceId: string,
): void {
  const bus = match.gameState!.events;
  const seq = match.nextSeq();

  switch (outcome.kind) {
    case "damage": {
      const applied = applyDamage(player, outcome.amount, { tick: match.tick });
      if (bus.enabled) {
        bus.emit({
          type: "damage",
          tick: match.tick,
          sourceId,
          targetId: player.id,
          amount: applied.absorbedByShield + applied.dealtToHp,
          absorbedByShield: applied.absorbedByShield,
          dealtToHp: applied.dealtToHp,
          overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
          crit: false,
          cause: "slotMachine",
        });
      }
      break;
    }
    case "slowIncome":
      addModifier(player, {
        id: `slot:income:${seq}`,
        stat: "income",
        op: "mult",
        value: Math.max(0, 1 - outcome.pct),
        sourceId,
        remainingTicks: outcome.durationTicks,
      });
      recalcIncome(player);
      break;
    case "raiseCooldowns":
      addModifier(player, {
        id: `slot:cooldown:${seq}`,
        stat: "cooldown",
        op: "mult",
        value: 1 + outcome.pct,
        sourceId,
        remainingTicks: outcome.durationTicks,
      });
      break;
    case "suppressPerks":
      addModifier(player, {
        id: `slot:perks:${seq}`,
        stat: PERK_SUPPRESSION_STAT,
        op: "add",
        value: 1,
        sourceId,
        remainingTicks: outcome.durationTicks,
      });
      break;
    case "shield": {
      const granted = param("shield.standardHp", SHIELD.STANDARD_HP);
      player.castle.shield += granted;
      if (bus.enabled) {
        bus.emit({
          type: "shieldGained",
          tick: match.tick,
          playerId: player.id,
          amount: granted,
          total: player.castle.shield,
          cause: "slotMachine",
        });
      }
      break;
    }
    case "healPercent": {
      const healed = healCastle(
        player,
        Math.round(player.castle.maxHp * outcome.pct),
      );
      if (healed > 0 && bus.enabled) {
        bus.emit({
          type: "heal",
          tick: match.tick,
          targetId: player.id,
          amount: healed,
          overheal: 0,
          cause: "slotMachine",
        });
      }
      break;
    }
    case "nothing":
      break;
  }
}

/**
 * Pulls the lever for a player who owes a spin: rolls the reels, applies the
 * verdict, and frees their gold production. Rejected if they owe nothing.
 */
export function spinSlotMachine(
  match: Match,
  player: PlayerState,
  rng: () => number = match.rng,
): SlotSpin | null {
  const owed = player.pendingSpin;
  if (!owed) return null;

  const symbols = rollSymbols(rng);
  const { match: kind, symbol } = classifySpin(symbols);
  const outcome = outcomeFor(kind, symbol);

  // The debt is settled the moment the lever is pulled: income resumes now,
  // even though the reels are still turning on everyone's screen.
  player.pendingSpin = null;
  player.lastSpin = {
    symbols,
    outcome: describeOutcome(outcome),
    revealTick: match.tick + SPIN_REVEAL_TICKS,
  };
  applySlotOutcome(match, player, outcome, owed.sourceId);
  recalcIncome(player);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "slotSpun",
      tick: match.tick,
      playerId: player.id,
      symbols: [...symbols],
      result: describeOutcome(outcome),
      revealTick: player.lastSpin.revealTick,
    });
  }
  return { symbols, match: kind, symbol, outcome };
}
