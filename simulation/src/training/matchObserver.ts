import type { GameplayEvent } from "../../../src/engine/events.js";
import type { Match } from "../../../src/match/Match.js";
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

/**
 * Statuses whose ONLY exit is buying a shield.
 *
 * Listed by id rather than read from the definition because the observer never
 * imports ability data — but the definition is the authority, and a test pins
 * this set against every status carrying `endsOnShieldPurchase` so a new one
 * cannot be added without this list noticing.
 */
const SHIELD_ENDED_STATUSES = new Set(["oldFriends"]);

/**
 * How long a frozen-income debt may sit before answering it is worth nothing.
 *
 * Ten seconds at 20 ticks/s. Long enough that a seat mid-combo is not punished
 * for finishing the cast it was already making, short enough that ignoring the
 * machine for half a match earns no credit at all.
 */
const DEBT_PATIENCE = 10 * 20;

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
  /**
   * Sieges this seat lifted by buying a shield (Kitsune's Old Friends).
   *
   * ⚠️ THE ONLY EXIT THE GAME OFFERS. `endsOnShieldPurchase` with
   * `durationTicks: 0` means no clock and no ransom — the status ticks damage
   * until a shield is bought, so waiting is not counterplay, it is just losing
   * slowly. Scored separately from the Light Show read because it is a
   * different skill: one is reacting inside a 3.25 s window, this one is
   * recognising that the usual option of riding a debuff out does not exist.
   */
  siegesLifted: number;
  /**
   * Frozen-income debts this seat cleared, and how quickly.
   *
   * ⚠️ THE CAPABILITY EXISTED WITH NOTHING PAYING FOR IT. Answering a spin,
   * a bet or a swarm COSTS a decision immediately, while the benefit — an
   * income that keeps running — is indirect and arrives later. With no term
   * for it, the gradient pointed away from defending at every moment, so a
   * genome that started answering the casino was punished now and repaid
   * only maybe, much later. That is a valley evolution does not cross, and
   * the heads would have stayed dead however many generations were spent.
   *
   * SPEED IS THE MEASURE, not the count. Roulette and the Slot Machine freeze
   * gold production until they are answered, so what matters is how long the
   * freeze lasted — counting answers alone would pay the same for clearing a
   * debt instantly and for sitting on it half the match.
   */
  debtsCleared: number;
  /** Summed promptness of those clears, each in [0,1]. */
  debtPromptness: number;
  /**
   * The most gold this seat ever held at once.
   *
   * ⚠️ NOTHING IN THE SCORING EVER REWARDED HOLDING GOLD, and five terms
   * reward spending it — activity counts casts, variety counts distinct
   * abilities, combo counts sequences, ultimate pays for reaching one, resource
   * pays for shields and repairs. So every gradient pointed at spending, and a
   * treasury scored exactly zero. Measured across all sixteen kingdoms in a
   * duel: median holdings 42-96 gold against dearest abilities costing 300 to
   * 1345. Not one kingdom could ever afford its own most expensive ability.
   *
   * Saving is only INSTRUMENTALLY useful — hold now, afford something better
   * later — which is delayed, indirect credit and the hardest kind for
   * evolution to find on its own. This is the number that lets it be paid for.
   *
   * Sampled every TICK rather than on casts: reading the treasury at the moment
   * a seat acts reads it exactly when it is lowest.
   */
  peakCurrency: number;
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
    siegesLifted: 0,
    peakCurrency: 0,
    debtsCleared: 0,
    debtPromptness: 0,
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
  /** Seats currently under a siege only a shield can lift. */
  private readonly besieged = new Set<string>();
  /** When each frozen-income debt was opened, so its clear can be timed. */
  private readonly debtOpenedAt = new Map<string, number>();
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

  /**
   * Samples every seat's treasury once a tick.
   *
   * On the tick rather than on a cast, because a seat's gold at the moment it
   * acts is its gold at the moment it is lowest — reading there would measure
   * the opposite of what "how much did it manage to save" means.
   */
  onTick(match: Match): void {
    const state = match.gameState;
    if (!state) return;
    for (const player of state.getPlayers()) {
      const seat = this.seat(player.id);
      if (player.economy.currency > seat.peakCurrency) {
        seat.peakCurrency = player.economy.currency;
      }
    }
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
      // ── frozen-income debts ──────────────────────────────────
      //
      // Opened when the machine lands, closed when the seat answers. The gap
      // between the two IS the damage the ability does, so the gap is what is
      // scored.
      case "slotMachineOpened":
      case "rouletteOpened": {
        this.debtOpenedAt.set(event.playerId, event.tick);
        break;
      }
      case "slotSpun":
      case "rouletteSettled": {
        const opened = this.debtOpenedAt.get(event.playerId);
        if (opened !== undefined) {
          this.debtOpenedAt.delete(event.playerId);
          const seat = this.seat(event.playerId);
          seat.debtsCleared += 1;
          // Full credit for answering at once, decaying to nothing over
          // DEBT_PATIENCE. A seat that pulls the lever immediately keeps its
          // whole economy; one that waits ten seconds has already paid.
          const waited = Math.max(0, event.tick - opened);
          seat.debtPromptness += Math.max(0, 1 - waited / DEBT_PATIENCE);
        }
        break;
      }
      case "crawlerSquashed": {
        // No open/close pair to time: each click is its own act, and the swarm
        // only stops draining when a bug actually DIES. So kills are what
        // count, and a click that finishes one is worth full credit.
        if (event.killed) {
          const seat = this.seat(event.playerId);
          seat.debtsCleared += 1;
          seat.debtPromptness += 1;
        }
        break;
      }
      case "shieldGained": {
        this.shielded.add(event.playerId);
        // A shield bought while under a shield-ending siege IS the counterplay,
        // so it is credited at the moment it lands rather than inferred later.
        if (this.besieged.has(event.playerId)) {
          this.seat(event.playerId).siegesLifted += 1;
          this.besieged.delete(event.playerId);
        }
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
        if (SHIELD_ENDED_STATUSES.has(event.statusId)) this.besieged.add(event.targetId);
        break;
      }
      case "statusExpired": {
        if (SPAM_EXEMPT_STATUSES.has(event.statusId)) this.exempt.delete(event.playerId);
        if (SHIELD_ENDED_STATUSES.has(event.statusId)) this.besieged.delete(event.playerId);
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
