import type { GameplayEvent } from "../../../src/engine/events.js";
import type { SimulationObserver } from "../types.js";

/**
 * Per-seat combat tallies, gathered from the gameplay event stream.
 *
 * ⚠️ THIS IS NOT AN OBSERVATION CHANNEL. It runs on the TRAINING side, after a
 * match, to describe what happened for the fitness function. The controller
 * never sees it. The information boundary constrains what a PLAYER may know
 * while deciding; it does not constrain what a trainer may measure afterwards,
 * any more than a coach reviewing a replay is cheating.
 *
 * `test/neatBoundary.test.ts` holds the line that matters: nothing in `ai/`
 * imports this, and the network is fed only by `ai/observation.ts`.
 *
 * Damage RECEIVED is the reason this exists at all. `telemetry.ts` records
 * damage per DEALER, so a seat's own record says what it dealt and not what
 * landed on it; deriving it from HP would silently fold in healing and shields.
 * The event stream carries both sides of every hit, so tallying it here is both
 * exact and free of engine changes.
 */

export interface SeatCombat {
  /**
   * Successful ability activations by this seat.
   *
   * Counted from the event stream rather than read from ControllerStats, because
   * only the network controller keeps stats — a heuristic personality reports
   * none. Taking casts from the controller made every heuristic baseline look
   * completely inactive and score zero through the inactivity guard, which made
   * the whole comparison meaningless. The event stream is controller-agnostic
   * and is what actually happened.
   */
  casts: number;
  damageDealt: number;
  damageReceived: number;
  /** Damage absorbed by this seat's shields (part of `damageReceived`). */
  shieldAbsorbed: number;
  kills: number;
  healingReceived: number;
}

function empty(): SeatCombat {
  return { casts: 0, damageDealt: 0, damageReceived: 0, shieldAbsorbed: 0, kills: 0, healingReceived: 0 };
}

/**
 * Tallies combat totals per seat for one match.
 *
 * Cheaper than the full `TelemetryCollector`, which builds per-ability tables
 * and per-tick time series that training does not read. Training runs hundreds
 * of thousands of matches, so paying only for what fitness consumes matters.
 */
export class CombatObserver implements SimulationObserver {
  private readonly seats = new Map<string, SeatCombat>();
  /**
   * Who last damaged each seat.
   *
   * The `eliminated` event names only the victim, so a killing blow has to be
   * attributed by remembering the last hit that landed. Damage-over-time counts,
   * which is correct: a burn that finishes a castle is a kill for whoever lit it.
   */
  private readonly lastDamager = new Map<string, string>();

  private seat(id: string): SeatCombat {
    let entry = this.seats.get(id);
    if (entry === undefined) {
      entry = empty();
      this.seats.set(id, entry);
    }
    return entry;
  }

  onEvent(event: GameplayEvent): void {
    switch (event.type) {
      case "abilityCast": {
        this.seat(event.casterId).casts += 1;
        break;
      }
      case "damage": {
        // `amount` is the raw hit; `dealtToHp + absorbedByShield` is what
        // actually landed. Overkill is excluded deliberately — a genome should
        // not be credited for the part of a blow that hit a corpse.
        const landed = event.dealtToHp + event.absorbedByShield;
        this.seat(event.sourceId).damageDealt += landed;
        const victim = this.seat(event.targetId);
        victim.damageReceived += landed;
        victim.shieldAbsorbed += event.absorbedByShield;
        if (landed > 0) this.lastDamager.set(event.targetId, event.sourceId);
        break;
      }
      case "heal": {
        this.seat(event.targetId).healingReceived += event.amount;
        break;
      }
      case "eliminated": {
        // The event names only the victim, so the kill goes to whoever last
        // landed damage on them. A seat eliminated with nothing recorded (the
        // engine ending a match, say) credits nobody rather than guessing.
        const killer = this.lastDamager.get(event.playerId);
        if (killer !== undefined && killer !== event.playerId) {
          this.seat(killer).kills += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Totals for one seat; zeroes when the seat never appeared in an event. */
  for(playerId: string): SeatCombat {
    return this.seats.get(playerId) ?? empty();
  }
}
