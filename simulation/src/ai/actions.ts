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

/** Total network outputs. */
export const ACTION_SIZE = 22;

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
