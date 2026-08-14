import { WATER_BALL, WATERFALL, FLOOD, FLUID_ASSIMILATION, RIPTIDE } from "./waterAbilities.js";
import { FIREBALL, SCORCHING_SUN, FIRENADO, HEAT_WAVE, BLAZING_DETERMINATION } from "./fireAbilities.js";
import { A_LIGHT_BREEZE, HURRICANE, THICK_FOG, BIRDS_EYE_VIEW, DUST_BUNNIES } from "./airAbilities.js";
import { ROCK_THROW, METEOR_SHOWER, EARTHQUAKE, NATURAL_TERRAIN, BRICK_WALL } from "./earthAbilities.js";
import { ZAP, LIGHTNING_BARRAGE, THUNDERDOME, HACK, THUNDERING_FATE } from "./electricityAbilities.js";
import { ICICLE, FLOOD_OF_FROST, FREEZE_TO_THE_CORE, SNOWMAN, BLIZZARD } from "./iceAbilities.js";
import { SLUDGE, ACID_RAIN, GASTRO_ACID, POISON_APPLE, TOXIC_GAS } from "./natureAbilities.js";
import { TIK_TOK, HALF_PASSED_12, FATHER_TIME, BLIP, BACK_TO_THE_FUTURE } from "./timeAbilities.js";
import { SHOOTING_STAR, SATURNS_RINGS, SUPERNOVA, ORIONS_BELT, BLACK_HOLE } from "./spaceAbilities.js";
import { TOUGH_LOVE, CUPIDS_ARROW, BFFS, EMPATHY, LOVE_GALORE } from "./loveAbilities.js";
import { JOKER_ABILITIES } from "./jokerAbilities.js";
import { LIGHT_ABILITIES } from "./lightAbilities.js";
import { DARK_ABILITIES } from "./darkAbilities.js";
import { KITSUNE_ABILITIES } from "./kitsuneAbilities.js";
import { MAGMA_ABILITIES } from "./magmaAbilities.js";
import { INSECTS_ABILITIES } from "./insectsAbilities.js";
import type { AbilityDefinition } from "../engine/abilities.js";

/** Keys a kingdom's ability list by ability id, for spreading into the map. */
const byId = (abilities: AbilityDefinition[]): Record<string, AbilityDefinition> =>
  Object.fromEntries(abilities.map((a) => [a.id, a]));

export const ALL_ABILITIES: Record<string, AbilityDefinition> = {
  waterBall: WATER_BALL,
  waterfall: WATERFALL,
  flood: FLOOD,
  fluidAssimilation: FLUID_ASSIMILATION,
  riptide: RIPTIDE,
  fireball: FIREBALL,
  scorchingSun: SCORCHING_SUN,
  firenado: FIRENADO,
  heatWave: HEAT_WAVE,
  blazingDetermination: BLAZING_DETERMINATION,
  aLightBreeze: A_LIGHT_BREEZE,
  hurricane: HURRICANE,
  thickFog: THICK_FOG,
  birdsEyeView: BIRDS_EYE_VIEW,
  dustBunnies: DUST_BUNNIES,
  rockThrow: ROCK_THROW,
  meteorShower: METEOR_SHOWER,
  earthquake: EARTHQUAKE,
  naturalTerrain: NATURAL_TERRAIN,
  brickWall: BRICK_WALL,
  zap: ZAP,
  lightningBarrage: LIGHTNING_BARRAGE,
  thunderdome: THUNDERDOME,
  hack: HACK,
  thunderingFate: THUNDERING_FATE, // key = ability id (cooldownModify looks ids up here)
  icicle: ICICLE,
  floodOfFrost: FLOOD_OF_FROST,
  freezeToTheCore: FREEZE_TO_THE_CORE,
  snowman: SNOWMAN,
  blizzard: BLIZZARD,
  sludge: SLUDGE,
  acidRain: ACID_RAIN,
  gastroAcid: GASTRO_ACID,
  poisonApple: POISON_APPLE,
  toxicGas: TOXIC_GAS,
  tikTok: TIK_TOK,
  halfPassed12: HALF_PASSED_12,
  fatherTime: FATHER_TIME,
  blip: BLIP,
  backToTheFuture: BACK_TO_THE_FUTURE,
  shootingStar: SHOOTING_STAR,
  saturnsRings: SATURNS_RINGS,
  supernova: SUPERNOVA,
  orionsBeltAbility: ORIONS_BELT,
  blackHole: BLACK_HOLE,
  toughLove: TOUGH_LOVE,
  cupidsArrow: CUPIDS_ARROW,
  bffs: BFFS,
  empathy: EMPATHY,
  loveGalore: LOVE_GALORE,
  // Placeholder kingdoms — their ids are generated (`jokerAbility1`…), so they
  // register by list rather than one named import per ability. Spell them out
  // like the kingdoms above once the real kits replace them.
  ...byId(JOKER_ABILITIES),
  ...byId(LIGHT_ABILITIES),
  ...byId(DARK_ABILITIES),
  ...byId(KITSUNE_ABILITIES),
  ...byId(MAGMA_ABILITIES),
  ...byId(INSECTS_ABILITIES),
};
