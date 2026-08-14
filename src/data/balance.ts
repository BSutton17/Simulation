/**
 * Centralized game-balance constants for Kingdoms.
 *
 * This is the single source of truth for tunable gameplay values (see
 * ARCHITECTURE.md — data declares *what*, systems declare *how*). Nothing here
 * contains logic; systems import these values rather than hardcoding them, so
 * rebalancing is a data-only change. Values are snapshotted into a match's
 * config at start (see DATA_MODELS.md → MatchConfig) so live edits never disturb
 * an in-progress match.
 *
 * NOTE: magnitudes below are initial defaults and are expected to be tuned by
 * later balance tickets.
 */

/** Castle defaults. */
export const CASTLE = {
  /** Starting Castle HP for every player. */
  STARTING_HP: 10_000,
  /** Maximum HP restored by a single repair action. */
  REPAIR_AMOUNT: 1000,
  /** Flat base cost of a repair (before growth scaling). */
  REPAIR_COST: 500,
  /**
   * Multiplicative cost growth per repair already purchased, so repeated
   * repairs get progressively more expensive (500 → 625 → 781).
   */
  REPAIR_COST_GROWTH: 1.25,
  /**
   * Hard cap on purchased repairs per match. Ability-based healing (Riptide,
   * lifesteal, …) is NOT limited — only the shop's repair button.
   */
  MAX_REPAIRS: 4,
} as const;

/** Citizen / economy defaults. */
export const CITIZENS = {
  /** Number of citizens each player begins a match with. */
  STARTING_COUNT: 10,
} as const;

/** Economy tuning. */
export const ECONOMY = {
  /** Money awarded per citizen, per tick (0.05 per tick = 1.00 per second at 20 ticks/sec). */
  INCOME_PER_CITIZEN: 0.06,
  /** Base cost of the first purchased citizen. */
  CITIZEN_COST: 25,
  /**
   * Multiplicative cost growth per citizen already purchased, so each purchase
   * costs more (progressive scaling): cost = CITIZEN_COST × GROWTH^purchased,
   * rounded to whole dollars.
   */
  CITIZEN_COST_GROWTH: 1.10,
} as const;

/** Combat defaults shared by all abilities unless overridden by ability data. */
export const COMBAT = {
  /** Base chance (0–1) for an attack to critically strike. */
  BASE_CRIT_CHANCE: 0.05,
  /** Damage multiplier applied on a critical strike. */
  BASE_CRIT_MULTIPLIER: 1.5,
  /**
   * "Besieged" comeback bonus: when several kingdoms gang up on you, your own
   * attacks hit harder. Each enemy *beyond the first* currently targeting you
   * grants this fraction of extra outgoing attack damage — so a fair 1v1 is
   * unbuffed, but being triple-teamed pays you back for the pressure.
   */
  /**
   * Extra damage per attacker beyond the first. Deliberately steep: at the cap
   * a kingdom the whole field has turned on hits for well over double, which is
   * what makes ganging up genuinely dangerous rather than simply efficient.
   */
  BESIEGED_DAMAGE_PER_ATTACKER: 0.4,
  /** Cap on besieging attackers that count toward the bonus (beyond the first). */
  BESIEGED_MAX_STACKS: 6,
  /**
   * Besieged also rallies your economy: each besieging attacker beyond the
   * first grants this many extra gold PER SECOND (your citizens work harder to
   * fund the defense). Uses the same capped stack count as the damage bonus.
   */
  BESIEGED_INCOME_PER_ATTACKER: 2,
  /**
   * "Besieged" income MULTIPLIER: each attacker beyond the first raises your
   * gold production by this fraction. Unlike the flat top-up above this scales
   * with the economy you have actually built, so it stays meaningful late.
   *
   * This is the game's comeback mechanic: the kingdom everyone has decided to
   * kill earns faster while they do it, so being focused is survivable rather
   * than simply terminal.
   */
  BESIEGED_INCOME_PCT_PER_ATTACKER: 0.5,
  /**
   * The same, doubled, for the kingdom whose passive is profiting from being
   * ganged up on (Space's "Vast Universe"). It stacks with that passive's own
   * multiplier on purpose — being everyone's target IS Space's economy.
   */
  BESIEGED_INCOME_PCT_PER_ATTACKER_BOOSTED: 1,
} as const;

/**
 * Perk magnitudes. Every player picks `PERKS.PER_PLAYER` perks in the lobby;
 * each is a pure data point the engine multiplies/adds in at one place, and
 * they stack with kingdom passives and abilities rather than replacing them
 * (see `data/perks.ts` for the catalogue and `engine/perks.ts` for wiring).
 */
export const PERKS = {
  /** Perks each player must select before they can ready up. */
  PER_PLAYER: 2,
  /** "Sharper Swords": outgoing ability damage. */
  ATTACK_PCT: 0.1,
  /** "Sharper Axes": extra outgoing damage against a shielded castle. */
  SHIELD_ATTACK_PCT: 0.15,
  /** "Extra Guards": all incoming damage. */
  DAMAGE_REDUCTION_PCT: 0.1,
  /** "Extra Medics": incoming damage-over-time (status tick) damage. */
  DOT_REDUCTION_PCT: 0.15,
  /** "Extra Repairs": every ability cooldown. */
  COOLDOWN_REDUCTION_PCT: 0.1,
  /** "Deep Pockets": gold in the bank at match start. */
  STARTING_GOLD: 150,
  /** "Great Merchants": discount on ability unlock prices. */
  UNLOCK_DISCOUNT_PCT: 0.15,
  /** "Better Construction": extra health on every shield gained. */
  SHIELD_BONUS_HP: 500,

  // --- Boosted magnitudes (Dark's "Black Magic") ---------------------------
  // Dark runs every perk it picked at these values instead of the base ones
  // above. Each `*_BOOSTED` entry MUST stay paired with its base entry; the
  // perk engine picks between the two and nothing else reads them.
  ATTACK_PCT_BOOSTED: 0.15,
  SHIELD_ATTACK_PCT_BOOSTED: 0.2,
  DAMAGE_REDUCTION_PCT_BOOSTED: 0.15,
  DOT_REDUCTION_PCT_BOOSTED: 0.2,
  COOLDOWN_REDUCTION_PCT_BOOSTED: 0.15,
  STARTING_GOLD_BOOSTED: 200,
  UNLOCK_DISCOUNT_PCT_BOOSTED: 0.2,
  SHIELD_BONUS_HP_BOOSTED: 750,
} as const;

/** Lobby / room defaults. */
export const LOBBY = {
  /** Number of characters in a generated room code. */
  ROOM_CODE_LENGTH: 4,
} as const;

/** Match / player-count rules. */
export const MATCH = {
  /** Minimum players required to start a match. */
  MIN_PLAYERS: 2,
  /** Maximum total seats in a room (players + spectators). */
  MAX_PLAYERS: 8,
  /** Maximum kingdom-playing participants; the remaining seat(s) up to
   *  MAX_PLAYERS may only join as spectators. */
  MAX_ACTIVE_PLAYERS: 7,
} as const;

/** Game-loop timing. */
export const TICK = {
  /** Server ticks per second (see GAME_TICK.md). */
  RATE: 20,
  /** Broadcast a game-state sync every N ticks (20/2 = ~10 Hz). */
  SYNC_EVERY_TICKS: 2,
} as const;

/** Shield defaults. */
export const SHIELD = {
  /** Health of the standard purchasable shield. */
  STANDARD_HP: 1750,
  /** Cost of the first shield (matches the client's shop display). */
  COST: 400,
  /**
   * Multiplier applied per shield already bought this match, so each shield
   * costs a little more than the last (400 → 420 → 441 → …). Only one shield
   * can be active at a time, so this scales with cumulative purchases.
   */
  COST_GROWTH: 1.05,
  /**
   * After a shield is broken by damage, this many ticks must pass before a new
   * one can be bought (7.5 s) — you can't instantly re-wall mid-assault.
   */
  BREAK_COOLDOWN_TICKS: 7.5 * 20,
} as const;

/** Space kingdom — the Supernova charge meter (Shooting Star / Saturn's Rings /
 *  Orion's Belt misses fill it; Supernova fires at the current level). */
export const SPACE = {
  /**
   * Cumulative meter "xp" required to reach Supernova levels 1, 2, and 3. The
   * cost per level ramps: 50 to reach L1, +100 for L2 (150 total), +200 for L3
   * (250 total). The last entry doubles as the full-charge cap.
   */
  SUPERNOVA_LEVEL_THRESHOLDS: [50, 150, 250],
} as const;

/** Dark kingdom — the Unlimited Rage meter. */
export const DARK = {
  /**
   * Total damage Dark must absorb for Unlimited Rage to reach full charge.
   * The meter fills by exactly the damage taken, so a big hit is worth
   * proportionally more than a poke — but the total is all that matters.
   *
   * Lowered from 2000 so the meter fills roughly a third sooner; Unlimited
   * Rage's payload is deliberately unchanged at 1500, so this makes the
   * ability reachable more often rather than stronger when it lands.
   */
  RAGE_FULL: 1250,
} as const;

/** Kitsune kingdom — the "Ancient Memory" meter ("Swift Tails"). */
export const KITSUNE = {
  /**
   * A full Ancient Memory meter — what Kitsune Rush costs. Never shown as a
   * number: the HUD renders progress toward it, because "how full" is the only
   * part a player needs.
   */
  MEMORY_FULL: 6000,
  /**
   * Filled passively, per second, whatever Kitsune is doing. Set so a Kitsune
   * that does NOTHING at all still reaches a full meter in exactly three
   * minutes — that is the floor the ultimate is paced against, and everything
   * else (attacks, Old Friends, Azure Guidance) only brings it forward.
   */
  MEMORY_PER_SECOND: 6000 / 180,
  /** Plus this share of every point of damage Kitsune deals: acting fills it
   *  several times faster than waiting, without waiting ever being useless. */
  MEMORY_PER_DAMAGE: 0.15,
  /** Azure Guidance: how much faster Memory accrues while it holds. */
  AZURE_GUIDANCE_MULTIPLIER: 2,
  /** How long Azure Guidance lasts. */
  AZURE_GUIDANCE_DURATION_SECONDS: 12,
  /** Kitsune Rush: cooldowns run at this rate (0.5 = twice as fast). */
  RUSH_COOLDOWN_RATE: 0.5,
  /** Kitsune Rush: gold production multiplier. */
  RUSH_INCOME_MULTIPLIER: 2,
  /** How long Kitsune Rush lasts. */
  RUSH_DURATION_SECONDS: 15,
} as const;

/** Magma kingdom — "Hot ash". */
/**
 * Fire's "Ignited" (Scorching Sun). Not a burn — a long-lived mark that keeps
 * ROLLING for one. The victim is never sure whether the next quarter-minute
 * costs them anything, which is what makes covering for it a real decision.
 */
export const FIRE = {
  /** How long the mark lasts. */
  IGNITED_SECONDS: 60,
  /** How often it rolls for a burn. */
  IGNITED_ROLL_SECONDS: 15,
  /** Odds of each roll catching. */
  IGNITED_BURN_CHANCE: 0.25,
  /** How long a burn it lights lasts. */
  IGNITED_BURN_SECONDS: 5,
} as const;

/**
 * Insects. Both passives reward not being the kingdom everyone is hitting:
 * one turns a share of what does land into income, the other pays out for
 * being left alone.
 */
export const INSECTS = {
  /** "Cocoon": odds that an incoming ATTACK is partly cocooned. Rolled once
   *  per attack, never per damage-over-time tick — a 5% roll twenty times a
   *  second would fire constantly and mean nothing. */
  COCOON_CHANCE: 0.05,
  /** How much of a cocooned hit becomes gold instead of damage. */
  COCOON_GOLD_PCT: 0.1,
  /** "Fruit Fly": how long Insects must go untouched before it starts to heal.
   *  Long enough that it is a reward for being ignored rather than something
   *  that ticks between the beats of a fight. */
  FRUIT_FLY_IDLE_SECONDS: 15,
  /** Regeneration once idle, as a fraction of MAX castle HP per second. A
   *  percentage rather than a flat figure so it scales with whatever a castle
   *  is worth. */
  FRUIT_FLY_REGEN_PCT_PER_SECOND: 0.002,

  /** "Venom Shot": odds the basic attack leaves poison behind. */
  VENOM_CHANCE: 0.35,
  /** Venom's damage per tick, per stack. */
  VENOM_TICK: 6,
  /** How long venom lasts. */
  VENOM_SECONDS: 6,

  /** "Butterflies": how much of the target's damage reduction it strips, as a
   *  multiplier on the damage they take. */
  BUTTERFLIES_DAMAGE_TAKEN: 1.1,
  /** …and the chance their OWN attacks now miss. Half of everything they throw
   *  for the duration — crippling on its own, and the reason Infected is worth
   *  paying for, since every one of those whiffs then rebounds onto them. */
  BUTTERFLIES_MISS_CHANCE: 0.5,
  /** How long both halves of the debuff last. */
  BUTTERFLIES_SECONDS: 10,

  /** "Infected": how long a victim keeps deflecting their own misses. */
  INFECTED_SECONDS: 15,

  /** "Creepy Crawlers": how many bugs are sent. */
  CRAWLER_COUNT: 3,
  /** Clicks needed to squash ONE of them. */
  CRAWLER_HITS_TO_KILL: 2,
  /** Gold drained per second, by EACH bug still alive. The drain therefore
   *  falls as the victim swats them, so squashing one is worth something
   *  immediately rather than only on the last one. */
  CRAWLER_DRAIN_PER_SECOND: 22,
  /** How long they stay if the victim never swats them. */
  CRAWLER_SECONDS: 20,

  /** "Caprice": how long the butterfly holds the field. */
  CAPRICE_SECONDS: 25,
  /** How often it re-rolls everyone's target. */
  CAPRICE_SCRAMBLE_SECONDS: 1,
} as const;

export const MAGMA = {
  /** Extra damage dealt to a kingdom that is currently targeting Magma. */
  HOT_ASH_DAMAGE_PCT: 0.25,
  /**
   * How often the warning fires. Every kingdom currently targeting Magma is
   * marked for `HOT_ASH_MARK_TICKS` — a periodic reminder that aiming at Magma
   * is what makes its attacks hurt more.
   */
  HOT_ASH_INTERVAL_TICKS: 45 * TICK.RATE,
  /** How long the mark stays up. */
  HOT_ASH_MARK_TICKS: 3 * TICK.RATE,
  /** Lava Punch: chance the basic attack also sets the target alight. */
  LAVA_PUNCH_BURN_CHANCE: 0.35,
  /** "Floor is Lava": how much harder EVERY burn on the field hits. */
  /** Eruption's odds of setting a burn. Low: Eruption is the big hit, not the
   *  reliable way to light someone. */
  ERUPTION_BURN_CHANCE: 0.2,
  /** Every Magma attack hits this much harder while the floor is lava. */
  LAVA_FLOOR_ATTACK_MULTIPLIER: 1.1,
  LAVA_FLOOR_BURN_MULTIPLIER: 1.5,
  /** How long the floor stays molten, in seconds. */
  LAVA_FLOOR_DURATION_SECONDS: 20,
  /**
   * Magma's burn, per tick per stack, while the victim has a shield up. It
   * still goes THROUGH the shield ("Hotter fire") — just for less, so a shield
   * is worth buying against Magma without shutting it out.
   */
  SHIELDED_BURN_TICK: 4,
  /** Smoke Screen: damage dealt to each kingdom currently targeting Magma. */
  SMOKE_SCREEN_DAMAGE: 200,
  /** How long the smoke blinds them, in seconds. */
  SMOKE_SCREEN_BLIND_SECONDS: 4,
  /**
   * "The End of the World": what the eruption is worth. The field takes this
   * MINUS whatever it managed to chip off the volcano, so breaking it entirely
   * is a clean escape and doing nothing is the full hit.
   */
  VOLCANO_ERUPTION_YIELD: 5000,
  /** How long the field has to break it, in seconds. */
  VOLCANO_TIMER_SECONDS: 20,
} as const;

/** Targeting rules. */
export const TARGETING = {
  /** Anti-spam cooldown between switching targets, in seconds. */
  SWITCH_COOLDOWN_SECONDS: 3.5,
  /** The same cooldown in ticks, derived from the tick rate (3.5 s × 20 = 70). */
  SWITCH_COOLDOWN_TICKS: 3.5 * TICK.RATE,
} as const;

/** Reconnection handling. */
export const RECONNECT = {
  /**
   * Grace period (ms) a disconnected player is kept in their seat before being
   * removed. During this window their slot, position, and kingdom stay reserved
   * so nobody else can take them. Default 60 seconds; overridable via the
   * RECONNECT_GRACE_MS environment variable.
   */
  GRACE_MS: 60_000,
} as const;
