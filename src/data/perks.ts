import { PERKS } from "./balance.js";
import { KINGDOM_PASSIVES, type KingdomId } from "./kingdoms.js";

/**
 * Perks — the two match-long bonuses every player picks in the lobby alongside
 * their kingdom, independent of which kingdom they chose.
 *
 * Perks are deliberately the simplest thing in the game: each one is a single
 * number the engine reads at exactly one place (see `engine/perks.ts`). They
 * ALWAYS stack with kingdom passives, abilities, and other perks rather than
 * overriding them — Space may still start with its passive gold *and* Deep
 * Pockets on top, Fire may still Roast shields *and* carry Sharper Axes.
 *
 * Magnitudes live in `balance.ts` (data declares what, systems declare how).
 */

export const PERK_IDS = [
  "sharperSwords",
  "sharperAxes",
  "extraGuards",
  "extraMedics",
  "extraRepairs",
  "deepPockets",
  "greatMerchants",
  "betterConstruction",
] as const;

export type PerkId = (typeof PERK_IDS)[number];

export interface PerkDefinition {
  id: PerkId;
  /** Display name shown in the lobby. */
  name: string;
  /** One-line effect summary, mirrored by the client's own copy. */
  description: string;
}

export const PERK_DEFINITIONS: Record<PerkId, PerkDefinition> = {
  sharperSwords: {
    id: "sharperSwords",
    name: "Sharper Swords",
    description: `+${Math.round(PERKS.ATTACK_PCT * 100)}% attack`,
  },
  sharperAxes: {
    id: "sharperAxes",
    name: "Sharper Axes",
    description: `+${Math.round(PERKS.SHIELD_ATTACK_PCT * 100)}% attack to shields`,
  },
  extraGuards: {
    id: "extraGuards",
    name: "Extra Guards",
    description: `+${Math.round(PERKS.DAMAGE_REDUCTION_PCT * 100)}% damage reduction`,
  },
  extraMedics: {
    id: "extraMedics",
    name: "Extra Medics",
    description: `+${Math.round(PERKS.DOT_REDUCTION_PCT * 100)}% damage reduction to damage-over-time effects`,
  },
  extraRepairs: {
    id: "extraRepairs",
    name: "Extra Repairs",
    description: `-${Math.round(PERKS.COOLDOWN_REDUCTION_PCT * 100)}% cooldown`,
  },
  deepPockets: {
    id: "deepPockets",
    name: "Deep Pockets",
    description: `+${PERKS.STARTING_GOLD} starting gold`,
  },
  greatMerchants: {
    id: "greatMerchants",
    name: "Great Merchants",
    description: `-${Math.round(PERKS.UNLOCK_DISCOUNT_PCT * 100)}% unlock price`,
  },
  betterConstruction: {
    id: "betterConstruction",
    name: "Better Construction",
    description: `+${PERKS.SHIELD_BONUS_HP} shield health`,
  },
};

/** How many perks a player picks before they can ready up, by default. */
export const PERKS_PER_PLAYER = PERKS.PER_PLAYER;

/**
 * How many perks THIS kingdom picks. Kitsune's "Three tailed fox" takes one
 * more than everyone else, so the allowance is a function of the kingdom rather
 * than a constant — every gate below asks this, not `PERKS_PER_PLAYER`.
 *
 * A player who hasn't chosen a kingdom yet gets the base allowance; they cannot
 * ready up without one anyway.
 */
export function perksAllowedFor(kingdomId: string | null | undefined): number {
  if (!kingdomId) return PERKS_PER_PLAYER;
  let extra = 0;
  for (const p of KINGDOM_PASSIVES[kingdomId as KingdomId] ?? []) {
    if (p.type === "extraPerks") extra += p.extra;
  }
  return PERKS_PER_PLAYER + extra;
}

/** Whether a selection is complete — the gate on readying up and starting. */
export function hasFullPerkSelection(
  perks: readonly PerkId[] | undefined,
  kingdomId?: string | null,
): boolean {
  return (perks?.length ?? 0) === perksAllowedFor(kingdomId);
}

export function isPerkId(value: unknown): value is PerkId {
  return (
    typeof value === "string" && (PERK_IDS as readonly string[]).includes(value)
  );
}

/**
 * Validates a client-supplied perk selection: an array of at most
 * `perksAllowedFor(kingdom)` known, distinct perk ids. Returns null when the payload is
 * malformed. A SHORT selection is legal — the lobby lets a player toggle one
 * perk at a time; the full count is only required to ready up.
 */
export function normalizePerks(
  raw: unknown,
  kingdomId?: string | null,
): PerkId[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > perksAllowedFor(kingdomId)) return null;
  const perks: PerkId[] = [];
  for (const entry of raw) {
    if (!isPerkId(entry)) return null;
    if (perks.includes(entry)) return null; // no doubling up on one perk
    perks.push(entry);
  }
  return perks;
}
