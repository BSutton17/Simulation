import type { PlayerState } from "../match/playerState.js";

/**
 * Joker's Blackjack deck (`data/jokerAbilities.ts`). A real 54-card deck —
 * four each of Ace through King, plus two jokers — drawn from uniformly, so the
 * odds are the deck's own rather than a hand-tuned damage table.
 *
 * Pure and deterministic given an RNG, so a match's seeded generator replays
 * identical draws (#203).
 */

/** Damage per pip on a number card. Face cards and jokers are flat, below. */
export const DAMAGE_PER_RANK = 75;

/** Flat damage for a face card (Jack, Queen, King), whatever its suit. */
export const FACE_CARD_DAMAGE = 750;

/** Flat damage for one of the deck's two jokers — the best draw in the deck. */
export const JOKER_CARD_DAMAGE = 1000;

/**
 * The Ace's rank for damage purposes: an 11, worth 825 — the second-best card
 * in the deck behind a joker. It used to count as a 1 (75, the worst draw),
 * which made Blackjack's floor so low that a quarter of the deck was close to
 * a wasted cast at 250 gold. Raising it lifts Joker's damage where the kingdom
 * was weakest: the bottom of its range, not the top.
 *
 * Ace of Spades still does not strip aces — it would now be throwing away one
 * of the best cards it could draw.
 */
export const ACE_RANK = 11;

/**
 * The four suits. Every card carries one, and the suit decides what the hit
 * does BESIDES damage — so a draw has two independent axes: how hard it lands
 * (rank) and what it leaves behind (suit).
 */
export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export type Suit = (typeof SUITS)[number];

/** Diamonds hit harder — the only suit that touches the damage itself. */
export const DIAMOND_DAMAGE_MULTIPLIER = 1.1;

/** Ranks that are FACE cards rather than numbered ones. */
export const FACE_RANKS = [11, 12, 13] as const;

/** How many of each rank a standard deck holds (one per suit). */
const COPIES_PER_RANK = 4;

/** Jokers in the deck. */
const JOKER_COUNT = 2;

/** A single drawn card. `rank` is null for a joker, which has no rank. */
export interface DrawnCard {
  /** 1–13 for Ace–King (Ace draws as `ACE_RANK` damage), null for a joker. */
  rank: number | null;
  /** Human-readable label for events/UI ("7", "Queen", "Joker"). */
  label: string;
  /** Damage this card deals, diamonds already boosted. */
  damage: number;
  /** The suit drawn, or null for a joker — jokers are suitless, so they carry
   *  no rider at all and are pure damage. */
  suit: Suit | null;
}

const RANK_LABELS: Record<number, string> = {
  1: "Ace",
  11: "Jack",
  12: "Queen",
  13: "King",
};

const labelFor = (rank: number): string => RANK_LABELS[rank] ?? String(rank);

/** Damage a given rank deals: face cards flat, everything else per-pip. */
export function damageForRank(rank: number): number {
  if ((FACE_RANKS as readonly number[]).includes(rank)) return FACE_CARD_DAMAGE;
  const pips = rank === 1 ? ACE_RANK : rank;
  return pips * DAMAGE_PER_RANK;
}

/**
 * The ranks currently missing from a player's deck (Joker's Ace of Spades
 * strips the 2s and 3s for a few seconds, raising the floor on the next draw).
 */
export function strippedRanks(player: PlayerState): readonly number[] {
  const out = new Set<number>();
  for (const s of player.statuses) {
    for (const rank of s.strippedCardRanks ?? []) out.add(rank);
  }
  return [...out];
}

/**
 * Builds `player`'s current deck as a flat list of draws, honouring whatever
 * their statuses have stripped out. Jokers are never strippable.
 */
export function buildDeck(player: PlayerState): DrawnCard[] {
  const missing = strippedRanks(player);
  const deck: DrawnCard[] = [];
  for (let rank = 1; rank <= 13; rank++) {
    if (missing.includes(rank)) continue;
    // One copy per suit, exactly like a real deck — which is also what makes
    // each suit's rider a clean 1-in-4.
    for (let i = 0; i < COPIES_PER_RANK; i++) {
      const suit = SUITS[i]!;
      const base = damageForRank(rank);
      deck.push({
        rank,
        label: labelFor(rank),
        suit,
        damage:
          suit === "diamonds"
            ? Math.round(base * DIAMOND_DAMAGE_MULTIPLIER)
            : base,
      });
    }
  }
  for (let i = 0; i < JOKER_COUNT; i++) {
    deck.push({ rank: null, label: "Joker", damage: JOKER_CARD_DAMAGE, suit: null });
  }
  return deck;
}

/**
 * Draws one card uniformly from `player`'s current deck. Every copy is its own
 * entry, so stripping the 2s and 3s genuinely shifts the odds rather than just
 * re-rolling a lookup.
 */
export function drawBlackjackCard(
  player: PlayerState,
  rng: () => number,
): DrawnCard {
  const deck = buildDeck(player);
  // A deck can never be emptied by the strip effects that exist, but a future
  // one could; falling back to a joker keeps the draw total.
  if (deck.length === 0) {
    return { rank: null, label: "Joker", damage: JOKER_CARD_DAMAGE, suit: null };
  }
  const index = Math.min(deck.length - 1, Math.floor(rng() * deck.length));
  return deck[index]!;
}
