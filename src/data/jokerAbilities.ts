import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Joker Kingdom ability set. Joker gambles: most of its kit rolls dice, and its
 * own basic attack is the one lever it has on those odds.
 *
 *  - Ace of Spades (basic) — a plain hit that also pulls every 2 and 3 out of
 *    the Blackjack deck for a few seconds, raising the floor on the next draw.
 *    It never strips aces, which are now among the deck's best cards.
 *  - Blackjack (med) — draws one card from a real 54-card deck and hits for
 *    what it is worth, from a lousy 2 to a joker.
 *  - Roulette (heavy) — a European wheel the victim must bet on before their
 *    gold production restarts. No bet is safe; green is a 1-in-37 jackpot.
 *  - Lucky Draw (utility) — one of five faces, every cast.
 *
 *  - Slot Machine (ultimate) — every other kingdom is handed a machine and
 *    their gold production stops until they pull the lever. What the reels do
 *    to them is mostly bad and occasionally spectacular.
 *
 * The kit is complete.
 *
 * Passives are `KINGDOM_PASSIVES.joker` ("Beginners luck", "Why so serious?").
 * Magnitudes are initial, tunable defaults.
 */

/**
 * "Stacked Deck" — Ace of Spades' rider. While it holds, every 2 and 3 is
 * missing from Joker's Blackjack deck, so the worst two draws are off the
 * table and the expected card is worth noticeably more.
 */
export const STACKED_DECK_STATUS: StatusEffectDefinition = {
  id: "stackedDeck",
  name: "Stacked Deck",
  category: "buff",
  stacking: "refresh",
  strippedCardRanks: [2, 3],
};

/** How long the 2s and 3s stay out of the deck. */
export const STACKED_DECK_DURATION = 5 * TICK.RATE; // 5 s

/**
 * Ace of Spades (basic): the reliable "Q", and Joker's only way to influence
 * its own luck — casting it strips the deck's two worst cards for 5 seconds,
 * so the follow-up Blackjack draws from a better one.
 */
export const ACE_OF_SPADES: AbilityDefinition = {
  id: "aceOfSpades",
  name: "Ace of Spades",
  kind: "attack",
  cost: 81,
  unlockCost: 41,
  cooldownTicks: Math.round(2.15 * TICK.RATE), // 3.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 159, element: "joker" } },
    {
      type: "status",
      target: "self",
      params: { status: STACKED_DECK_STATUS, durationTicks: STACKED_DECK_DURATION },
    },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 205 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: 33,
        costMultiplier: 0.85,
      },
    },
    // Lv4: the deck stays stacked longer, widening the follow-up window.
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [
          null,
          { status: STACKED_DECK_STATUS, durationTicks: 8 * TICK.RATE },
        ],
      },
    },
  ],
};

/**
 * Blackjack's SUIT riders. The rank decides how hard the card hits; the suit
 * decides what it leaves behind, so every draw is two rolls at once. Diamonds
 * are the exception — they have no status, they simply hit 10% harder (see
 * `DIAMOND_DAMAGE_MULTIPLIER` in engine/blackjack.ts).
 *
 * Jokers are suitless and therefore carry no rider: the deck's best card is
 * pure, undiluted damage.
 */
export const SPADE_STATUS: StatusEffectDefinition = {
  id: "blackjackSpade",
  name: "Spade — Blunted",
  category: "debuff",
  stacking: "refresh",
  modifiers: [{ stat: "damage", op: "mult", value: 0.9 }],
};

export const CLUB_STATUS: StatusEffectDefinition = {
  id: "blackjackClub",
  name: "Club — Skimmed",
  category: "debuff",
  stacking: "refresh",
  modifiers: [{ stat: "income", op: "mult", value: 0.85 }],
};

export const HEART_STATUS: StatusEffectDefinition = {
  id: "blackjackHeart",
  name: "Heart — Exposed",
  category: "debuff",
  stacking: "refresh",
  // Their guard drops: everything lands 15% harder while it holds.
  modifiers: [{ stat: "damageTaken", op: "mult", value: 1.15 }],
};

/** How long each suit's rider lasts. */
export const SPADE_DURATION = 15 * TICK.RATE; // 15 s
export const CLUB_DURATION = 10 * TICK.RATE; // 10 s
export const HEART_DURATION = 15 * TICK.RATE; // 15 s

/**
 * How long the reveal cinematic runs before the card REACHES the victim: the
 * summon, the fly-in (during which the card turns over), the 3 s showcase, and
 * the throw. The damage is held for exactly this long so it lands on the frame
 * the card arrives and never a moment sooner.
 *
 * The client's `STAGE_START.impact` is the same instant — a test pins the two
 * together, so retuning a stage there will fail loudly rather than silently
 * hurting the victim mid-showcase.
 */
export const BLACKJACK_IMPACT_DELAY = Math.round(4.75 * TICK.RATE); // 4.75 s

/**
 * Blackjack (med): draw one card and hit for it. A real 54-card deck — four
 * each of Ace through King plus two jokers — so the spread is the deck's own:
 * a 2 is a poor cast at 150, a joker is 1000, and everything in between is
 * rank × 75 (an Ace counts as 11 — 825, second only to a joker — and face
 * cards are a flat 750). See `engine/blackjack.ts`.
 */
export const BLACKJACK: AbilityDefinition = {
  id: "blackjack",
  name: "Blackjack",
  kind: "attack",
  cost: 385,
  unlockCost: 193,
  cooldownTicks: Math.round(6.6 * TICK.RATE), // 11 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "blackjackDraw",
      target: "target",
      params: {
        element: "joker",
        cardDamageMultiplier: 1,
        // The suit riders, applied when the card lands. Diamonds are absent on
        // purpose — their bonus is baked into the card's damage instead.
        suitStatuses: {
          spades: { status: SPADE_STATUS, durationTicks: SPADE_DURATION },
          clubs: { status: CLUB_STATUS, durationTicks: CLUB_DURATION },
          hearts: { status: HEART_STATUS, durationTicks: HEART_DURATION },
        },
        // The card's cinematic runs before it lands, and the victim must not
        // be hurt until it physically reaches them. Kept in step with the
        // client's `BLACKJACK_TOTAL_MS`.
        delayTicks: BLACKJACK_IMPACT_DELAY,
      },
    },
  ],
  upgradePath: [
    // The whole deck scales at once rather than restating its table.
    { level: 1, cost: 250, changes: { effectParams: [{ cardDamageMultiplier: 1.2 }] } },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: 86,
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 500, changes: { effectParams: [{ cardDamageMultiplier: 1.45 }] } },
  ],
};

/** Lucky Draw's ongoing faces — each lasts the ability's duration. */
export const LUCKY_ATTACK_STATUS: StatusEffectDefinition = {
  id: "luckyAttack",
  name: "Lucky Draw — Sharpened",
  category: "buff",
  stacking: "refresh",
  modifiers: [{ stat: "damage", op: "mult", value: 1.1 }],
};

export const LUCKY_ARMOR_STATUS: StatusEffectDefinition = {
  id: "luckyArmor",
  name: "Lucky Draw — Guarded",
  category: "buff",
  stacking: "refresh",
  modifiers: [{ stat: "damageTaken", op: "mult", value: 0.9 }],
};

export const LUCKY_GOLD_STATUS: StatusEffectDefinition = {
  id: "luckyGold",
  name: "Lucky Draw — Flush",
  category: "buff",
  stacking: "refresh",
  modifiers: [{ stat: "income", op: "mult", value: 1.1 }],
};

/** How long a Lucky Draw buff lasts. */
export const LUCKY_DRAW_DURATION = 20 * TICK.RATE; // 20 s

/**
 * Lucky Draw always lands something — the gamble is WHICH of the five faces,
 * each equally likely at 20%.
 */
export const LUCKY_DRAW_CHANCE = 1;

/**
 * Lucky Draw (utility): pull the lever and take what comes. One of five faces
 * every time, each a 1-in-5 — a damage buff, a damage reduction, a gold boost,
 * a free 1000 shield, or 750 health back. Always worth casting; never worth
 * counting on for anything in particular.
 */
export const LUCKY_DRAW: AbilityDefinition = {
  id: "luckyDraw",
  name: "Lucky Draw",
  kind: "utility",
  cost: 308,
  unlockCost: 154,
  cooldownTicks: Math.round(51.05 * TICK.RATE), // 36.5 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "luckyDraw",
      target: "self",
      params: {
        durationTicks: Math.round(25.85 * TICK.RATE),
        luckyDraw: {
          chance: LUCKY_DRAW_CHANCE,
          outcomes: [
            { kind: "status", status: LUCKY_ATTACK_STATUS },
            { kind: "status", status: LUCKY_ARMOR_STATUS },
            { kind: "status", status: LUCKY_GOLD_STATUS },
            { kind: "shield", amount: 1000 },
            { kind: "heal", amount: 750 },
          ],
        },
      },
    },
  ],
  upgradePath: [
    // Lv2: the buff faces last longer (20 s -> 30 s); the odds are already
    // certain, so there is nothing to improve there.
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [
          {
            durationTicks: 395,
            luckyDraw: {
              chance: 1,
              outcomes: [
                { kind: "status", status: LUCKY_ATTACK_STATUS },
                { kind: "status", status: LUCKY_ARMOR_STATUS },
                { kind: "status", status: LUCKY_GOLD_STATUS },
                { kind: "shield", amount: 1000 },
                { kind: "heal", amount: 750 },
              ],
            },
          },
        ],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Roulette (heavy attack): wheel a EUROPEAN table — 37 pockets, one green zero
 * — in front of the victim and stop their gold production until they call a
 * colour. Every bet costs them something:
 *
 *  - red or black, called right → half damage;
 *  - red or black, called wrong → full damage;
 *  - green, called right (1 in 37) → a large heal instead;
 *  - green, called wrong → half again as much damage.
 *
 * The wheel and payouts live in `engine/roulette.ts`.
 */
export const ROULETTE: AbilityDefinition = {
  id: "roulette",
  name: "Roulette",
  kind: "attack",
  cost: 255,
  unlockCost: 128,
  cooldownTicks: Math.round(22.3 * TICK.RATE), // 30 s
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "roulette", target: "target", params: {} }],
  upgradePath: [
    { level: 1, cost: 400, changes: { costMultiplier: 0.9 } },
    {
      level: 2,
      cost: 550,
      changes: {
        cooldownTicks: Math.round(22 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Slot Machine (ultimate): a machine drops in front of every other kingdom and
 * their gold production stops until they pull the lever. The spin is mostly
 * bad — a no-match is the single likeliest result and hits hard — but the rare
 * jackpots are worth having, so the victim is stuck choosing between lost
 * income and whatever the reels decide. The payout table lives in
 * `engine/slotMachine.ts`.
 */
export const SLOT_MACHINE: AbilityDefinition = {
  id: "slotMachine",
  name: "Slot Machine",
  kind: "ultimate",
  cost: 903,
  unlockCost: 452,
  cooldownTicks: Math.round(55.8 * TICK.RATE), // 93 s
  targeting: { mode: "allEnemies" },
  effects: [{ type: "slotMachine", target: "target", params: {} }],
  upgradePath: [
    {
      level: 1,
      cost: 1200,
      changes: { costMultiplier: 0.9 },
    },
    {
      level: 2,
      cost: 1600,
      changes: {
        cooldownTicks: 1004,
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Joker kingdom's activatable ability set. */
export const JOKER_ABILITIES: AbilityDefinition[] = [
  ACE_OF_SPADES,
  BLACKJACK,
  ROULETTE,
  LUCKY_DRAW,
  SLOT_MACHINE,
];
