import type { Match } from "../match/Match.js";
import type { AbilityDefinition, EffectDefinition } from "./abilities.js";
import { volcanoIsLive } from "./volcano.js";
import { capriceIsActive } from "./caprice.js";

/**
 * The middle of the battlefield holds ONE thing at a time.
 *
 * A handful of abilities do not target a kingdom at all — they put an entity in
 * the centre of the field that the whole table has to look at and interact with:
 * Magma's volcano, Insects' butterfly. Each one owns that space completely. It
 * draws every eye, it is clicked directly, and its rules override normal
 * targeting for as long as it stands.
 *
 * Two of them at once is not a balance problem, it is an incoherent board. The
 * volcano needs everyone able to aim at it; Caprice takes everyone's aim away.
 * Stacked, they would render on top of each other and contradict each other's
 * rules, and a player asked to break a volcano they are forbidden to target has
 * been handed a puzzle with no solution.
 *
 * So the centre is a single exclusive slot: while one centrepiece is standing,
 * no ability that would spawn another can be cast — including the same one
 * twice. The one already there must finish first.
 *
 * ADDING A NEW ONE: append it to `CENTREPIECES` below. That single registration
 * is the whole integration — the activation guard reads this list, so a new
 * centre-of-the-field ability is mutually exclusive with every existing one, in
 * both directions, without touching `activateAbility` at all. Nothing else in
 * the engine needs to know it exists.
 */
export interface Centrepiece {
  /** The effect primitive that puts this thing on the field. */
  readonly spawnEffect: EffectDefinition["type"];
  /** What it is called, for the rejection reported to the caster. */
  readonly name: string;
  /** True while it is standing in the middle of the field. */
  isStanding(match: Match): boolean;
}

/** Everything that claims the middle of the battlefield. */
export const CENTREPIECES: readonly Centrepiece[] = [
  {
    spawnEffect: "spawnVolcano",
    name: "The End of the World",
    isStanding: volcanoIsLive,
  },
  {
    spawnEffect: "spawnCaprice",
    name: "Caprice",
    isStanding: capriceIsActive,
  },
  {
    // Space's Black Hole opens at the arena centre and swallows everything
    // thrown at its owner until it collapses.
    spawnEffect: "createBlackHole",
    name: "Black Hole",
    isStanding: (match) => {
      const hole = match.gameState?.blackHole;
      return !!hole && match.tick < hole.endTick;
    },
  },
  {
    // Light's Light Show hangs a disc over the centre of the field and spins it
    // through a three-count before the lasers come down. Brief compared to the
    // others — it owns the centre only for the warning — but while that disc is
    // up it is unmistakably the thing in the middle of the board.
    spawnEffect: "delayedStrike",
    name: "Light Show",
    isStanding: (match) => {
      const state = match.gameState;
      if (!state) return false;
      // A strike with a `targetId` is Joker's Blackjack card in flight toward
      // ONE kingdom, not a disc over the field — it draws nothing in the middle
      // and must not hold the slot. Only the field-wide strike is a centrepiece.
      return state.pendingStrikes.some(
        (s) => s.targetId === undefined && match.tick < s.resolveTick,
      );
    },
  },
];

/**
 * The centrepiece currently holding the field, or null when the middle is
 * clear.
 *
 * Only one can ever be standing — that is what this module enforces — so the
 * first match is the answer.
 */
export function standingCentrepiece(match: Match): Centrepiece | null {
  return CENTREPIECES.find((c) => c.isStanding(match)) ?? null;
}

/**
 * The centrepiece `ability` would spawn, or null if it is not a centre-of-the-
 * field ability at all.
 *
 * Read off the ability's EFFECTS rather than a flag on the definition or a list
 * of ability ids: an ability that spawns a volcano is one whose effects say so,
 * so an upgrade path, a reskin or a second kingdom borrowing the primitive is
 * covered automatically and cannot forget to declare itself.
 */
export function centrepieceSpawnedBy(ability: AbilityDefinition): Centrepiece | null {
  return (
    CENTREPIECES.find((c) => ability.effects.some((e) => e.type === c.spawnEffect)) ?? null
  );
}
