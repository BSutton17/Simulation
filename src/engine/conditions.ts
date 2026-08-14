import type { PlayerState } from "../match/playerState.js";

export type ConditionType =
  | "targetHasStatus"
  | "targetHasStatusFromCaster"
  | "casterHasStatus"
  | "targetHasShield"
  | "targetHpBelow"
  | "casterHpBelow"
  | "targetKingdom"
  | "attackElement"
  | "and"
  | "or"
  | "not";

export interface EffectCondition {
  type: ConditionType;
  params?: {
    statusId?: string;
    hpPercent?: number; // e.g. 0.50 for 50%
    kingdomId?: string;
    element?: string;
  };
  conditions?: EffectCondition[]; // for nested and/or/not operations
}

/** Checks if a player has a status effect by its ID. */
function playerHasStatus(player: PlayerState, statusId: string): boolean {
  return player.statuses.some((s) => s.id === statusId);
}

/** Evaluates an EffectCondition against a caster and a target. */
export function evaluateCondition(
  condition: EffectCondition,
  caster: PlayerState,
  target: PlayerState,
  element?: string,
): boolean {
  const p = condition.params;
  switch (condition.type) {
    case "targetHasStatus":
      return p?.statusId ? playerHasStatus(target, p.statusId) : false;
    case "targetHasStatusFromCaster":
      // The target bears the status AND the caster is who applied it — e.g.
      // Burn amplifying Fire attacks only from the player who set the Burn.
      return p?.statusId
        ? target.statuses.some(
            (s) => s.id === p.statusId && s.sourceId === caster.id,
          )
        : false;
    case "casterHasStatus":
      return p?.statusId ? playerHasStatus(caster, p.statusId) : false;
    case "targetHasShield":
      return target.castle.shield > 0;
    case "targetHpBelow":
      return p?.hpPercent !== undefined
        ? target.castle.hp / target.castle.maxHp < p.hpPercent
        : false;
    case "casterHpBelow":
      return p?.hpPercent !== undefined
        ? caster.castle.hp / caster.castle.maxHp < p.hpPercent
        : false;
    case "targetKingdom":
      return p?.kingdomId ? target.kingdomId === p.kingdomId : false;
    case "attackElement":
      return p?.element ? element === p.element : false;
    case "and":
      return (condition.conditions ?? []).every((c) =>
        evaluateCondition(c, caster, target, element),
      );
    case "or":
      return (condition.conditions ?? []).some((c) =>
        evaluateCondition(c, caster, target, element),
      );
    case "not":
      return condition.conditions?.[0]
        ? !evaluateCondition(condition.conditions[0], caster, target, element)
        : true;
    default:
      return true;
  }
}
