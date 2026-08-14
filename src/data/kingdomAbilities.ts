import { WATER_ABILITIES } from "./waterAbilities.js";
import { FIRE_ABILITIES } from "./fireAbilities.js";
import { AIR_ABILITIES } from "./airAbilities.js";
import { EARTH_ABILITIES } from "./earthAbilities.js";
import { ELECTRICITY_ABILITIES } from "./electricityAbilities.js";
import { ICE_ABILITIES } from "./iceAbilities.js";
import { NATURE_ABILITIES } from "./natureAbilities.js";
import { TIME_ABILITIES } from "./timeAbilities.js";
import { SPACE_ABILITIES } from "./spaceAbilities.js";
import { LOVE_ABILITIES } from "./loveAbilities.js";
import { JOKER_ABILITIES } from "./jokerAbilities.js";
import { LIGHT_ABILITIES } from "./lightAbilities.js";
import { DARK_ABILITIES } from "./darkAbilities.js";
import { KITSUNE_ABILITIES } from "./kitsuneAbilities.js";
import { MAGMA_ABILITIES } from "./magmaAbilities.js";
import { INSECTS_ABILITIES } from "./insectsAbilities.js";
import type { KingdomId } from "./kingdoms.js";
import type { AbilityDefinition } from "../engine/abilities.js";

/**
 * Each kingdom's activatable ability set, keyed by kingdom id. Pure data — a
 * generic consumer (UI, AI, analytics) can enumerate what a kingdom can cast
 * without naming any kingdom in code.
 */
export const KINGDOM_ABILITIES: Record<KingdomId, AbilityDefinition[]> = {
  water: WATER_ABILITIES,
  fire: FIRE_ABILITIES,
  air: AIR_ABILITIES,
  earth: EARTH_ABILITIES,
  electricity: ELECTRICITY_ABILITIES,
  ice: ICE_ABILITIES,
  nature: NATURE_ABILITIES,
  time: TIME_ABILITIES,
  space: SPACE_ABILITIES,
  love: LOVE_ABILITIES,
  // Placeholder kits — playable stand-ins until each kingdom is designed.
  joker: JOKER_ABILITIES,
  light: LIGHT_ABILITIES,
  dark: DARK_ABILITIES,
  kitsune: KITSUNE_ABILITIES,
  magma: MAGMA_ABILITIES,
  insects: INSECTS_ABILITIES,
};

/** The ability set for a kingdom id, or an empty list for unknown ids. */
export function abilitiesForKingdom(
  kingdomId: string | null,
): AbilityDefinition[] {
  if (!kingdomId) return [];
  return KINGDOM_ABILITIES[kingdomId as KingdomId] ?? [];
}
