import { INSECTS, KITSUNE, MAGMA, TICK } from "./balance.js";
import { FROZEN_STATUS, FROZEN_DURATION, FROSTBITE_STATUS } from "./iceAbilities.js";
import { DARKENED_STATUS, DARKENED_DURATION } from "./darkAbilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * The seven elemental kingdoms. This is the canonical id list; full kingdom
 * definitions (abilities, theme, …) are data added under this folder as those
 * systems are implemented (see ARCHITECTURE.md).
 *
 * Kingdoms are NOT exclusive within a match: a match allows up to 8 players but
 * there are only 7 kingdoms, so multiple players may share one.
 */
export const KINGDOM_IDS = [
  "water",
  "fire",
  "air",
  "earth",
  "electricity",
  "ice",
  "nature",
  "time",
  "space",
  "love",
  // Placeholder kingdoms: fully wired and playable, kits/passives still to be
  // designed (see `<id>Abilities.ts` and `KINGDOM_PASSIVES` below).
  "joker",
  "light",
  "dark",
  "kitsune",
  "magma",
  "insects",
] as const;

export type KingdomId = (typeof KINGDOM_IDS)[number];

export function isKingdomId(value: unknown): value is KingdomId {
  return (
    typeof value === "string" &&
    (KINGDOM_IDS as readonly string[]).includes(value)
  );
}

/**
 * Generic, engine-applied kingdom passive primitives (ticket #81+). A kingdom's
 * always-on passives are pure data composed from these; the engine applies them
 * automatically with no kingdom-specific branches:
 *  - `productionPerCitizen`: income multiplied by (1 + pct × citizens).
 *  - `statusDurationReduction`: named statuses applied to this kingdom last
 *    (1 − pct) of their normal duration.
 *  - `elementalResistance`: damage of the named element takes (1 − pct).
 */
export type KingdomPassive = (
  | { type: "productionPerCitizen"; pct: number }
  /** Overrides the per-citizen income rate outright (per tick). Water: every
   *  citizen produces $1.35/s (0.0675/tick) vs the base $1.20/s. */
  | { type: "incomePerCitizen"; amount: number }
  | { type: "statusDurationReduction"; statusId: string; pct: number }
  | { type: "elementalResistance"; element: string; pct: number }
  /** Reduces damage taken from named damage-over-time sources by `pct`. Each
   *  `source` matches either a status id (its per-tick DoT damage, e.g. "burn",
   *  "poison", "fatherTimeMark") or an ability id (its direct damage, e.g.
   *  "meteorShower"). Water's "Fountain of Youth". */
  | { type: "dotResistance"; pct: number; sources: string[] }
  | { type: "startingCastleHpMultiplier"; pct: number }
  | { type: "damageMultiplier"; pct: number }
  | { type: "shieldDamageMultiplier"; pct: number }
  | { type: "critChanceModifier"; pct: number }
  | { type: "critDamageMultiplier"; pct: number }
  /** Attacks may be cast with multiple explicit targets (Air, Epic 8). */
  | { type: "multiTargetAttacks"; maxTargets: number }
  /** Incoming attacks have this chance to be redirected to another kingdom,
   *  the attacker included (Air, Epic 8). */
  | { type: "attackRedirectChance"; pct: number }
  /** Begin the game with this much shield (Earth, Epic 9). */
  | { type: "startingShield"; amount: number }
  /** Dealing ability damage regenerates the caster's shield by this fraction
   *  of the damage dealt (Earth's "Distraught", Epic 9). */
  | { type: "shieldOnDamageDealt"; pct: number }
  /** Attack cooldowns are reduced by this fraction (Electricity, Epic 10). */
  | { type: "attackCooldownReduction"; pct: number }
  /** Attacks have `chance` to deal `pct` of the hit as bonus damage after
   *  hitting (Electricity's "AfterShock", Epic 10). */
  | { type: "attackAftershock"; chance: number; pct: number }
  /** Attacks have `chance` to inflict `status` on the victim (Ice's
   *  "Cold Embrace", Epic 11). Honors Frozen Focus guarantees. */
  | { type: "onHitStatus"; chance: number; durationTicks: number; status: StatusEffectDefinition }
  /** Being attacked has `chance` to inflict `status` on the attacker (Ice's
   *  "Frostbite", Epic 11). */
  | { type: "retaliation"; chance: number; durationTicks: number; status: StatusEffectDefinition }
  /** Attackers have `chance` to receive `pct` of their damage reflected
   *  (Nature's "No Rose Without Thorns", Epic 12). */
  | { type: "thorns"; chance: number; pct: number }
  /** Begin the game with this many additional citizens (Nature's
   *  "Gardener's Gift", Epic 12). */
  | { type: "startingCitizensBonus"; amount: number }
  /** Outgoing attack damage grows by `pct` for every `intervalTicks` of match
   *  time elapsed (Time's "Longevity" — attack half). Unbounded. */
  | { type: "scalingDamageMultiplier"; pct: number; intervalTicks: number }
  /** Incoming damage is reduced by `pct` for every `intervalTicks` of match
   *  time elapsed (Time's "Longevity" — defense half). Floored at 0. */
  | { type: "scalingDamageReduction"; pct: number; intervalTicks: number }
  /** Buying a citizen has `chance` to grant `amount` extra citizen(s) for free
   *  without advancing the price ladder (Time's "Time is money"). */
  | { type: "bonusCitizenOnPurchase"; chance: number; amount: number }
  /** Begin the game with this much gold (Space's "Blast off!"). */
  | { type: "startingGold"; amount: number }
  /** Income is multiplied by (1 + pct × kingdoms currently targeting you) —
   *  economy scales with pressure (Space's "Vast Universe"). */
  | { type: "incomeMultiplierPerBesieger"; pct: number }
  /** Overrides the citizen price ladder's BASE cost (normally 25) — every hire
   *  is priced `amount × growth^purchased` instead, so ALL citizens are cheaper,
   *  not just the first (Love's "Warm Welcome": base 20). */
  | { type: "citizenBaseCost"; amount: number }
  /** Whenever ANY other kingdom heals for any reason, this kingdom also heals
   *  for `pct` of that amount (Love's "Feel the love!"). */
  | { type: "healShareGlobal"; pct: number }
  /** Casting any ability knocks `ticks` off the remaining cooldown of every
   *  OTHER ability (Light's "Speed of light"). The cast ability's own fresh
   *  cooldown is never shortened by its own cast. */
  | { type: "cooldownReductionOnCast"; ticks: number }
  /** Ability upgrade tiers cost `pct` less (Light's "Bright idea"). Unlock
   *  prices are unaffected — that is the perk's job. */
  | { type: "upgradeCostReduction"; pct: number }
  /** Every perk this player picked uses its BOOSTED magnitude instead of its
   *  base one (Dark's "Black Magic"). See `PERKS` in balance.ts. */
  | { type: "boostedPerks" }
  /** While this kingdom's castle has an ACTIVE SHIELD, incoming attacks have
   *  `pct` chance to miss entirely (Joker's "Why so serious?"). */
  | { type: "shieldedMissChance"; pct: number }
  /** A meter that charges on its own AND from damage dealt (Kitsune's "Swift
   *  Tails"). `perSecond` is flat; `perDamage` is a share of damage dealt. */
  | { type: "chargingMeter"; perSecond: number; perDamage: number; full: number }
  /** This kingdom picks `extra` more perks than everyone else (Kitsune's
   *  "Three tailed fox"). */
  | { type: "extraPerks"; extra: number }
  /** Damage-over-time this kingdom INFLICTS bypasses shields entirely
   *  (Magma's "Hotter fire"). */
  | { type: "dotIgnoresShields" }
  /** A chance that an incoming ATTACK is partly cocooned: that share of the
   *  damage never lands and is earned as gold instead (Insects' "Cocoon"). */
  | { type: "cocoon"; chance: number; goldPct: number }
  /** Regenerates castle HP once this kingdom has gone untouched for a while
   *  (Insects' "Fruit Fly"). */
  | { type: "idleRegen"; idleTicks: number; pctPerSecond: number }
  /** Extra damage against a kingdom that is currently targeting this one, and
   *  a periodic public mark over everyone who is (Magma's "Hot ash"). */
  | {
      type: "bonusDamageVsTargeters";
      pct: number;
      markIntervalTicks: number;
      markDurationTicks: number;
    }
) & { conditions?: any[] };

/**
 * Always-on passives per kingdom. Kingdoms are filled in as their epics land;
 * an empty list means "no engine-applied passives yet".
 *
 * Water (Epic 6, ticket #81):
 *  - "We're In This Together" — every citizen produces $1.35/s vs base $1.20/s.
 *  - "Fountain of Youth" — 40% reduced Burn duration; 15% less Fire damage.
 *
 * Air (Epic 8):
 *  - "Embrace of Winds" — attacks may target multiple kingdoms simultaneously.
 *  - "A Gust of Envy" — incoming attacks have a 5% chance to be redirected to
 *    another kingdom, including the attacker.
 *
 * Earth (Epic 9):
 *  - "Rock Hard Determination" — begin the game with a fully intact shield
 *    (Brick Wall-sized, 2500).
 *  - "Distraught" — whenever Earth damages an opponent, its shield slowly
 *    regenerates (10% of damage dealt returns as shield).
 *
 * Electricity (Epic 10):
 *  - "Don't Blink" — all attack cooldowns reduced by 30%.
 *  - "AfterShock" — attacks have a 25% chance to deal 50% of the hit as bonus
 *    damage after hitting.
 *
 * Ice (Epic 11):
 *  - "Cold Embrace" — Ice attacks have a 10% chance to Freeze opponents.
 *  - "Frostbite" — attackers have a 15% chance to have their production
 *    slowed by 50% for a short duration.
 *  - (weakness) Burn lasts 1.5× longer on Ice.
 *
 * Nature (Epic 12):
 *  - "No Rose Without Thorns" — attackers have a 20% chance to receive 25%
 *    of their damage reflected.
 *  - "Gardener's Gift" — begin the game with 15 citizens instead of 10.
 *
 * Joker (Epic 13):
 *  - "Beginners luck" — +5% crit chance, doubling the 5% base.
 *  - "Why so serious?" — incoming attacks have a 5% chance to miss while
 *    Joker is shielded.
 *
 * Light (Epic 13):
 *  - "Speed of light" — every cast takes 1s off all of Light's OTHER cooldowns.
 *  - "Bright idea" — ability upgrades cost 20% less.
 *
 * Dark (Epic 13):
 *  - "Night terrors" — attackers have a 20% chance to be blinded for 4s.
 *  - "Black Magic" — Dark's perks are boosted to their stronger tier.
 */
export const KINGDOM_PASSIVES: Record<KingdomId, KingdomPassive[]> = {
  water: [
    // "We're In This Together": every Water citizen produces $1.35/s
    // (0.0675/tick) — a flat per-citizen rate above the base $1.20/s.
    { type: "incomePerCitizen", amount: 0.0675 },
    // "Fountain of Youth": Burn wears off 40% faster, and damage over time from
    // Burn, Poison, Father Time, and Meteor Shower is reduced by 15%.
    { type: "statusDurationReduction", statusId: "burn", pct: 0.4 },
    { type: "dotResistance", pct: 0.15, sources: ["burn", "poison", "fatherTimeMark", "meteorShower"] },
    { type: "elementalResistance", element: "fire", pct: 0.15 },
  ],
  fire: [
    { type: "startingCastleHpMultiplier", pct: 0.9 },
    { type: "damageMultiplier", pct: 0.35 },
    { type: "shieldDamageMultiplier", pct: 0.45 },
  ],
  air: [
    // "Embrace of Winds": attacks may strike up to maxTargets kingdoms at once
    // (damage split evenly). Tunable via passive.air.0.maxTargets; design intent
    // is 3 base, 5 when upgraded (raise this value for the upgraded tier).
    { type: "multiTargetAttacks", maxTargets: 3 },
    { type: "attackRedirectChance", pct: 0.05 },
  ],
  earth: [
    { type: "startingShield", amount: 2000 },
    { type: "shieldOnDamageDealt", pct: 0.1 },
  ],
  electricity: [
    { type: "attackCooldownReduction", pct: 0.3 },
    { type: "attackAftershock", chance: 0.25, pct: 0.5 },
  ],
  ice: [
    { type: "statusDurationReduction", statusId: "burn", pct: -0.50 },
    { type: "onHitStatus", chance: 0.10, durationTicks: FROZEN_DURATION, status: FROZEN_STATUS },
    { type: "retaliation", chance: 0.15, durationTicks: 5 * TICK.RATE, status: FROSTBITE_STATUS },
  ],
  nature: [
    { type: "thorns", chance: 0.2, pct: 0.25 },
    { type: "startingCitizensBonus", amount: 5 },
  ],
  time: [
    // "Longevity" — Time gets stronger the longer the battle runs: +5% attack
    // every 2 minutes and +5% damage reduction every 3 minutes (unbounded
    // attack; reduction floored at 0). Applied live from match.tick.
    { type: "scalingDamageMultiplier", pct: 0.05, intervalTicks: 2 * 60 * TICK.RATE },
    { type: "scalingDamageReduction", pct: 0.05, intervalTicks: 3 * 60 * TICK.RATE },
    // "Time is money" — a 7.5% chance to receive a second citizen free
    // on each hire, without advancing the citizen price ladder.
    { type: "bonusCitizenOnPurchase", chance: 0.075, amount: 1 },
  ],
  space: [
    // "Blast off!" — start the match with 150 gold in the bank.
    { type: "startingGold", amount: 150 },
    // "Vast Universe" — a bully that profits from being ganged up on: +10%
    // income for every kingdom currently targeting Space.
    { type: "incomeMultiplierPerBesieger", pct: 0.1 },
  ],
  love: [
    // "Warm Welcome" — every citizen is cheaper: the price ladder starts at 20
    // instead of the base 25 and climbs by the same growth (20 → 22 → 24 → …).
    { type: "citizenBaseCost", amount: 20 },
    // "Feel the love!" — whenever any OTHER castle heals, for any reason, Love
    // receives 10% of that healing too.
    { type: "healShareGlobal", pct: 0.1 },
  ],
  // --- Placeholder kingdoms -------------------------------------------------
  // Their two passives each are named but not designed yet, so they declare no
  // primitives: an empty list is the honest "nothing applies" state, and the
  // engine already treats it that way for every passive helper. Swap in real
  // `KingdomPassive` entries here when the kit is written — the lobby's
  // descriptions live in `Client/src/game/kingdomInfo.ts` and should change
  // with them.
  joker: [
    // "Beginners luck" — every attack crits twice as often as normal: the
    // passive ADDS to the shared base chance (5% + 5% = 10%).
    { type: "critChanceModifier", pct: 0.05 },
    // "Why so serious?" — while Joker is wearing a shield, incoming attacks
    // have a 5% chance to whiff entirely.
    { type: "shieldedMissChance", pct: 0.05 },
  ],
  light: [
    // "Speed of light" — every cast shaves 1.5 s off the remaining cooldown of
    // each of Light's OTHER abilities.
    { type: "cooldownReductionOnCast", ticks: 1.5 * TICK.RATE },
    // "Bright idea" — ability upgrade tiers cost 20% less.
    { type: "upgradeCostReduction", pct: 0.2 },
  ],
  magma: [
    // "Hotter fire" — Magma's burn goes straight through a shield. Its own kit
    // is still placeholder, so nothing of Magma's inflicts a DoT yet; this is
    // wired against the generic tick pipeline and applies the day one does.
    { type: "dotIgnoresShields" },
    // "Hot ash" — pointing at Magma costs you: it hits back harder, and every
    // 45 s it publicly marks everyone currently aiming at it.
    {
      type: "bonusDamageVsTargeters",
      pct: MAGMA.HOT_ASH_DAMAGE_PCT,
      markIntervalTicks: MAGMA.HOT_ASH_INTERVAL_TICKS,
      markDurationTicks: MAGMA.HOT_ASH_MARK_TICKS,
    },
  ],
  insects: [
    // "Cocoon" — sometimes an incoming attack is partly caught by a cocoon:
    // that share never lands, and is earned as gold instead. Rolled per
    // ATTACK, not per damage tick.
    {
      type: "cocoon",
      chance: INSECTS.COCOON_CHANCE,
      goldPct: INSECTS.COCOON_GOLD_PCT,
    },
    // "Fruit Fly" — left alone long enough, Insects starts healing. A reward
    // for being nobody's problem, and a reason to swat it before it settles.
    {
      type: "idleRegen",
      idleTicks: INSECTS.FRUIT_FLY_IDLE_SECONDS * TICK.RATE,
      pctPerSecond: INSECTS.FRUIT_FLY_REGEN_PCT_PER_SECOND,
    },
  ],
  kitsune: [
    // "Swift Tails" — the Ancient Memory meter fills on its own, and faster
    // when Kitsune is actually fighting.
    {
      type: "chargingMeter",
      perSecond: KITSUNE.MEMORY_PER_SECOND,
      perDamage: KITSUNE.MEMORY_PER_DAMAGE,
      full: KITSUNE.MEMORY_FULL,
    },
    // "Three tailed fox" — one more perk than anyone else gets.
    { type: "extraPerks", extra: 1 },
  ],
  dark: [
    // "Night terrors" — attacking Dark risks a blackout: the attacker's own
    // screen goes dark for a few seconds.
    { type: "retaliation", chance: 0.2, durationTicks: DARKENED_DURATION, status: DARKENED_STATUS },
    // "Black Magic" — whichever two perks Dark picked run at their boosted
    // magnitudes (see `PERKS.*_BOOSTED`).
    { type: "boostedPerks" },
  ],
};
