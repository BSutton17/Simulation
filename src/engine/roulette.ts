import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { applyDamage } from "./combat.js";
import { healCastle } from "./abilities.js";
import { recalcIncome } from "./economy.js";
import { TICK } from "../data/balance.js";

/**
 * Joker's Roulette (its heavy attack). A EUROPEAN wheel — 37 pockets, a single
 * green zero — is put in front of the victim and their gold production stops
 * until they place a bet. There is no safe bet:
 *
 *  - red/black, and it lands  → half damage (you guessed right, you still pay)
 *  - red/black, and it misses → full damage
 *  - green, and it lands      → a large heal (1 in 37)
 *  - green, and it misses     → 1.5× damage
 *
 * So the colour bets are a coin flip between bad and worse, and green is a
 * 2.7% jackpot against a 97.3% beating.
 */

export type BetColor = "red" | "black" | "green";

/** The single-zero wheel in its real pocket order, clockwise from 0. */
export const WHEEL_POCKETS: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** The 18 red numbers; every other non-zero pocket is black. */
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

/** The colour of a pocket. Zero is the house's. */
export function colorOfPocket(pocket: number): BetColor {
  if (pocket === 0) return "green";
  return RED_NUMBERS.has(pocket) ? "red" : "black";
}

export function isBetColor(value: unknown): value is BetColor {
  return value === "red" || value === "black" || value === "green";
}

/** Full damage for a losing colour bet — every other payout scales off this. */
export const ROULETTE_DAMAGE = 1000;
/** A right colour call still costs you, at half. There is no safe bet: calling
 *  it correctly halves the hit, it never avoids it. */
export const ROULETTE_HALF_DAMAGE = ROULETTE_DAMAGE / 2;
/** Missing on green is the worst result on the table. */
export const ROULETTE_GREEN_MISS_MULTIPLIER = 1.5;
/** Hitting green — a 1-in-37 jackpot — heals instead. */
export const ROULETTE_GREEN_HEAL = 2000;

/** How long the wheel visibly spins before the result is public. */
export const ROULETTE_REVEAL_TICKS = 6 * TICK.RATE; // 6 s

export interface RouletteResult {
  /** The winning pocket number (0–36). */
  pocket: number;
  /** Its colour. */
  color: BetColor;
  /** What the victim bet. */
  bet: BetColor;
  won: boolean;
  /** Damage dealt (0 on a green hit). */
  damage: number;
  /** Health restored (0 unless green hit). */
  healed: number;
}

/** Spins the wheel: one pocket, uniformly, out of 37. */
export function spinWheel(rng: () => number): number {
  const index = Math.min(
    WHEEL_POCKETS.length - 1,
    Math.floor(rng() * WHEEL_POCKETS.length),
  );
  return WHEEL_POCKETS[index]!;
}

/** What a bet is worth against a landed pocket. Pure. */
export function settleBet(
  bet: BetColor,
  pocket: number,
): { won: boolean; damage: number; heal: number } {
  const landed = colorOfPocket(pocket);
  const won = landed === bet;
  if (bet === "green") {
    return won
      ? { won, damage: 0, heal: ROULETTE_GREEN_HEAL }
      : { won, damage: Math.round(ROULETTE_DAMAGE * ROULETTE_GREEN_MISS_MULTIPLIER), heal: 0 };
  }
  return won
    ? { won, damage: ROULETTE_HALF_DAMAGE, heal: 0 }
    : { won, damage: ROULETTE_DAMAGE, heal: 0 };
}

/**
 * A short summary of a spin. No percentages — same rule as the slots.
 *
 * `subject` is who the sentence is about: omit it for the person who placed the
 * bet ("you called it"), or pass a name for everyone ELSE watching, which is
 * what Joker's mirror shows ("Alice called it"). One function, so the two
 * points of view can never drift apart.
 */
export function describeResult(result: RouletteResult, subject?: string): string {
  const pocketLabel = `${result.pocket} ${result.color}`;
  if (subject) {
    // Told ABOUT someone: name them, and say what happened to them.
    if (result.healed > 0) return `${pocketLabel} — ${subject} hit green and healed`;
    if (result.won) return `${pocketLabel} — ${subject} called it, took half damage`;
    return `${pocketLabel} — ${subject} took ${result.damage} damage`;
  }
  if (result.healed > 0) return `${pocketLabel} — you hit green, and healed`;
  if (result.won) return `${pocketLabel} — you called it, half damage`;
  return `${pocketLabel} — you missed, ${result.damage} damage`;
}

/**
 * Places the victim's bet and spins. The wheel resolves immediately and
 * authoritatively — gold production resumes at once, even though the ball is
 * still visibly rolling on every screen until `revealTick`.
 */
export function placeRouletteBet(
  match: Match,
  player: PlayerState,
  bet: BetColor,
  rng: () => number = match.rng,
): RouletteResult | null {
  const owed = player.pendingBet;
  if (!owed) return null;

  const pocket = spinWheel(rng);
  const { won, damage, heal } = settleBet(bet, pocket);
  const color = colorOfPocket(pocket);

  // The debt is settled the moment the bet is placed.
  player.pendingBet = null;

  let healed = 0;
  if (damage > 0) {
    const applied = applyDamage(player, damage, { tick: match.tick });
    const bus = match.gameState!.events;
    if (bus.enabled) {
      bus.emit({
        type: "damage",
        tick: match.tick,
        sourceId: owed.sourceId,
        targetId: player.id,
        amount: applied.absorbedByShield + applied.dealtToHp,
        absorbedByShield: applied.absorbedByShield,
        dealtToHp: applied.dealtToHp,
        overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
        crit: false,
        cause: "roulette",
      });
    }
  }
  if (heal > 0) {
    healed = healCastle(player, heal);
    const bus = match.gameState!.events;
    if (healed > 0 && bus.enabled) {
      bus.emit({
        type: "heal",
        tick: match.tick,
        targetId: player.id,
        amount: healed,
        overheal: heal - healed,
        cause: "roulette",
      });
    }
  }

  const result: RouletteResult = { pocket, color, bet, won, damage, healed };
  player.lastBet = {
    pocket,
    color,
    bet,
    outcome: describeResult(result),
    // The same verdict told about them rather than to them — this is what
    // Joker reads off its mirror, so it never says "you" about someone else.
    publicOutcome: describeResult(result, player.name),
    revealTick: match.tick + ROULETTE_REVEAL_TICKS,
  };
  recalcIncome(player);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "rouletteSettled",
      tick: match.tick,
      playerId: player.id,
      pocket,
      color,
      bet,
      result: player.lastBet.outcome,
      revealTick: player.lastBet.revealTick,
    });
  }
  return result;
}
