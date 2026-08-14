import { KINGDOM_PASSIVES, type KingdomId } from "../data/kingdoms.js";
import type { PerkId } from "../data/perks.js";
import { perkShieldBonusHpFor, perkStartingGold } from "../engine/perks.js";
import type { MatchConfig } from "./matchConfig.js";
import type { EffectCondition } from "../engine/conditions.js";
import type { StatusEffectDefinition } from "../engine/status.js";

// The runtime per-player gameplay object (tickets #42, #43; see DATA_MODELS.md →
// Player). Created when a match starts. Collections whose element shapes are
// owned by later tickets (status effects, combos) are typed loosely for now and
// filled in as those systems land.

export interface CastleState {
  /** Castle health. */
  hp: number;
  maxHp: number;
  /** Shield health absorbed before HP; starts at 0. */
  shield: number;
  /** Number of repairs purchased (drives progressive repair cost). */
  repairs: number;
  /** Number of shields purchased this match (drives progressive shield cost). */
  shieldsPurchased: number;
  /** Tick a shield was last broken by damage; a new shield can't be bought for
   *  `SHIELD.BREAK_COOLDOWN_TICKS` after. Very negative = never broken. */
  shieldBrokenAtTick: number;
}

export interface EconomyState {
  /** Population; drives income. */
  citizens: number;
  /** Spendable money. */
  currency: number;
  /** Derived from citizens by the economy system; 0 until it runs. */
  incomePerTick: number;
  /** How many citizens the player has purchased (drives progressive cost). */
  citizensPurchased: number;
}

export type ModifierOp = "add" | "mult";

/**
 * A temporary bonus/penalty to a named player statistic (ticket #48). Effective
 * stat = (base + sum of `add`) × product of `mult`.
 */
export interface Modifier {
  /** Unique instance id (for removal). */
  id: string;
  /** The statistic this affects (e.g. "income", "damage"). */
  stat: string;
  op: ModifierOp;
  value: number;
  sourceId: string;
  /** Remaining ticks; null = lasts until explicitly removed. */
  remainingTicks: number | null;
  /** Conditional modifiers (ticket #101). */
  conditions?: EffectCondition[];
  /** Usage limit (ticket #103). */
  usageLimit?: number;
  /** String value for targeting redirection, etc. (ticket #109) */
  stringValue?: string;
}

/**
 * A recurring per-tick effect carried by a status (ticket #78) — e.g. burn
 * damage or a regeneration heal, optionally scaling with stack count.
 */
export interface StatusTickEffect {
  type: "damage" | "heal" | "applyStatus";
  /** Magnitude per tick (per stack when `perStack` is set). */
  amount: number;
  /** Multiply by the status's current stacks (poison-style ramping). */
  perStack?: boolean;
  /** damage: bypass the target's shield pool. */
  ignoreShields?: boolean;
  /** Probability check (ticket #102). */
  chance?: number;
  /**
   * Fire only every N game ticks instead of every tick (default 1). e.g. a
   * once-per-second effect uses `TICK.RATE` (Time's Father Time).
   */
  intervalTicks?: number;
  /**
   * Apply only if the BEARER has not dealt damage since this effect last
   * evaluated — otherwise the tick is skipped and its countdown resets (Father
   * Time's "punish hesitation": the victim avoids the hit by attacking).
   */
  onlyIfBearerIdleSinceLastTick?: boolean;
  /**
   * Ramp the magnitude up the longer the status has been active: multiplied by
   * `1 + rampPerSecond × secondsActive` (Nature's Poison worsens over time,
   * separating it from Fire's flat Burn). Capped by `rampMaxMultiplier`.
   */
  rampPerSecond?: number;
  /** Ceiling for the `rampPerSecond` multiplier (default: uncapped). */
  rampMaxMultiplier?: number;
  /**
   * Once the status passes the halfway point of its duration, use this
   * magnitude instead of `amount` (Father Time hits harder in the back half).
   */
  amountAfterHalfLife?: number;
  /**
   * `applyStatus` only: the status laid on the bearer when this effect fires,
   * credited to whoever applied the CARRIER (Fire's Ignited rolling a Burn
   * every fifteen seconds). Combine with `intervalTicks` for the cadence and
   * `chance` for the odds — a status that periodically seeds another status.
   */
  applies?: { status: StatusEffectDefinition; durationTicks: number };
}

/**
 * An active status effect on a player. Duration, stacking, source tracking,
 * and its snapshot of recurring tick effects (#76, #78).
 */
export interface StatusEffectInstance {
  /** Status definition id (e.g. "burn", "freeze"). */
  id: string;
  /** Player who applied it. */
  sourceId: string;
  /** Remaining ticks before it expires. */
  remainingTicks: number;
  /** Current stack count. */
  stacks: number;
  /** Recurring per-tick effects, snapshotted from the definition on apply. */
  tickEffects?: StatusTickEffect[];
  /** Game ticks elapsed since apply, for `intervalTicks` cadence (interval
   *  tick effects only). */
  tickElapsed?: number;
  /** The duration (ticks) this status was applied with, for elapsed-fraction
   *  logic like ramping DoTs and half-life damage steps. */
  initialDurationTicks?: number;
  /** Tick at which an idle-gated interval effect last evaluated, so "dealt
   *  damage since last tick" is measured over the right window. */
  lastIdleEvalTick?: number;
  /** Whether the status has associated modifiers. */
  hasModifiers?: boolean;
  /** Ends when the bearer buys a shield (Kitsune's "Old Friends"). */
  endsOnShieldPurchase?: boolean;
  /** A burn — amplified by Magma's "Floor is Lava" whoever inflicted it. */
  isBurn?: boolean;
  /** Per-tick damage used instead while the bearer has a shield up. */
  shieldedTickAmount?: number;
  /** Ancient Memory credited to `sourceId` each tick this is active. */
  chargesSourceMemoryPerTick?: number;
  /** Multiplier applied to this status's tick damage each time the BEARER
   *  attacks (Kitsune's "Fox Fire"). */
  intensifiesOnBearerAttack?: number;
  /** How hot it currently burns — 1× on apply, climbing with `intensify`. */
  intensity?: number;
  /** The attack-journal record (id) of the activation that applied this status,
   *  so its DoT/status damage attributes back to that attack for Blip's undo. */
  journalId?: string;
  /**
   * While active, the bearer cannot *target* the player who applied this
   * status (`sourceId`) — other targets remain legal (tickets #87–#88,
   * e.g. Water's Flood). Snapshotted from the definition on apply.
   */
  blocksTargetingSource?: boolean;
  /**
   * While active, the bearer's next attack on the player who applied this
   * status (`sourceId`) is deflected to another valid kingdom (Air's
   * Hurricane, Epic 8). Consumed on use. Snapshotted on apply.
   */
  deflectsAttackOnSource?: { damageMult?: number; chainChance?: number };
  /** Whether a `chainChance` roll has already granted the one extra deflection. */
  deflectionChained?: boolean;
  /** While active, the bearer cannot activate attack-kind abilities
   *  (Ice's Frozen/Blizzard, Epic 11). Snapshotted on apply. */
  blocksAttacks?: boolean;
  /** Chance-gated effects of the bearer's attacks always proc; one stack is
   *  consumed per attack (Ice's Frozen Focus, Epic 11). */
  guaranteesChanceEffects?: boolean;
  /** Applied to the bearer when this expires naturally (Epic 11). */
  onExpireStatus?: { status: StatusEffectDefinition; durationTicks: number };
  /** While active, the bearer cannot buy citizens or repair (Epic 12,
   *  Nature's Toxic Gas). */
  blocksPurchases?: boolean;
  /**
   * Gold the bearer must pay to shake this status off early (Light's
   * Fireflies). Snapshotted on apply from the definition's
   * `dispelCostPerCitizen` × their citizen count; Illumination can inflate it
   * afterwards. Absent = the status cannot be bought off.
   */
  dispelCost?: number;
  /** While active, the BEARER cannot buy a shield (Light's Fireflies). */
  blocksBearerShield?: boolean;
  /** While active, these card ranks are missing from the bearer's Blackjack
   *  deck (Joker's Ace of Spades). Snapshotted on apply. */
  strippedCardRanks?: readonly number[];
  /** While active, the bearer may only cast their kingdom's basic attack
   *  (Dark's Never-ending nightmare). Snapshotted on apply. */
  basicAttacksOnly?: boolean;
  /** Attacks the `basicAttacksOnly` lock still has left; it lifts at 0. */
  basicAttacksRemaining?: number;
  /** While active, the bearer's attacks may name up to this many enemies
   *  (Dark's Infinitum tenebrae). Snapshotted on apply. */
  grantsMultiTarget?: number;
  /** With that grant, damage is NOT split across the kingdoms struck. */
  noDamageSpread?: boolean;
  /** While active, every attack the bearer lands also inflicts this status on
   *  the victim (Infinitum tenebrae). Snapshotted on apply. */
  attackInflicts?: { status: StatusEffectDefinition; durationTicks: number };
  /**
   * Dark's Yin and Yang wager. `wagerMode` is the behaviour the CASTER bet on
   * and is punishing: "yin" punishes buying a citizen, "yang" punishes failing
   * to. The wager settles the moment the bearer buys (during the window) or
   * when it expires unbought — costing `wagerAmount` if they guessed wrong and
   * `wagerHalfAmount` if they guessed right. There is no clean escape.
   */
  wagerMode?: "yin" | "yang";
  wagerAmount?: number;
  wagerHalfAmount?: number;
  /** Applied to the next player who damages the bearer, then consumed
   *  (Epic 12, Nature's Poison Apple). */
  onHitRetaliate?: { status: StatusEffectDefinition; durationTicks: number };
  /** Extra statuses applied to the biter with `onHitRetaliate` (Poison Apple
   *  also poisons the biter's citizens). Snapshotted on apply. */
  onHitRetaliateExtra?: { status: StatusEffectDefinition; durationTicks: number }[];
  /** While active, the bearer loses income each tick instead of earning it
   *  (Time's "Back to the Future"). Snapshotted on apply. */
  drainsIncome?: boolean;
  /** While active, the bearer cannot change target (Space's Supernova L2/L3
   *  forced redirect). Snapshotted on apply. */
  blocksTargetChange?: boolean;
  /** The target to restore when a `blocksTargetChange` lock expires — the
   *  bearer's selection before Supernova forced them onto the victim. `null`
   *  means they had no target; `undefined` means no restore applies. */
  restoreTargetId?: string | null;
  /** While active, each incoming attack on the bearer has this chance (0–1) to
   *  miss entirely (Space's Orion's Belt). Snapshotted on apply. */
  incomingMissChance?: number;
  /** The bearer's own attacks miss this often (Butterflies). Snapshotted. */
  attackMissChance?: number;
  /** Clicks landed on each crawling bug so far (Insects' "Creepy Crawlers").
   *  One entry per bug; a bug is dead once it reaches `hitsToKill`. */
  bugHits?: number[];
  /** Clicks needed to squash one bug. Snapshotted. */
  hitsToKill?: number;
  /** Gold each LIVING bug drains per second. Snapshotted. */
  drainPerSecond?: number;
  /** A missed attack by the bearer lands on them instead (Infected).
   *  Snapshotted. */
  deflectsMissedAttack?: boolean;
  /** Points added to the bearer's Supernova meter when an incoming attack misses
   *  via `incomingMissChance` (Orion's Belt feeds the meter). Snapshotted. */
  missChargesSupernova?: number;
  /** While active, whenever the status's SOURCE (applier) takes damage, the
   *  bearer also takes this fraction of it (Love's Cupid's Arrow — an
   *  "infatuated" kingdom feels a share of what Love feels). Snapshotted. */
  bearerTakesPctOfSourceDamage?: number;
  /** While active, ANY damage the bearer takes is fully negated and converted
   *  into healing for this fraction of the raw incoming amount (Love's "Love
   *  Galore"). Snapshotted. */
  negateDamageHealPct?: number;
  /** While active, damage the bearer takes is reflected back at the attacker
   *  at this fraction, unconditionally — no chance roll (Love's "Have some
   *  Empathy!"). Snapshotted. */
  thornsPct?: number;
  /** A two-phase hidden status that reveals on stealth-window expiry or after
   *  `revealHealThreshold` healing (Love's "Love Galore"). Snapshotted. */
  revealsBeforeExpiry?: boolean;
  /** Whether this status has revealed yet (runtime; false during stealth). */
  revealed?: boolean;
  /** Cumulative negated-damage healing so far, for the early-reveal threshold
   *  (runtime). */
  healAccumulated?: number;
  /** Healing that triggers an early reveal; set on the instance when applied
   *  (scales with the ability's upgrade tier). */
  revealHealThreshold?: number;
  /**
   * The OTHER castle this status links the bearer to (Love's "BFFS!!!"):
   * damage and statuses landing on either from any source mirror onto the
   * other in full for the link's duration. Set on the instance when applied
   * (not a definition field — both ends of a link get the same definition
   * but a different partner id).
   */
  linkedPartnerId?: string;
  /**
   * Citizens borrowed from the bearer by this status's source, to be returned
   * when it expires naturally (Love's Cupid's Arrow — "infatuated" kingdoms
   * temporarily lend Love citizens). Set on the instance when applied.
   */
  citizenLoanAmount?: number;
}

/**
 * One incoming attack (a single enemy activation) that successfully affected a
 * player — the unit Time's Blip! reverses. Immediate damage and any attributed
 * DoT/status damage accumulate into the refunds; the applied statuses are listed
 * so the undo can strip them. Kept as a small bounded, most-recent-last list.
 */
export interface AttackRecord {
  /** Unique id of the attacking activation (matches statuses' `journalId`). */
  id: string;
  sourceId: string;
  abilityId: string;
  /** Tick the attack landed (ordering / most-recent). */
  tick: number;
  /** Castle HP taken by this attack + its DoTs — healed back on undo. */
  hpRefund: number;
  /** Shield HP taken by this attack + its DoTs — restored on undo. */
  shieldRefund: number;
  /** Ids of statuses this attack applied (removed on undo if still from it). */
  statusIds: string[];
}

export interface PlayerState {
  id: string;
  name: string;
  kingdomId: KingdomId;
  /**
   * The two perks chosen in the lobby — flat, always-on bonuses that stack with
   * this kingdom's passives and abilities rather than replacing them. Read by
   * `engine/perks.ts`; fixed for the whole match.
   */
  perks: PerkId[];
  castle: CastleState;
  economy: EconomyState;
  /** Active status effects. */
  statuses: StatusEffectInstance[];
  /** Active stat modifiers (buffs/debuffs). */
  modifiers: Modifier[];
  /** Active combo states (ComboState[] later). */
  combos: unknown[];
  /** Ability cooldowns remaining (ticks), keyed by ability id. */
  cooldowns: Record<string, number>;
  /**
   * Charge regeneration timers per charge-based ability (Lightning Barrage):
   * one countdown (ticks) per spent charge, each regenerating independently.
   * Available charges = the ability's max − this list's length.
   */
  recharges: Record<string, number[]>;
  /** Purchased upgrade level per ability id. */
  upgrades: Record<string, number>;
  /**
   * Abilities the player has bought (unlock cost = 50% of cast cost). A bought
   * ability is "level 1" in UI terms; `upgrades` then counts tiers past that.
   */
  unlocked: Record<string, boolean>;
  /** Currently selected target (player id), or null. */
  target: string | null;
  /**
   * The earliest tick at which this player may switch to a *different* target
   * (anti-spam cooldown, ticket #61). 0 = may switch immediately. Clients derive
   * remaining time from `(this − currentTick)` per the SOCKET_EVENTS time rule.
   */
  targetSwitchReadyTick: number;
  eliminated: boolean;
  /**
   * Tick at which this kingdom was eliminated and cleaned up, or null while
   * alive (tickets #69–#70). Preserved for end-of-match statistics; also marks
   * whether the elimination process has run (death detection processes each
   * dead castle exactly once).
   */
  eliminatedAtTick: number | null;
  /**
   * Tick at which this player last dealt damage with an active attack (−1 =
   * never). Drives idle-gated effects like Father Time's Mark, which punishes
   * every second the bearer fails to land a damaging attack.
   */
  lastDamageDealtTick: number;
  /**
   * Tick of the last damage this kingdom TOOK, from any source. -1 until
   * something lands. Read by Insects' "Fruit Fly", which only heals once this
   * is far enough behind the current tick.
   */
  lastDamageTakenTick: number;
  /**
   * Fractional healing carried between ticks (Insects' "Fruit Fly"). A slow
   * per-tick figure would round to zero every tick and the passive would do
   * nothing at all, so the remainder is banked until it makes a whole point.
   */
  regenCarry: number;
  /**
   * Recent incoming attacks that affected this player (most recent last),
   * bounded. Time's Blip! pops the last one and reverses it.
   */
  attackJournal: AttackRecord[];
  /**
   * Space's Supernova charge meter (points). Shooting Star, Saturn's Rings, and
   * Orion's Belt misses fill it; Supernova fires at the level the meter maps to
   * and empties it. 0 for non-Space kingdoms.
   */
  supernovaMeter: number;
  /**
   * Dark's Unlimited Rage charge, in damage absorbed. Every hit this player
   * takes adds its own size, so the meter is a running total of punishment
   * received; Unlimited Rage cannot be cast below `DARK.RAGE_FULL` and empties
   * it on use. Tracked for every kingdom (it costs one addition per hit) but
   * only ever read by Dark.
   */
  rageMeter: number;
  /**
   * Kitsune's "Ancient Memory" ("Swift Tails"): charges on its own every tick
   * and faster from damage dealt. Tracked for everyone, read only by Kitsune —
   * the same arrangement as `rageMeter`.
   */
  ancientMemory: number;
  /**
   * Joker's Slot Machine: this player has been handed a machine and owes a
   * spin. Their gold production is frozen until they pull the lever — there is
   * no way to decline, only to stall. Null when nothing is owed.
   */
  pendingSpin: { sourceId: string; abilityId: string; atTick: number } | null;
  /**
   * Joker's Roulette: a wheel is in front of this player and they owe a bet.
   * Same deal as the slot machine — gold production is frozen until they call
   * a colour. `atTick` orders the two, so whichever arrived first is the one
   * the client puts on screen and the other waits its turn.
   */
  pendingBet: { sourceId: string; abilityId: string; atTick: number } | null;
  /** The most recent wheel, held back until `revealTick` like `lastSpin`. */
  lastBet: {
    pocket: number;
    color: string;
    bet: string;
    /** The verdict as told to the bettor ("you missed, 750 damage"). */
    outcome: string;
    /** The same verdict as told about them, for every other screen. */
    publicOutcome: string;
    revealTick: number;
  } | null;
  /**
   * The most recent spin's reels and verdict. `revealTick` is when the result
   * becomes public: the effect already applied server-side, but every screen
   * (the spinner's reels and Joker's overhead readout) holds until then so the
   * reveal lands at the same moment for everyone.
   */
  lastSpin: {
    symbols: readonly string[];
    outcome: string;
    revealTick: number;
  } | null;
}

/**
 * Builds a player's initial gameplay state from their selected kingdom and the
 * shared game constants captured in the match config (ticket #43). Kingdom-
 * specific starting-stat overrides can be layered here once kingdom definitions
 * exist; for now every kingdom uses the shared starting values.
 */
export function createPlayerState(
  input: { id: string; name: string; kingdomId: KingdomId; perks?: PerkId[] },
  config: MatchConfig,
): PlayerState {
  const perks = input.perks ?? [];
  const passives = KINGDOM_PASSIVES[input.kingdomId] ?? [];
  // Dark's "Black Magic" runs every perk at its boosted magnitude, including
  // the two that pay out at match start.
  const boostedPerks = passives.some((p) => p.type === "boostedPerks");
  let startingHp = config.startingCastleHp;
  let startingShield = 0;
  let startingCitizens = config.startingCitizens;
  // Perks stack with kingdom passives: Space's "Blast off!" gold is added below
  // on TOP of Deep Pockets, not instead of it.
  let startingGold = perkStartingGold(perks, boostedPerks);
  for (const p of passives) {
    if (p.type === "startingCastleHpMultiplier") {
      startingHp = Math.round(startingHp * p.pct);
    }
    // Earth's "Rock Hard Determination" (Epic 9): start fully shielded.
    if (p.type === "startingShield") {
      startingShield += p.amount;
    }
    // Nature's "Gardener's Gift" (Epic 12): start with extra citizens.
    if (p.type === "startingCitizensBonus") {
      startingCitizens += p.amount;
    }
    // Space's "Blast off!": start with gold in the bank.
    if (p.type === "startingGold") {
      startingGold += p.amount;
    }
  }

  // "Better Construction" reinforces every shield the player gains, including
  // one they open the match wearing (Earth's "Rock Hard Determination"). A
  // kingdom that starts bare gets nothing here — the perk pays out on the
  // shields they buy instead (see `buyShield`).
  if (startingShield > 0) {
    startingShield += perkShieldBonusHpFor(perks, boostedPerks);
  }

  return {
    id: input.id,
    name: input.name,
    kingdomId: input.kingdomId,
    perks,
    castle: {
      hp: startingHp,
      maxHp: startingHp,
      shield: startingShield,
      repairs: 0,
      shieldsPurchased: 0,
      shieldBrokenAtTick: -100000, // "never" — well before any real match tick
    },
    economy: {
      citizens: startingCitizens,
      currency: startingGold,
      incomePerTick: 0,
      citizensPurchased: 0,
    },
    statuses: [],
    modifiers: [],
    combos: [],
    cooldowns: {},
    recharges: {},
    upgrades: {},
    unlocked: {},
    target: null,
    targetSwitchReadyTick: 0,
    eliminated: false,
    eliminatedAtTick: null,
    lastDamageDealtTick: -1,
    lastDamageTakenTick: -1,
    regenCarry: 0,
    attackJournal: [],
    supernovaMeter: 0,
    rageMeter: 0,
    ancientMemory: 0,
    pendingSpin: null,
    lastSpin: null,
    pendingBet: null,
    lastBet: null,
  };
}
