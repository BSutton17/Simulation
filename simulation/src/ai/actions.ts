import { kingdomOrder, type EnemyKnowledge, type PlayerKnowledge } from "./knowledge.js";

/**
 * The action space: 22 outputs, fixed layout, kingdom-agnostic.
 *
 * The layout is slot-indexed rather than named because every kingdom has
 * exactly five castable abilities in a stable order. "Cast slot 3" therefore
 * means something for all sixteen of them, where "cast Riptide" would mean
 * something for one — and a network whose outputs are named abilities cannot
 * generalize across kingdoms or survive a seventeenth being added.
 *
 * This module holds no state and reads no engine data. It defines where things
 * are, and the one rule that decides which enemy occupies which target slot.
 */

/** Ability slots per kingdom. Uniform across all sixteen. */
export const KIT_SLOTS = 5;
/** Target slots: at most 7 kingdoms play, so at most 6 enemies. */
export const TARGET_SLOTS = 6;

export const CAST_BASE = 0;
export const INVEST_BASE = 5;
export const BUY_CITIZEN = 10;
export const REPAIR = 11;
export const BUY_SHIELD = 12;
export const WAIT = 13;
export const TARGET_BASE = 14;
export const SWITCH_GATE = 20;
export const CHARGE_FRACTION = 21;
/**
 * ⚠️ THREE HEADS THAT TEACH THE ACTION SPACE TO SPEAK THE GAME'S OWN LANGUAGE.
 *
 * Three abilities were unreachable not because they were expensive but because
 * the 22 heads could not describe casting them: `legality.ts` refused any cast
 * whose payload it could not express, and Air's multi-target spread, Love's
 * BFFS second target and Dark's Yin-and-Yang choice all fell into that hole.
 * That refusal never consulted cost, so no balance change could ever reach
 * them.
 *
 * All three are AUXILIARY, like CHARGE_FRACTION: they qualify a cast the
 * primary head already chose, so `PRIMARY_ACTION_COUNT` is unchanged and no
 * existing behaviour shifts.
 */
/** Air's Embrace of Winds: spread this attack across several kingdoms. */
export const SPREAD_GATE = 22;
/** Love's BFFS: which OTHER enemy to link, as a fraction of the eligible set. */
export const SECOND_TARGET = 23;
/** Dark's Yin and Yang: which declared option to name, as a fraction. */
export const CHOICE_PICK = 24;

/** Total network outputs. */
/**
 * ⚠️ THE DEFENSIVE HEADS. WITHOUT THESE A BOT'S ECONOMY STOPS FOR GOOD.
 *
 * Roulette and the Slot Machine halt the victim's gold production until they
 * place a bet or pull the lever; Creepy Crawlers eat gold until the bugs are
 * swatted; Fireflies bar a shield until the ransom is paid. Every one of those
 * resolves through `net/matchHandlers` — `match:bet`, `match:spin`,
 * `match:squash`, `match:buy` — which only a socket reaches. No AI path called
 * them, so a bot hit by Joker or Insects lost its economy for the rest of the
 * match with no way back, and the balance figures for those two kingdoms were
 * measured against opponents who could not defend at all.
 *
 * ⚠️ THEY CONSUME THE DECISION, and that is the design, not a limitation.
 * What these abilities actually cost a human is ATTENTION — you are clicking a
 * bug instead of playing — so resolving them for free would hand the AI an
 * advantage no player has. Firing one of these gates spends the decision it was
 * chosen in, which at a 5-tick decision period is a quarter second: about what
 * a click costs.
 *
 * Placed AFTER the existing heads rather than among the primaries, so no
 * existing index changes meaning and a trained genome can still be warm
 * started — a new output contributes nothing until evolution wires it in.
 */
/** Resolve whatever defensive interaction is pending, instead of acting. */
export const DEFEND_GATE = 25;
/** Roulette only: which colour to back, as a fraction over red/black/green. */
export const BET_PICK = 26;
/** Pay off a dispellable status (Light's Fireflies), instead of acting. */
export const DISPEL_GATE = 27;

export const ACTION_SIZE = 28;

/**
 * The primary heads — the ones an argmax chooses between. Targeting is a
 * separate channel (a seat may retarget AND act on the same decision), and the
 * last two outputs are modifiers rather than choices.
 */
export const PRIMARY_ACTION_COUNT = 14;

export type PrimaryAction =
  | { kind: "cast"; slot: number }
  | { kind: "invest"; slot: number }
  | { kind: "buyCitizen" }
  | { kind: "repair" }
  | { kind: "buyShield" }
  | { kind: "wait" };

/** Decodes a primary head index into a described action. */
export function primaryActionOf(index: number): PrimaryAction {
  if (index >= CAST_BASE && index < CAST_BASE + KIT_SLOTS) {
    return { kind: "cast", slot: index - CAST_BASE };
  }
  if (index >= INVEST_BASE && index < INVEST_BASE + KIT_SLOTS) {
    return { kind: "invest", slot: index - INVEST_BASE };
  }
  switch (index) {
    case BUY_CITIZEN:
      return { kind: "buyCitizen" };
    case REPAIR:
      return { kind: "repair" };
    case BUY_SHIELD:
      return { kind: "buyShield" };
    default:
      return { kind: "wait" };
  }
}

/** Human-readable name for a head, for diagnostics and test failures. */
export function actionName(index: number): string {
  if (index >= TARGET_BASE && index < TARGET_BASE + TARGET_SLOTS) {
    return `target[${index - TARGET_BASE}]`;
  }
  if (index === SWITCH_GATE) return "switchGate";
  if (index === CHARGE_FRACTION) return "chargeFraction";
  if (index === SPREAD_GATE) return "spreadGate";
  if (index === SECOND_TARGET) return "secondTarget";
  if (index === CHOICE_PICK) return "choicePick";
  if (index === DEFEND_GATE) return "defendGate";
  if (index === BET_PICK) return "betPick";
  if (index === DISPEL_GATE) return "dispelGate";
  const action = primaryActionOf(index);
  return "slot" in action ? `${action.kind}[${action.slot}]` : action.kind;
}

/**
 * Which enemy sits in which target slot.
 *
 * ⚠️ The ordering key must be legal at every instant. An earlier draft sorted by
 * `hp + shield` descending, which is unknowable — enemy HP is hidden unless
 * revealed — and would have leaked hidden state through the action space rather
 * than through the observation, where the behavioural tests were looking.
 *
 * The key used instead, in order:
 *
 *   1. Is this enemy aiming at me?   — public (`enemy.target` drives the
 *                                      client's targeting arrows)
 *   2. Damage I have dealt them      — observed by this seat, never read
 *   3. Canonical kingdom order       — static, stable, knowable from the lobby
 *
 * It front-loads the aggressor and the prey, which is what a player actually
 * tracks. Seat order is deliberately NOT the key at any level: there is a
 * measured seat gradient in this simulation (mean 7-FFA placement runs
 * 4.50 → 3.42 from seat 0 to seat 6), and keying on it would teach positional
 * habits that are an artefact of the harness rather than of the game.
 */
export function orderEnemies(knowledge: PlayerKnowledge): EnemyKnowledge[] {
  const selfId = knowledge.self.id;
  return knowledge.enemies
    .filter((e) => !e.eliminated)
    .sort((a, b) => {
      const aimingA = a.targetId === selfId ? 1 : 0;
      const aimingB = b.targetId === selfId ? 1 : 0;
      if (aimingA !== aimingB) return aimingB - aimingA;
      if (a.damageDealt !== b.damageDealt) return b.damageDealt - a.damageDealt;
      return kingdomOrder(a.kingdomId) - kingdomOrder(b.kingdomId);
    })
    .slice(0, TARGET_SLOTS);
}
