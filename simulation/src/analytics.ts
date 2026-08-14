import type { Match } from "../../src/match/Match.js";
import type { GameplayEvent } from "../../src/engine/events.js";
import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import type { MatchRecord, SimulationObserver } from "./types.js";

/**
 * Simulation analytics framework (ticket #207).
 *
 * An AnalyticsCollector is a SimulationObserver that derives every statistic
 * from the gameplay-event stream (#204) plus the final MatchRecord — it never
 * re-implements gameplay math. Attach one collector to any number of
 * simulation runs and it aggregates automatically across the whole batch
 * (and across batches: pass the same instance to consecutive runs).
 *
 * Aggregation is keyed by KINGDOM — the unit balance work cares about — but
 * every id it aggregates comes from data, never from hardcoded names.
 */

/** Per-kingdom aggregate across every seat that played the kingdom. */
export interface KingdomStats {
  kingdomId: string;
  /** Seat-matches played (a mirror match counts the kingdom twice). */
  matches: number;
  wins: number;
  winRate: number;
  /** Mean placement: 1 = winner; eliminated seats rank by death order. */
  averagePlacement: number;
  /** Times a seat of this kingdom was eliminated. */
  eliminations: number;

  damageDealt: number;
  damageTaken: number;
  criticalHits: number;
  healingReceived: number;
  shieldGained: number;
  /** Times this kingdom's shield was destroyed. */
  shieldsLost: number;

  /** Economy: gold spent by category plus citizen counts. */
  goldSpentOnCasts: number;
  goldSpentOnPurchases: number;
  citizensBought: number;
  citizensFinal: number;

  /** Casts per ability id, straight from abilityCast events. */
  abilityUsage: Record<string, number>;
  /** Multi-charge casts (2+ charges at once) — the combo mechanic in play. */
  comboCasts: number;
  unlocksPurchased: number;
  upgradesPurchased: number;

  /** Ticks each status spent active on this kingdom (uptime). */
  statusUptime: Record<string, number>;
  /** Accepted target switches made by this kingdom. */
  targetSwitches: number;
  /** How often each enemy kingdom was chosen as the target. */
  targetedKingdoms: Record<string, number>;
}

/** Whole-batch aggregate. */
export interface BatchAnalytics {
  matches: number;
  timeouts: number;
  totalTicks: number;
  averageDurationTicks: number;
  minDurationTicks: number;
  maxDurationTicks: number;
  kingdoms: Record<string, KingdomStats>;
}

function emptyKingdom(kingdomId: string): KingdomStats {
  return {
    kingdomId,
    matches: 0,
    wins: 0,
    winRate: 0,
    averagePlacement: 0,
    eliminations: 0,
    damageDealt: 0,
    damageTaken: 0,
    criticalHits: 0,
    healingReceived: 0,
    shieldGained: 0,
    shieldsLost: 0,
    goldSpentOnCasts: 0,
    goldSpentOnPurchases: 0,
    citizensBought: 0,
    citizensFinal: 0,
    abilityUsage: {},
    comboCasts: 0,
    unlocksPurchased: 0,
    upgradesPurchased: 0,
    statusUptime: {},
    targetSwitches: 0,
    targetedKingdoms: {},
  };
}

/** Per-seat transient tallies for the match in progress. */
interface SeatTally {
  damageDealt: number;
  damageTaken: number;
  criticalHits: number;
  healingReceived: number;
  shieldGained: number;
  shieldsLost: number;
  goldSpentOnCasts: number;
  goldSpentOnPurchases: number;
  citizensBought: number;
  abilityUsage: Record<string, number>;
  comboCasts: number;
  unlocksPurchased: number;
  upgradesPurchased: number;
  statusUptime: Record<string, number>;
  /** Open statuses: statusId → tick it became active. */
  openStatuses: Map<string, number>;
  targetSwitches: number;
  targetedIds: Record<string, number>;
}

const emptyTally = (): SeatTally => ({
  damageDealt: 0,
  damageTaken: 0,
  criticalHits: 0,
  healingReceived: 0,
  shieldGained: 0,
  shieldsLost: 0,
  goldSpentOnCasts: 0,
  goldSpentOnPurchases: 0,
  citizensBought: 0,
  abilityUsage: {},
  comboCasts: 0,
  unlocksPurchased: 0,
  upgradesPurchased: 0,
  statusUptime: {},
  openStatuses: new Map(),
  targetSwitches: 0,
  targetedIds: {},
});

/** Placements for one record: winner first, then later deaths, then survivors
 *  by remaining HP. Returns playerId → placement (1-based). */
function placements(record: MatchRecord): Map<string, number> {
  const ranked = [...record.players].sort((a, b) => {
    const aWin = a.id === record.winnerId ? 1 : 0;
    const bWin = b.id === record.winnerId ? 1 : 0;
    if (aWin !== bWin) return bWin - aWin;
    const aDead = a.eliminatedAtTick ?? Number.POSITIVE_INFINITY;
    const bDead = b.eliminatedAtTick ?? Number.POSITIVE_INFINITY;
    if (aDead !== bDead) return bDead - aDead; // later death = better
    return b.hp - a.hp; // surviving timeout seats rank by remaining HP
  });
  return new Map(ranked.map((p, i) => [p.id, i + 1]));
}

export class AnalyticsCollector implements SimulationObserver {
  private readonly kingdoms = new Map<string, KingdomStats>();
  private matches = 0;
  private timeouts = 0;
  private totalTicks = 0;
  private minTicks = Number.POSITIVE_INFINITY;
  private maxTicks = 0;
  private placementSum = new Map<string, number>(); // kingdomId → Σ placements

  /** Transient, reset per match. */
  private tallies = new Map<string, SeatTally>();
  private seatKingdom = new Map<string, string>();

  onMatchStart(match: Match): void {
    this.tallies = new Map();
    this.seatKingdom = new Map();
    for (const p of match.gameState!.getPlayers()) {
      this.tallies.set(p.id, emptyTally());
      this.seatKingdom.set(p.id, p.kingdomId ?? "unknown");
    }
  }

  onEvent(event: GameplayEvent): void {
    switch (event.type) {
      case "abilityCast": {
        const t = this.tallies.get(event.casterId);
        if (!t) return;
        t.abilityUsage[event.abilityId] = (t.abilityUsage[event.abilityId] ?? 0) + 1;
        t.goldSpentOnCasts += event.cost;
        if ((event.chargesUsed ?? 0) >= 2) t.comboCasts += 1;
        break;
      }
      case "damage": {
        const src = this.tallies.get(event.sourceId);
        if (src) {
          src.damageDealt += event.amount;
          if (event.crit) src.criticalHits += 1;
        }
        const dst = this.tallies.get(event.targetId);
        if (dst) dst.damageTaken += event.amount;
        break;
      }
      case "heal": {
        const t = this.tallies.get(event.targetId);
        if (t) t.healingReceived += event.amount;
        break;
      }
      case "shieldGained": {
        const t = this.tallies.get(event.playerId);
        if (t) t.shieldGained += event.amount;
        break;
      }
      case "shieldDestroyed": {
        const t = this.tallies.get(event.playerId);
        if (t) t.shieldsLost += 1;
        break;
      }
      case "purchase": {
        const t = this.tallies.get(event.playerId);
        if (!t) return;
        t.goldSpentOnPurchases += event.cost;
        if (event.kind === "citizen") t.citizensBought += 1;
        if (event.kind === "unlock") t.unlocksPurchased += 1;
        if (event.kind === "upgrade") t.upgradesPurchased += 1;
        break;
      }
      case "statusApplied": {
        const t = this.tallies.get(event.targetId);
        // Refreshes keep the original start; uptime is continuous.
        if (t && !t.openStatuses.has(event.statusId)) {
          t.openStatuses.set(event.statusId, event.tick);
        }
        break;
      }
      case "statusExpired": {
        const t = this.tallies.get(event.playerId);
        if (!t) return;
        const start = t.openStatuses.get(event.statusId);
        if (start !== undefined) {
          t.statusUptime[event.statusId] =
            (t.statusUptime[event.statusId] ?? 0) + (event.tick - start);
          t.openStatuses.delete(event.statusId);
        }
        break;
      }
      case "targetChanged": {
        const t = this.tallies.get(event.playerId);
        if (!t) return;
        t.targetSwitches += 1;
        const targetKingdom = this.seatKingdom.get(event.targetId) ?? "unknown";
        t.targetedIds[targetKingdom] = (t.targetedIds[targetKingdom] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  onMatchEnd(record: MatchRecord): void {
    this.matches += 1;
    if (record.timedOut) this.timeouts += 1;
    this.totalTicks += record.endedAtTick;
    this.minTicks = Math.min(this.minTicks, record.endedAtTick);
    this.maxTicks = Math.max(this.maxTicks, record.endedAtTick);

    const place = placements(record);
    for (const player of record.players) {
      const kingdomId = player.kingdomId ?? "unknown";
      if (!this.kingdoms.has(kingdomId)) {
        this.kingdoms.set(kingdomId, emptyKingdom(kingdomId));
      }
      const k = this.kingdoms.get(kingdomId)!;
      const t = this.tallies.get(player.id) ?? emptyTally();

      // Close statuses still active at match end.
      for (const [statusId, start] of t.openStatuses) {
        t.statusUptime[statusId] =
          (t.statusUptime[statusId] ?? 0) + (record.endedAtTick - start);
      }

      k.matches += 1;
      if (player.id === record.winnerId) k.wins += 1;
      if (player.eliminatedAtTick !== null) k.eliminations += 1;
      this.placementSum.set(
        kingdomId,
        (this.placementSum.get(kingdomId) ?? 0) + place.get(player.id)!,
      );

      k.damageDealt += t.damageDealt;
      k.damageTaken += t.damageTaken;
      k.criticalHits += t.criticalHits;
      k.healingReceived += t.healingReceived;
      k.shieldGained += t.shieldGained;
      k.shieldsLost += t.shieldsLost;
      k.goldSpentOnCasts += t.goldSpentOnCasts;
      k.goldSpentOnPurchases += t.goldSpentOnPurchases;
      k.citizensBought += t.citizensBought;
      k.citizensFinal += player.citizens;
      k.comboCasts += t.comboCasts;
      k.unlocksPurchased += t.unlocksPurchased;
      k.upgradesPurchased += t.upgradesPurchased;
      k.targetSwitches += t.targetSwitches;

      for (const [id, n] of Object.entries(t.abilityUsage)) {
        k.abilityUsage[id] = (k.abilityUsage[id] ?? 0) + n;
      }
      for (const [id, n] of Object.entries(t.statusUptime)) {
        k.statusUptime[id] = (k.statusUptime[id] ?? 0) + n;
      }
      for (const [id, n] of Object.entries(t.targetedIds)) {
        k.targetedKingdoms[id] = (k.targetedKingdoms[id] ?? 0) + n;
      }
    }
  }

  /** The batch aggregate so far (derived rates computed on demand). */
  snapshot(): BatchAnalytics {
    const kingdoms: Record<string, KingdomStats> = {};
    for (const [id, k] of this.kingdoms) {
      kingdoms[id] = {
        ...k,
        abilityUsage: { ...k.abilityUsage },
        statusUptime: { ...k.statusUptime },
        targetedKingdoms: { ...k.targetedKingdoms },
        winRate: k.matches > 0 ? k.wins / k.matches : 0,
        averagePlacement:
          k.matches > 0 ? (this.placementSum.get(id) ?? 0) / k.matches : 0,
      };
    }
    return {
      matches: this.matches,
      timeouts: this.timeouts,
      totalTicks: this.totalTicks,
      averageDurationTicks: this.matches > 0 ? this.totalTicks / this.matches : 0,
      minDurationTicks: this.matches > 0 ? this.minTicks : 0,
      maxDurationTicks: this.maxTicks,
      kingdoms,
    };
  }
}

/** Convenience: usage counts restricted to abilities of one kind — derived
 *  from ability METADATA, so it stays correct as content grows. */
export function usageByKind(
  stats: KingdomStats,
  kind: "attack" | "utility" | "ultimate",
): number {
  let total = 0;
  for (const [abilityId, count] of Object.entries(stats.abilityUsage)) {
    if (ALL_ABILITIES[abilityId]?.kind === kind) total += count;
  }
  return total;
}
