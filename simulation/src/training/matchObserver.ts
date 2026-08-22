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

/**
 * Statuses under which repeating an ability is the intended play, not spam.
 *
 * Electricity's Thundering Fate clears Zap's cooldown and cuts its price for a
 * window; firing Zap five to ten times inside it is the kingdom's whole payoff.
 * A blanket repeat penalty would make executing that line the most punished
 * thing Electricity can do.
 */
const SPAM_EXEMPT_STATUSES = new Set(["thunderingFate"]);

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
  /**
   * Which abilities this seat cast, not merely how many times.
   *
   * The distinction the whole variety term rests on. A genome that casts its
   * cheapest attack four hundred times has four hundred casts and ONE ability;
   * counting only the total made those indistinguishable, and the search
   * correctly concluded that spam was the cheapest way to look active.
   */
  abilitiesUsed: Set<string>;
  /**
   * Every cast this seat made, IN ORDER.
   *
   * ⚠️ ORDER IS THE WHOLE POINT and a Set cannot carry it. Two behaviours look
   * identical in `abilitiesUsed` and are opposites in play: casting A B A B is
   * a rotation, casting A A A A B is spam with a garnish. The same is true of a
   * combo — Acid Rain then Gastro Acid then Sludge is Nature's intended line,
   * and the same three in any other order is not.
   *
   * Kept as a flat list rather than pre-aggregated counters so the fitness can
   * ask new questions of it later without another engine change.
   */
  castSequence: string[];
  /**
   * Indices into `castSequence` that were made under a spam exemption.
   *
   * Electricity's Thundering Fate exists to let Zap be fired repeatedly — that
   * IS the payoff. Penalising repetition there would punish the kingdom for
   * playing its own combo correctly, so those casts are excluded from the
   * repeat penalty.
   */
  exemptCasts: Set<number>;
  damageDealt: number;
  damageReceived: number;
  /** Damage absorbed by this seat's shields (part of `damageReceived`). */
  shieldAbsorbed: number;
  kills: number;
  healingReceived: number;
  /**
   * Times this seat had a shield standing when Light Show fired.
   *
   * ⚠️ THIS IS A REACTION, and it is the only term that scores READING the
   * board rather than executing a plan. Light Show announces itself — the cast
   * is visible — so a policy that keeps a shield up through it has anticipated
   * something, which is exactly the behaviour spamming cannot produce.
   *
   * The caster is excluded: shielding against your own ultimate is not defence.
   */
  shieldedVsLightShow: number;
  /** Damage this seat dealt to a volcano. */
  volcanoDamage: number;
  /** Share of the volcano's health this seat removed, once it was broken. */
  volcanoShare: number;
}

function empty(): SeatCombat {
  return {
    casts: 0,
    abilitiesUsed: new Set<string>(),
    castSequence: [],
    exemptCasts: new Set<number>(),
    damageDealt: 0,
    damageReceived: 0,
    shieldAbsorbed: 0,
    kills: 0,
    healingReceived: 0,
    shieldedVsLightShow: 0,
    volcanoDamage: 0,
    volcanoShare: 0,
  };
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
  /**
   * Seats currently under a status that exempts them from the repeat penalty.
   *
   * Only Thundering Fate for now. It suspends Zap's cooldown and discounts it
   * for a window — repeatedly firing Zap IS the ability's purpose, so a repeat
   * penalty applied there would punish Electricity for executing its own
   * intended line. Tracked from the event stream so it stays exact without the
   * engine having to know anything about training.
   */
  private readonly exempt = new Set<string>();
  /** Seats with a shield standing right now, from the event stream. */
  private readonly shielded = new Set<string>();
  /** Volcano damage by attacker, resolved into shares when it breaks. */
  private readonly volcanoHits = new Map<string, number>();

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
        const seat = this.seat(event.casterId);
        seat.casts += 1;
        seat.abilitiesUsed.add(event.abilityId);
        if (this.exempt.has(event.casterId)) {
          seat.exemptCasts.add(seat.castSequence.length);
        }
        seat.castSequence.push(event.abilityId);
        if (event.abilityId === "lightShow") {
          for (const id of this.shielded) {
            if (id !== event.casterId) this.seat(id).shieldedVsLightShow += 1;
          }
        }
        break;
      }
      case "shieldGained": {
        this.shielded.add(event.playerId);
        break;
      }
      case "shieldDestroyed": {
        this.shielded.delete(event.playerId);
        break;
      }
      case "volcanoDamaged": {
        this.volcanoHits.set(
          event.attackerId,
          (this.volcanoHits.get(event.attackerId) ?? 0) + event.amount,
        );
        this.seat(event.attackerId).volcanoDamage += event.amount;
        break;
      }
      case "volcanoBroken": {
        // Credited as a SHARE, so the reward is for contributing to the kill
        // rather than for landing the last hit. Magma's own chip damage counts
        // for nothing here — it owns the volcano.
        let total = 0;
        for (const [id, amount] of this.volcanoHits) {
          if (id !== event.ownerId) total += amount;
        }
        if (total > 0) {
          for (const [id, amount] of this.volcanoHits) {
            if (id === event.ownerId) continue;
            this.seat(id).volcanoShare += amount / total;
          }
        }
        this.volcanoHits.clear();
        break;
      }
      case "statusApplied": {
        if (SPAM_EXEMPT_STATUSES.has(event.statusId)) this.exempt.add(event.targetId);
        break;
      }
      case "statusExpired": {
        if (SPAM_EXEMPT_STATUSES.has(event.statusId)) this.exempt.delete(event.playerId);
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
