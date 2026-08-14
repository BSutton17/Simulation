import { TARGETING } from "../data/balance.js";
import { param } from "./parameters.js";
import { VOLCANO_TARGET_ID } from "../match/GameState.js";
import { capriceProtects, capriceScrambles } from "./caprice.js";
import { volcanoIsLive } from "./volcano.js";
import { isTargetingBlocked } from "./status.js";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Target selection (tickets #61–#62). A player may aim their kingdom at another
 * *active* kingdom; that choice drives who their offensive abilities hit. The
 * selection is validated server-authoritatively here before it is stored on the
 * player, so a target is never set to something illegal. Passing `null` clears
 * the current target.
 *
 * Invalid targets rejected (#62):
 *  - eliminated kingdoms,
 *  - yourself — unless an ability explicitly allows self-targeting (`allowSelf`),
 *  - players no longer in the match: a disconnected player whose reconnection
 *    grace expired is removed from the roster (see lobbyRoom.removePlayerFromMatch),
 *    so roster membership is exactly the "within grace period" boundary. A
 *    disconnected player still inside their grace window remains a legal target
 *    because their kingdom is still in play and may return.
 *
 * Switching to a *different* target is rate-limited by an anti-spam cooldown
 * (`TARGETING.SWITCH_COOLDOWN_TICKS`): rejected with `TARGET_ON_COOLDOWN` until
 * it elapses. Clearing the target and re-selecting the current one are free (no
 * switch occurs), and clearing does not reset the cooldown, so it can't be used
 * to dodge the limit.
 */

export type TargetError =
  | "INVALID_PHASE"
  | "ELIMINATED"
  | "INVALID_TARGET"
  | "TARGET_ON_COOLDOWN"
  | "TARGET_LOCKED";

export interface TargetResult {
  ok: boolean;
  error?: TargetError;
}

export interface TargetOptions {
  /** Allow the player to target their own kingdom (e.g. a self-buff ability). */
  allowSelf?: boolean;
}

export function selectTarget(
  match: Match,
  player: PlayerState,
  targetId: string | null,
  options: TargetOptions = {},
): TargetResult {
  if (match.phase !== "active") return { ok: false, error: "INVALID_PHASE" };
  if (player.eliminated) return { ok: false, error: "ELIMINATED" };

  // Space's Supernova (L2/L3) forces every kingdom onto its victim and locks
  // the selection: no swaps (or clears) while the lock is active. Re-selecting
  // the already-forced target is a harmless no-op.
  if (player.statuses.some((s) => s.blocksTargetChange) && targetId !== player.target) {
    return { ok: false, error: "TARGET_LOCKED" };
  }

  // Clearing the target is always legal for an active player.
  if (targetId === null) {
    player.target = null;
    return { ok: true };
  }

  // Self-targeting is blocked unless an ability explicitly permits it (#62).
  if (targetId === player.id && !options.allowSelf) {
    return { ok: false, error: "INVALID_TARGET" };
  }

  // Must still be in the match roster. A player removed after their reconnection
  // grace expired is no longer targetable; one still within grace remains (#62).
  // The volcano (Magma's "The End of the World") is a legal target while it is
  // standing: everyone but Magma has to be able to point at it and swing. It is
  // not a kingdom, so none of the player checks below apply to it.
  if (targetId === VOLCANO_TARGET_ID) {
    if (!volcanoIsLive(match)) return { ok: false, error: "INVALID_TARGET" };
    if (match.gameState!.volcano!.ownerId === player.id) {
      // Magma cannot attack its own volcano — it is the one kingdom the
      // eruption spares, so letting it help would be pure downside.
      return { ok: false, error: "INVALID_TARGET" };
    }
    player.target = targetId;
    return { ok: true };
  }

  // Insects' "Caprice": while the butterfly holds the field nobody picks their
  // own fight. Manual selection is refused outright rather than merely being
  // overwritten a moment later — being able to re-aim in the gaps between
  // scrambles would hand back exactly the control the ability takes away.
  if (capriceScrambles(match, player)) {
    return { ok: false, error: "INVALID_TARGET" };
  }
  // …and Insects itself cannot be aimed at for the duration.
  if (capriceProtects(match, targetId)) {
    return { ok: false, error: "INVALID_TARGET" };
  }

  if (!match.hasPlayer(targetId)) return { ok: false, error: "INVALID_TARGET" };

  // Must be a live, non-eliminated kingdom (#61/#62).
  const target = match.gameState?.getPlayer(targetId);
  if (!target || target.eliminated) {
    return { ok: false, error: "INVALID_TARGET" };
  }

  // An active status may bar targeting its applier (#88, e.g. Flood) —
  // every other kingdom remains a legal target.
  if (isTargetingBlocked(player, targetId)) {
    return { ok: false, error: "INVALID_TARGET" };
  }

  // Changing to a different target is gated by the anti-spam switch cooldown.
  // Re-selecting the current target is a no-op and never triggers it.
  const changed = targetId !== player.target;
  if (changed) {
    if (match.tick < player.targetSwitchReadyTick) {
      return { ok: false, error: "TARGET_ON_COOLDOWN" };
    }
    player.targetSwitchReadyTick =
      match.tick + param("targeting.switchCooldownTicks", TARGETING.SWITCH_COOLDOWN_TICKS);
  }

  player.target = targetId;

  // Gameplay event (#204/#207): an accepted target change.
  const bus = match.gameState?.events;
  if (changed && bus?.enabled) {
    bus.emit({
      type: "targetChanged",
      tick: match.tick,
      playerId: player.id,
      targetId,
    });
  }
  return { ok: true };
}
