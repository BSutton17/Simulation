import type { Match } from "../../src/match/Match.js";
import type { GameplayEvent } from "../../src/engine/events.js";
import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import { ECONOMY } from "../../src/data/balance.js";
import type { MatchRecord, SimulationObserver } from "./types.js";

/**
 * Match telemetry (Telemetry Foundation, Part 1).
 *
 * A TelemetryCollector is a SimulationObserver that records EVERYTHING that
 * happened in one match, per seat, at full granularity — the raw "what
 * happened?" layer that the analytics engine (Part 2, metrics.ts) turns into
 * balance insight. Like the analytics framework (#207) it derives all of it
 * from the gameplay-event stream (#204) plus per-tick state sampling; it never
 * re-implements gameplay math.
 *
 * One collector instance per match. The produced `MatchTelemetry` is attached
 * to that match's MatchRecord (see runHeadlessMatch).
 */

/** How often the time-series (HP, cumulative damage, gold) are sampled, in
 *  ticks (5 s at 20 t/s). */
export const SAMPLE_INTERVAL_TICKS = 100;

/** Passive event causes the engine tags, so telemetry can attribute them
 *  discretely. (Status-proc passives like Ice's Cold Embrace apply statuses
 *  and are attributed under the status, not here.) */
const PASSIVE_CAUSES = new Set(["aftershock", "thorns", "shieldOnDamageDealt"]);

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface DamageTelemetry {
  total: number;
  toShield: number;
  toCastle: number;
  overkill: number;
  crits: number;
  byAbility: Record<string, number>;
  byUltimate: Record<string, number>;
  byStatus: Record<string, number>;
  byPassive: Record<string, number>;
  byReflection: number;
}

export interface HealingTelemetry {
  effective: number;
  overheal: number;
  byCause: Record<string, number>;
}

export interface EconomyTelemetry {
  incomeEarned: number;
  incomeDenied: number;
  goldFloatedAvg: number;
  spent: {
    citizens: number;
    upgrades: number;
    unlocks: number;
    casts: number;
    repairs: number;
    shields: number;
    total: number;
  };
  /** Purchase COUNTS (the `spent.*` fields above are gold). */
  citizensBought: number;
  unlocksPurchased: number;
  upgradesPurchased: number;
  /** Total shield HP gained (purchases + passives + abilities). */
  shieldGained: number;
  /** Average citizen headcount over the seat's lifetime. */
  citizensAvg: number;
  /** Citizen headcount at match end. */
  citizensFinal: number;
}

export interface AbilityUsageTelemetry {
  castCount: number;
  failedCasts: number;
  firstCastTick: number | null;
  averageCastIntervalTicks: number | null;
  cooldownIdleTicks: number;
  /** Successful casts by ability id. */
  byAbility: Record<string, number>;
  /** Gold spent casting each ability. */
  goldByAbility: Record<string, number>;
  /** Sum of targets struck across casts of each ability. */
  targetsByAbility: Record<string, number>;
  /** Killing blows landed by each ability. */
  killingBlowsByAbility: Record<string, number>;
}

export interface CombatTelemetry {
  kills: number;
  died: boolean;
  diedAtTick: number | null;
  ownShieldsDestroyed: number;
  enemyShieldsDestroyed: number;
  citizensGained: number;
  citizensLost: number;
  finalHp: number;
  /** Ticks survived (death tick, or the match end for survivors). */
  survivedTicks: number;
}

/** One always-on passive's contribution, attributed by its event cause. */
export interface PassiveContribution {
  triggers: number;
  damage: number;
  shield: number;
  heal: number;
}

/** Parallel time series, all sampled at the same ticks. */
export interface TimelineTelemetry {
  sampleIntervalTicks: number;
  ticks: number[];
  hp: number[];
  /** Cumulative damage dealt by this seat at each sample. */
  damageDealt: number[];
  /** Treasury balance at each sample. */
  currency: number[];
}

export interface SeatTelemetry {
  id: string;
  name: string;
  kingdomId: string | null;
  damage: DamageTelemetry;
  healing: HealingTelemetry;
  economy: EconomyTelemetry;
  abilities: AbilityUsageTelemetry;
  combat: CombatTelemetry;
  /** Passive contributions keyed by cause tag (aftershock, thorns, …). */
  passives: Record<string, PassiveContribution>;
  /** Ability id → tick it was unlocked (the unlock timeline). */
  unlocks: Record<string, number>;
  timeline: TimelineTelemetry;
}

/**
 * How much VALUE a status created, per status id — objective facts only, never
 * a counterfactual (no "damage prevented"). Generic and status-agnostic: any
 * current or future status appears here automatically the first time it is
 * applied. See the collector for exactly how each field is attributed.
 */
export interface StatusEffectivenessTelemetry {
  /** Times the status was successfully applied (includes re-applications). */
  applications: number;
  /** Total ticks the status was active (union of active windows across bearers). */
  totalDurationTicks: number;
  /** totalDurationTicks ÷ applications (active time bought per application). */
  averageDurationTicks: number;
  /** Enemy attack casts denied while a bearer held this status. */
  attacksBlocked: number;
  /** Damage dealt to a bearer while this status was active on it — how much
   *  the field capitalized during the status (any source, any ability). */
  followUpDamage: number;
  /** Bearers eliminated while this status was active on them. */
  killsDuringStatus: number;
}

export interface MatchTelemetry {
  index: number;
  seed: number;
  endedAtTick: number;
  timedOut: boolean;
  winnerId: string | null;
  winnerKingdom: string | null;
  seats: SeatTelemetry[];
  /** Per-status effectiveness for this match, keyed by status id. */
  statusEffectiveness: Record<string, StatusEffectivenessTelemetry>;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

interface SeatState {
  id: string;
  name: string;
  kingdomId: string | null;
  damage: DamageTelemetry;
  healing: HealingTelemetry;
  economy: EconomyTelemetry;
  castCount: number;
  failedCasts: number;
  firstCastTick: number | null;
  lastCastTick: number | null;
  castGapSum: number;
  castGapCount: number;
  cooldownIdleTicks: number;
  abilityCasts: Record<string, number>;
  goldByAbility: Record<string, number>;
  targetsByAbility: Record<string, number>;
  killingBlowsByAbility: Record<string, number>;
  readySince: Map<string, number>;
  kills: number;
  diedAtTick: number | null;
  ownShieldsDestroyed: number;
  enemyShieldsDestroyed: number;
  citizensGained: number;
  citizensLost: number;
  finalHp: number;
  passives: Record<string, PassiveContribution>;
  unlocks: Record<string, number>;
  // Cumulative + sampling.
  damageDealtCum: number;
  timeline: TimelineTelemetry;
  incomeEarned: number;
  incomeDenied: number;
  goldFloatSum: number;
  citizensSum: number;
  citizensFinal: number;
  ticksAlive: number;
}

const emptyDamage = (): DamageTelemetry => ({
  total: 0, toShield: 0, toCastle: 0, overkill: 0, crits: 0,
  byAbility: {}, byUltimate: {}, byStatus: {}, byPassive: {}, byReflection: 0,
});

const emptyEconomy = (): EconomyTelemetry => ({
  incomeEarned: 0, incomeDenied: 0, goldFloatedAvg: 0,
  spent: { citizens: 0, upgrades: 0, unlocks: 0, casts: 0, repairs: 0, shields: 0, total: 0 },
  citizensBought: 0, unlocksPurchased: 0, upgradesPurchased: 0, shieldGained: 0,
  citizensAvg: 0, citizensFinal: 0,
});

const passive = (map: Record<string, PassiveContribution>, cause: string): PassiveContribution => {
  return (map[cause] ??= { triggers: 0, damage: 0, shield: 0, heal: 0 });
};

/** Match-level accumulator for one status's effectiveness. */
interface StatusEffAcc {
  applications: number;
  totalDurationTicks: number;
  attacksBlocked: number;
  followUpDamage: number;
  killsDuringStatus: number;
}

export class TelemetryCollector implements SimulationObserver {
  private seats = new Map<string, SeatState>();
  private index = 0;
  private seed = 0;
  /** The last seat, and cause, to damage each target — used to attribute kills,
   *  killing blows, and enemy-shield breaks, which the events do not carry. */
  private lastDamager = new Map<string, string>();
  private lastDamageCause = new Map<string, string>();
  /** Per-status effectiveness (match level), and the active-status windows it
   *  is derived from: playerId → statusId → tick the current window opened. */
  private statusEff = new Map<string, StatusEffAcc>();
  private activeStatus = new Map<string, Map<string, number>>();

  /** Fetch/create a status's accumulator. */
  private eff(statusId: string): StatusEffAcc {
    let a = this.statusEff.get(statusId);
    if (!a) {
      a = { applications: 0, totalDurationTicks: 0, attacksBlocked: 0, followUpDamage: 0, killsDuringStatus: 0 };
      this.statusEff.set(statusId, a);
    }
    return a;
  }

  onMatchStart(match: Match, index: number, seed: number): void {
    this.index = index;
    this.seed = seed;
    this.seats = new Map();
    this.lastDamager = new Map();
    this.lastDamageCause = new Map();
    this.statusEff = new Map();
    this.activeStatus = new Map();
    for (const p of match.gameState!.getPlayers()) {
      this.seats.set(p.id, {
        id: p.id, name: p.name, kingdomId: p.kingdomId,
        damage: emptyDamage(),
        healing: { effective: 0, overheal: 0, byCause: {} },
        economy: emptyEconomy(),
        castCount: 0, failedCasts: 0, firstCastTick: null, lastCastTick: null,
        castGapSum: 0, castGapCount: 0, cooldownIdleTicks: 0,
        abilityCasts: {}, goldByAbility: {}, targetsByAbility: {}, killingBlowsByAbility: {},
        readySince: new Map(),
        kills: 0, diedAtTick: null, ownShieldsDestroyed: 0, enemyShieldsDestroyed: 0,
        citizensGained: 0, citizensLost: 0, finalHp: p.castle.hp,
        passives: {}, unlocks: {},
        damageDealtCum: 0,
        timeline: { sampleIntervalTicks: SAMPLE_INTERVAL_TICKS, ticks: [0], hp: [p.castle.hp], damageDealt: [0], currency: [p.economy.currency] },
        incomeEarned: 0, incomeDenied: 0, goldFloatSum: 0,
        citizensSum: 0, citizensFinal: p.economy.citizens, ticksAlive: 0,
      });
    }
  }

  onEvent(event: GameplayEvent): void {
    switch (event.type) {
      case "damage": {
        this.lastDamager.set(event.targetId, event.sourceId);
        this.lastDamageCause.set(event.targetId, event.cause);
        const src = this.seats.get(event.sourceId);
        if (src) {
          const d = src.damage;
          d.total += event.amount;
          d.toShield += event.absorbedByShield;
          d.toCastle += event.dealtToHp;
          d.overkill += event.overkill;
          if (event.crit) d.crits += 1;
          src.damageDealtCum += event.amount;
          bucketDamage(d, event.cause, event.amount);
          if (PASSIVE_CAUSES.has(event.cause)) {
            const pc = passive(src.passives, event.cause);
            pc.triggers += 1;
            pc.damage += event.amount;
          }
        }
        // Status effectiveness: credit follow-up damage to every status active
        // on the target — how much the field capitalized while it was affected.
        const active = this.activeStatus.get(event.targetId);
        if (active) for (const statusId of active.keys()) this.eff(statusId).followUpDamage += event.amount;
        break;
      }
      case "heal": {
        const t = this.seats.get(event.targetId);
        if (t) {
          t.healing.effective += event.amount;
          t.healing.overheal += event.overheal;
          t.healing.byCause[event.cause] = (t.healing.byCause[event.cause] ?? 0) + event.amount;
        }
        break;
      }
      case "shieldGained": {
        const t = this.seats.get(event.playerId);
        if (!t) break;
        t.economy.shieldGained += event.amount;
        if (PASSIVE_CAUSES.has(event.cause)) {
          const pc = passive(t.passives, event.cause);
          pc.triggers += 1;
          pc.shield += event.amount;
        }
        break;
      }
      case "shieldDestroyed": {
        const owner = this.seats.get(event.playerId);
        if (owner) owner.ownShieldsDestroyed += 1;
        const breakerId = this.lastDamager.get(event.playerId);
        const breaker = breakerId ? this.seats.get(breakerId) : undefined;
        if (breaker && breakerId !== event.playerId) breaker.enemyShieldsDestroyed += 1;
        break;
      }
      case "abilityCast": {
        const s = this.seats.get(event.casterId);
        if (!s) break;
        s.castCount += 1;
        s.abilityCasts[event.abilityId] = (s.abilityCasts[event.abilityId] ?? 0) + 1;
        s.goldByAbility[event.abilityId] = (s.goldByAbility[event.abilityId] ?? 0) + event.cost;
        s.targetsByAbility[event.abilityId] =
          (s.targetsByAbility[event.abilityId] ?? 0) + event.targetIds.length;
        s.economy.spent.casts += event.cost;
        if (s.firstCastTick === null) s.firstCastTick = event.tick;
        if (s.lastCastTick !== null) {
          s.castGapSum += event.tick - s.lastCastTick;
          s.castGapCount += 1;
        }
        s.lastCastTick = event.tick;
        const since = s.readySince.get(event.abilityId);
        if (since !== undefined) {
          s.cooldownIdleTicks += Math.max(0, event.tick - since);
          s.readySince.delete(event.abilityId);
        }
        break;
      }
      case "castFailed": {
        const s = this.seats.get(event.casterId);
        if (s) s.failedCasts += 1;
        // Status effectiveness: a cast the engine denied because of an active
        // status counts as an attack that status blocked (generic — attributed
        // to whichever status the engine named).
        if (event.statusId) this.eff(event.statusId).attacksBlocked += 1;
        break;
      }
      case "statusApplied": {
        this.eff(event.statusId).applications += 1;
        // Open an active window on the fresh application; a refresh (already
        // active) keeps the original window so duration stays continuous.
        let active = this.activeStatus.get(event.targetId);
        if (!active) { active = new Map(); this.activeStatus.set(event.targetId, active); }
        if (!active.has(event.statusId)) active.set(event.statusId, event.tick);
        break;
      }
      case "statusExpired": {
        const active = this.activeStatus.get(event.playerId);
        const start = active?.get(event.statusId);
        if (active && start !== undefined) {
          this.eff(event.statusId).totalDurationTicks += event.tick - start;
          active.delete(event.statusId);
        }
        break;
      }
      case "cooldownReady": {
        const s = this.seats.get(event.playerId);
        if (s && !s.readySince.has(event.abilityId)) {
          s.readySince.set(event.abilityId, event.tick);
        }
        break;
      }
      case "purchase": {
        const s = this.seats.get(event.playerId);
        if (!s) break;
        const spent = s.economy.spent;
        switch (event.kind) {
          case "citizen": spent.citizens += event.cost; s.economy.citizensBought += 1; break;
          case "upgrade": spent.upgrades += event.cost; s.economy.upgradesPurchased += 1; break;
          case "unlock":
            spent.unlocks += event.cost;
            s.economy.unlocksPurchased += 1;
            if (event.itemId) {
              s.unlocks[event.itemId] = event.tick;
              if (!s.readySince.has(event.itemId)) s.readySince.set(event.itemId, event.tick);
            }
            break;
          case "repair": spent.repairs += event.cost; break;
          case "shield": spent.shields += event.cost; break;
        }
        break;
      }
      case "citizensChanged": {
        const s = this.seats.get(event.playerId);
        if (!s) break;
        if (event.delta > 0) s.citizensGained += event.delta;
        else s.citizensLost += -event.delta;
        break;
      }
      case "eliminated": {
        const victim = this.seats.get(event.playerId);
        if (victim) victim.diedAtTick = event.tick;
        const killerId = this.lastDamager.get(event.playerId);
        const killer = killerId ? this.seats.get(killerId) : undefined;
        if (killer && killerId !== event.playerId) {
          killer.kills += 1;
          // Attribute the finishing blow to the ability that dealt the last hit,
          // when it was a direct ability (not a DoT/passive).
          const cause = this.lastDamageCause.get(event.playerId);
          if (cause && ALL_ABILITIES[cause]) {
            killer.killingBlowsByAbility[cause] =
              (killer.killingBlowsByAbility[cause] ?? 0) + 1;
          }
        }
        // Status effectiveness: credit a kill to every status active on the
        // victim at death, and close its window (statuses stop at elimination).
        const active = this.activeStatus.get(event.playerId);
        if (active) {
          for (const [statusId, start] of active) {
            const a = this.eff(statusId);
            a.killsDuringStatus += 1;
            a.totalDurationTicks += event.tick - start;
          }
          active.clear();
        }
        break;
      }
      default:
        break;
    }
  }

  onTick(match: Match, tick: number): void {
    const state = match.gameState!;
    for (const s of this.seats.values()) {
      const p = state.getPlayer(s.id);
      if (!p) continue;
      s.finalHp = p.castle.hp;
      if (tick % SAMPLE_INTERVAL_TICKS === 0) {
        s.timeline.ticks.push(tick);
        s.timeline.hp.push(p.castle.hp);
        s.timeline.damageDealt.push(s.damageDealtCum);
        s.timeline.currency.push(round(p.economy.currency));
      }
      s.citizensFinal = p.economy.citizens;
      if (p.eliminated) continue;
      s.ticksAlive += 1;
      s.incomeEarned += p.economy.incomePerTick;
      const baseline = p.economy.citizens * ECONOMY.INCOME_PER_CITIZEN;
      if (baseline > p.economy.incomePerTick) s.incomeDenied += baseline - p.economy.incomePerTick;
      s.goldFloatSum += p.economy.currency;
      s.citizensSum += p.economy.citizens;
    }
  }

  finalize(record: MatchRecord, endedAtTick: number): MatchTelemetry {
    const seats: SeatTelemetry[] = [];
    for (const s of this.seats.values()) {
      for (const since of s.readySince.values()) {
        s.cooldownIdleTicks += Math.max(0, endedAtTick - since);
      }
      const spent = s.economy.spent;
      spent.total = spent.citizens + spent.upgrades + spent.unlocks + spent.casts + spent.repairs + spent.shields;
      seats.push({
        id: s.id, name: s.name, kingdomId: s.kingdomId,
        damage: s.damage,
        healing: s.healing,
        economy: {
          ...s.economy,
          incomeEarned: round(s.incomeEarned),
          incomeDenied: round(s.incomeDenied),
          goldFloatedAvg: s.ticksAlive > 0 ? round(s.goldFloatSum / s.ticksAlive) : 0,
          citizensAvg: s.ticksAlive > 0 ? round(s.citizensSum / s.ticksAlive) : s.citizensFinal,
          citizensFinal: s.citizensFinal,
        },
        abilities: {
          castCount: s.castCount,
          failedCasts: s.failedCasts,
          firstCastTick: s.firstCastTick,
          averageCastIntervalTicks: s.castGapCount > 0 ? Math.round(s.castGapSum / s.castGapCount) : null,
          cooldownIdleTicks: s.cooldownIdleTicks,
          byAbility: s.abilityCasts,
          goldByAbility: s.goldByAbility,
          targetsByAbility: s.targetsByAbility,
          killingBlowsByAbility: s.killingBlowsByAbility,
        },
        combat: {
          kills: s.kills,
          died: s.diedAtTick !== null,
          diedAtTick: s.diedAtTick,
          ownShieldsDestroyed: s.ownShieldsDestroyed,
          enemyShieldsDestroyed: s.enemyShieldsDestroyed,
          citizensGained: s.citizensGained,
          citizensLost: s.citizensLost,
          finalHp: s.finalHp,
          survivedTicks: s.diedAtTick ?? endedAtTick,
        },
        passives: s.passives,
        unlocks: s.unlocks,
        timeline: s.timeline,
      });
    }

    // Close any status windows still open at match end, then finalize per-status
    // effectiveness (average = active time per application).
    for (const active of this.activeStatus.values()) {
      for (const [statusId, start] of active) {
        this.eff(statusId).totalDurationTicks += Math.max(0, endedAtTick - start);
      }
    }
    const statusEffectiveness: Record<string, StatusEffectivenessTelemetry> = {};
    for (const [statusId, a] of this.statusEff) {
      statusEffectiveness[statusId] = {
        applications: a.applications,
        totalDurationTicks: a.totalDurationTicks,
        averageDurationTicks: a.applications > 0 ? Math.round(a.totalDurationTicks / a.applications) : 0,
        attacksBlocked: a.attacksBlocked,
        followUpDamage: a.followUpDamage,
        killsDuringStatus: a.killsDuringStatus,
      };
    }

    return {
      index: this.index,
      seed: this.seed,
      endedAtTick,
      timedOut: record.timedOut,
      winnerId: record.winnerId,
      winnerKingdom: record.winnerKingdom,
      seats,
      statusEffectiveness,
    };
  }
}

function bucketDamage(d: DamageTelemetry, cause: string, amount: number): void {
  if (cause.startsWith("status:")) {
    const id = cause.slice("status:".length);
    d.byStatus[id] = (d.byStatus[id] ?? 0) + amount;
  } else if (cause === "thorns") {
    d.byReflection += amount;
  } else if (cause === "aftershock") {
    d.byPassive[cause] = (d.byPassive[cause] ?? 0) + amount;
  } else if (ALL_ABILITIES[cause]?.kind === "ultimate") {
    d.byUltimate[cause] = (d.byUltimate[cause] ?? 0) + amount;
  } else {
    d.byAbility[cause] = (d.byAbility[cause] ?? 0) + amount;
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
