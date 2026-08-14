import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import { KINGDOM_ABILITIES } from "../../src/data/kingdomAbilities.js";
import { KINGDOM_PASSIVES } from "../../src/data/kingdoms.js";
import { resolveAbility } from "../../src/engine/abilities.js";
import type { StatusEffectDefinition } from "../../src/engine/status.js";
import { TICK } from "../../src/data/balance.js";
import type { MatchRecord } from "./types.js";
import type { MatchTelemetry, SeatTelemetry } from "./telemetry.js";

/**
 * Analytics engine (Part 2 — the "why did it happen?" layer).
 *
 * Turns raw match telemetry (Part 1) into balance INSIGHT: per-ability
 * efficiency, per-kingdom source breakdowns and economy, per-passive
 * contribution, per-match timelines, and a plain-language explanation of why a
 * kingdom won. Everything here is a pure transform over telemetry — it reads no
 * gameplay state and re-implements no gameplay math.
 */

// ---------------------------------------------------------------------------
// Reference data (ability → kingdom, cooldown seconds) — read from metadata.
// ---------------------------------------------------------------------------

const ABILITY_KINGDOM: Record<string, string> = {};
for (const [kingdomId, abilities] of Object.entries(KINGDOM_ABILITIES)) {
  for (const a of abilities) ABILITY_KINGDOM[a.id] = kingdomId;
}

/** status id → the kingdom that applies it, built by walking the ability and
 *  passive data (statuses are kingdom-exclusive). Lets status metrics be
 *  attributed without any hardcoded status list. */
const STATUS_KINGDOM: Record<string, string> = {};
{
  const visit = (kingdomId: string, s: StatusEffectDefinition | undefined): void => {
    if (!s || STATUS_KINGDOM[s.id]) return;
    STATUS_KINGDOM[s.id] = kingdomId;
    visit(kingdomId, s.onExpireStatus?.status);
    visit(kingdomId, s.onHitRetaliate?.status);
  };
  for (const [kingdomId, abilities] of Object.entries(KINGDOM_ABILITIES)) {
    for (const ab of abilities) {
      for (const eff of ab.effects) visit(kingdomId, eff.params.status);
      for (const tier of ab.upgradePath ?? []) {
        for (const ep of tier.changes.effectParams ?? []) visit(kingdomId, ep?.status ?? undefined);
        for (const ae of tier.changes.addEffects ?? []) visit(kingdomId, ae.params.status);
      }
    }
  }
  for (const [kingdomId, passives] of Object.entries(KINGDOM_PASSIVES)) {
    for (const p of passives) if ("status" in p) visit(kingdomId, p.status as StatusEffectDefinition);
  }
}

/** Effective downtime of an ability in seconds — its cooldown, or for a
 *  charge ability the time to regenerate one charge. Floored at one tick. */
function cooldownSeconds(abilityId: string): number {
  const def = ALL_ABILITIES[abilityId];
  if (!def) return 1 / TICK.RATE;
  const eff = resolveAbility(def, 0);
  const ticks = eff.chargeSystem
    ? eff.chargeSystem.rechargeTicks
    : Math.max(1, eff.cooldownTicks);
  return Math.max(1, ticks) / TICK.RATE;
}

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Pull the telemetry out of a batch of match records (skips any run that had
 *  telemetry disabled). */
export function telemetryOf(records: MatchRecord[]): MatchTelemetry[] {
  return records.map((r) => r.telemetry).filter((t): t is MatchTelemetry => !!t);
}

// ---------------------------------------------------------------------------
// Ability metrics
// ---------------------------------------------------------------------------

export interface AbilityMetrics {
  abilityId: string;
  name: string;
  kingdomId: string;
  kind: string;
  casts: number;
  /** Direct damage + effective healing credited to this ability. */
  totalContribution: number;
  totalDamage: number;
  totalHealing: number;
  damagePerCast: number;
  damagePerGold: number;
  /** Damage per second of the ability's cooldown/downtime (throughput). */
  damagePerCooldownSecond: number;
  averageTargetCount: number;
  killingBlows: number;
  /** Fraction of casts that landed a killing blow. */
  killParticipation: number;
}

/** Per-ability efficiency across a batch of matches. */
export function abilityMetrics(telemetry: MatchTelemetry[]): AbilityMetrics[] {
  interface Acc {
    casts: number; damage: number; healing: number; gold: number;
    targets: number; killingBlows: number;
  }
  const acc = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) { a = { casts: 0, damage: 0, healing: 0, gold: 0, targets: 0, killingBlows: 0 }; acc.set(id, a); }
    return a;
  };

  for (const match of telemetry) {
    for (const seat of match.seats) {
      for (const [id, n] of Object.entries(seat.abilities.byAbility)) get(id).casts += n;
      for (const [id, g] of Object.entries(seat.abilities.goldByAbility)) get(id).gold += g;
      for (const [id, t] of Object.entries(seat.abilities.targetsByAbility)) get(id).targets += t;
      for (const [id, k] of Object.entries(seat.abilities.killingBlowsByAbility)) get(id).killingBlows += k;
      for (const [id, d] of Object.entries(seat.damage.byAbility)) get(id).damage += d;
      for (const [id, d] of Object.entries(seat.damage.byUltimate)) get(id).damage += d;
      // Healing is credited by cause; ability heals use the ability id as cause.
      for (const [cause, h] of Object.entries(seat.healing.byCause)) {
        if (ALL_ABILITIES[cause]) get(cause).healing += h;
      }
    }
  }

  const out: AbilityMetrics[] = [];
  for (const [id, a] of acc) {
    if (a.casts === 0 && a.damage === 0 && a.healing === 0) continue;
    const cd = cooldownSeconds(id);
    const damagePerCast = div(a.damage, a.casts);
    out.push({
      abilityId: id,
      name: ALL_ABILITIES[id]?.name ?? id,
      kingdomId: ABILITY_KINGDOM[id] ?? "unknown",
      kind: ALL_ABILITIES[id]?.kind ?? "unknown",
      casts: a.casts,
      totalContribution: round(a.damage + a.healing),
      totalDamage: round(a.damage),
      totalHealing: round(a.healing),
      damagePerCast: round(damagePerCast),
      damagePerGold: round(div(a.damage, a.gold)),
      damagePerCooldownSecond: round(div(damagePerCast, cd)),
      averageTargetCount: round(div(a.targets, a.casts)),
      killingBlows: a.killingBlows,
      killParticipation: round(div(a.killingBlows, a.casts)),
    });
  }
  return out.sort((x, y) => y.totalContribution - x.totalContribution);
}

// ---------------------------------------------------------------------------
// Kingdom metrics
// ---------------------------------------------------------------------------

export interface Share { total: number; pct: number }

export interface KingdomMetrics {
  kingdomId: string;
  matches: number;
  wins: number;
  winRate: number;
  /** Damage grouped by source, each with its share of the kingdom's damage. */
  damageSources: {
    ability: Share; ultimate: Share; status: Share; passive: Share; reflection: Share;
  };
  /** Healing grouped by source cause, each with its share. */
  healingSources: Record<string, Share>;
  economy: {
    incomeEarnedAvg: number;
    goldSpentAvg: number;
    /** Fraction of earned income actually spent (vs floated). */
    utilizationPct: number;
    /** Total damage per gold spent — combat return on economy. */
    damagePerGold: number;
    floatedAvg: number;
  };
  /** Each ability's share of the kingdom's total casts. */
  abilityUsagePct: Record<string, number>;
  averageUpgrades: number;
  averageCitizens: number;
  averageSurvivalSeconds: number;
}

export function kingdomMetrics(telemetry: MatchTelemetry[]): KingdomMetrics[] {
  interface Acc {
    matches: number; wins: number;
    dmgAbility: number; dmgUltimate: number; dmgStatus: number; dmgPassive: number; dmgReflection: number;
    healByCause: Record<string, number>;
    incomeEarned: number; goldSpent: number; floated: number;
    casts: Record<string, number>; totalCasts: number;
    upgrades: number; citizens: number; survivalTicks: number;
  }
  const acc = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        matches: 0, wins: 0,
        dmgAbility: 0, dmgUltimate: 0, dmgStatus: 0, dmgPassive: 0, dmgReflection: 0,
        healByCause: {}, incomeEarned: 0, goldSpent: 0, floated: 0,
        casts: {}, totalCasts: 0, upgrades: 0, citizens: 0, survivalTicks: 0,
      };
      acc.set(id, a);
    }
    return a;
  };

  for (const match of telemetry) {
    for (const seat of match.seats) {
      const a = get(seat.kingdomId ?? "unknown");
      a.matches += 1;
      if (seat.id === match.winnerId) a.wins += 1;
      a.dmgAbility += sum(seat.damage.byAbility);
      a.dmgUltimate += sum(seat.damage.byUltimate);
      a.dmgStatus += sum(seat.damage.byStatus);
      a.dmgPassive += sum(seat.damage.byPassive);
      a.dmgReflection += seat.damage.byReflection;
      for (const [cause, h] of Object.entries(seat.healing.byCause)) {
        a.healByCause[cause] = (a.healByCause[cause] ?? 0) + h;
      }
      a.incomeEarned += seat.economy.incomeEarned;
      a.goldSpent += seat.economy.spent.total;
      a.floated += seat.economy.goldFloatedAvg;
      for (const [id, n] of Object.entries(seat.abilities.byAbility)) {
        a.casts[id] = (a.casts[id] ?? 0) + n;
        a.totalCasts += n;
      }
      a.upgrades += seat.economy.upgradesPurchased;
      a.citizens += seat.economy.citizensAvg;
      a.survivalTicks += seat.combat.survivedTicks;
    }
  }

  const out: KingdomMetrics[] = [];
  for (const [id, a] of acc) {
    const dmgTotal =
      a.dmgAbility + a.dmgUltimate + a.dmgStatus + a.dmgPassive + a.dmgReflection;
    const share = (v: number): Share => ({ total: round(v), pct: round(div(v, dmgTotal) * 100, 1) });
    const healTotal = sum(a.healByCause);
    const healingSources: Record<string, Share> = {};
    for (const [cause, v] of Object.entries(a.healByCause)) {
      healingSources[cause] = { total: round(v), pct: round(div(v, healTotal) * 100, 1) };
    }
    const abilityUsagePct: Record<string, number> = {};
    for (const [abId, n] of Object.entries(a.casts)) {
      abilityUsagePct[abId] = round(div(n, a.totalCasts) * 100, 1);
    }
    out.push({
      kingdomId: id,
      matches: a.matches,
      wins: a.wins,
      winRate: round(div(a.wins, a.matches), 3),
      damageSources: {
        ability: share(a.dmgAbility),
        ultimate: share(a.dmgUltimate),
        status: share(a.dmgStatus),
        passive: share(a.dmgPassive),
        reflection: share(a.dmgReflection),
      },
      healingSources,
      economy: {
        incomeEarnedAvg: round(div(a.incomeEarned, a.matches)),
        goldSpentAvg: round(div(a.goldSpent, a.matches)),
        utilizationPct: round(div(a.goldSpent, a.incomeEarned) * 100, 1),
        damagePerGold: round(div(dmgTotal, a.goldSpent)),
        floatedAvg: round(div(a.floated, a.matches)),
      },
      abilityUsagePct,
      averageUpgrades: round(div(a.upgrades, a.matches)),
      averageCitizens: round(div(a.citizens, a.matches)),
      averageSurvivalSeconds: round(div(a.survivalTicks, a.matches) / TICK.RATE),
    });
  }
  return out.sort((x, y) => y.winRate - x.winRate);
}

// ---------------------------------------------------------------------------
// Passive metrics
// ---------------------------------------------------------------------------

export interface PassiveMetrics {
  cause: string;
  kingdomId: string;
  triggers: number;
  damageGained: number;
  healingGained: number;
  shieldGained: number;
  contribution: number;
  /** Per match the passive's kingdom played. */
  triggersPerMatch: number;
  contributionPerMatch: number;
}

/** Which kingdom each tagged passive belongs to (for attribution + averaging). */
const PASSIVE_KINGDOM: Record<string, string> = {
  aftershock: "electricity",
  thorns: "nature",
  shieldOnDamageDealt: "earth",
};

export function passiveMetrics(telemetry: MatchTelemetry[]): PassiveMetrics[] {
  interface Acc { triggers: number; damage: number; shield: number; heal: number }
  const acc = new Map<string, Acc>();
  const kingdomMatches = new Map<string, number>();

  for (const match of telemetry) {
    for (const seat of match.seats) {
      const k = seat.kingdomId ?? "unknown";
      kingdomMatches.set(k, (kingdomMatches.get(k) ?? 0) + 1);
      for (const [cause, pc] of Object.entries(seat.passives)) {
        let a = acc.get(cause);
        if (!a) { a = { triggers: 0, damage: 0, shield: 0, heal: 0 }; acc.set(cause, a); }
        a.triggers += pc.triggers;
        a.damage += pc.damage;
        a.shield += pc.shield;
        a.heal += pc.heal;
      }
    }
  }

  const out: PassiveMetrics[] = [];
  for (const [cause, a] of acc) {
    const kingdomId = PASSIVE_KINGDOM[cause] ?? "unknown";
    const matches = kingdomMatches.get(kingdomId) ?? 0;
    const contribution = a.damage + a.shield + a.heal;
    out.push({
      cause,
      kingdomId,
      triggers: a.triggers,
      damageGained: round(a.damage),
      healingGained: round(a.heal),
      shieldGained: round(a.shield),
      contribution: round(contribution),
      triggersPerMatch: round(div(a.triggers, matches)),
      contributionPerMatch: round(div(contribution, matches)),
    });
  }
  return out.sort((x, y) => y.contribution - x.contribution);
}

// ---------------------------------------------------------------------------
// Status effectiveness metrics
// ---------------------------------------------------------------------------

export interface StatusMetrics {
  statusId: string;
  /** The kingdom that applies this status (from data). */
  kingdomId: string;
  applications: number;
  applicationsPerMatch: number;
  averageDurationSeconds: number;
  /** Enemy attack casts denied while a bearer held the status. */
  attacksBlocked: number;
  /** Damage dealt to bearers while the status was active on them. */
  followUpDamage: number;
  killsDuringStatus: number;
  /** Follow-up damage per attack this status blocked — the "payoff" of its
   *  control (0 when it blocks nothing). */
  followUpDamagePerBlock: number;
}

/** Per-status effectiveness across a batch — pure aggregation of the telemetry,
 *  inferring nothing. */
export function statusMetrics(telemetry: MatchTelemetry[]): StatusMetrics[] {
  interface Acc { applications: number; totalDuration: number; blocked: number; followUp: number; kills: number }
  const acc = new Map<string, Acc>();
  for (const match of telemetry) {
    for (const [id, s] of Object.entries(match.statusEffectiveness)) {
      let a = acc.get(id);
      if (!a) { a = { applications: 0, totalDuration: 0, blocked: 0, followUp: 0, kills: 0 }; acc.set(id, a); }
      a.applications += s.applications;
      a.totalDuration += s.totalDurationTicks;
      a.blocked += s.attacksBlocked;
      a.followUp += s.followUpDamage;
      a.kills += s.killsDuringStatus;
    }
  }
  const matches = telemetry.length;
  const out: StatusMetrics[] = [];
  for (const [id, a] of acc) {
    out.push({
      statusId: id,
      kingdomId: STATUS_KINGDOM[id] ?? "unknown",
      applications: a.applications,
      applicationsPerMatch: round(div(a.applications, matches)),
      averageDurationSeconds: round(div(a.totalDuration, a.applications) / TICK.RATE),
      attacksBlocked: a.blocked,
      followUpDamage: round(a.followUp),
      killsDuringStatus: a.kills,
      followUpDamagePerBlock: round(div(a.followUp, a.blocked)),
    });
  }
  return out.sort((x, y) => y.followUpDamage - x.followUpDamage);
}

// ---------------------------------------------------------------------------
// Match timelines
// ---------------------------------------------------------------------------

export interface MatchTimelines {
  index: number;
  seed: number;
  endedAtTick: number;
  sampleIntervalTicks: number;
  ticks: number[];
  seats: {
    id: string;
    kingdomId: string | null;
    /** Cumulative damage dealt at each sample. */
    damage: number[];
    /** Treasury balance at each sample. */
    economy: number[];
    /** Castle HP at each sample. */
    hp: number[];
    /** Ability id → tick unlocked (the unlock timeline). */
    unlocks: Record<string, number>;
  }[];
}

/** Package one match's telemetry into damage / economy / unlock timelines. */
export function matchTimelines(match: MatchTelemetry): MatchTimelines {
  return {
    index: match.index,
    seed: match.seed,
    endedAtTick: match.endedAtTick,
    sampleIntervalTicks: match.seats[0]?.timeline.sampleIntervalTicks ?? 0,
    ticks: match.seats[0]?.timeline.ticks ?? [],
    seats: match.seats.map((s) => ({
      id: s.id,
      kingdomId: s.kingdomId,
      damage: s.timeline.damageDealt,
      economy: s.timeline.currency,
      hp: s.timeline.hp,
      unlocks: s.unlocks,
    })),
  };
}

// ---------------------------------------------------------------------------
// "Why did a kingdom win?"
// ---------------------------------------------------------------------------

/** A plain-language explanation of one match's outcome, built from the metrics
 *  above. This is the Part 2 deliverable: the simulation explaining itself. */
export function explainMatch(match: MatchTelemetry): string {
  const winner = match.seats.find((s) => s.id === match.winnerId);
  const lines: string[] = [];
  const secs = (t: number) => `${Math.round(t / TICK.RATE)}s`;

  if (!winner) {
    lines.push(`Match ${match.index}: a draw at ${secs(match.endedAtTick)} — no kingdom survived.`);
    return lines.join("\n");
  }

  lines.push(
    `Match ${match.index}: ${winner.kingdomId} won at ${secs(match.endedAtTick)}, ending at ${Math.round(winner.combat.finalHp)} HP.`,
  );

  // Why: the winner's dominant damage source.
  const src = damageSourceShares(winner);
  const topSource = src[0];
  if (topSource && topSource.total > 0) {
    lines.push(
      `  • Its damage came mainly from ${topSource.label} (${topSource.pct}% of ${Math.round(winner.damage.total)} total).`,
    );
  }

  // Its most valuable ability by direct damage.
  const topAbility = topByValue(winner.damage.byAbility, winner.damage.byUltimate);
  if (topAbility) {
    lines.push(
      `  • Best ability: ${ALL_ABILITIES[topAbility.id]?.name ?? topAbility.id} — ${Math.round(topAbility.value)} damage over ${winner.abilities.byAbility[topAbility.id] ?? 0} casts.`,
    );
  }

  // Kills + shields cracked.
  if (winner.combat.kills > 0 || winner.combat.enemyShieldsDestroyed > 0) {
    lines.push(
      `  • Secured ${winner.combat.kills} elimination${winner.combat.kills === 1 ? "" : "s"} and broke ${winner.combat.enemyShieldsDestroyed} enemy shield${winner.combat.enemyShieldsDestroyed === 1 ? "" : "s"}.`,
    );
  }

  // Economy edge vs the field.
  const others = match.seats.filter((s) => s.id !== winner.id);
  const avgOtherIncome = div(others.reduce((n, s) => n + s.economy.incomeEarned, 0), others.length);
  if (winner.economy.incomeEarned > avgOtherIncome * 1.1) {
    lines.push(
      `  • Out-economied the field: ${Math.round(winner.economy.incomeEarned)} income earned vs ${Math.round(avgOtherIncome)} average, funding ${winner.abilities.castCount} casts.`,
    );
  }

  // Why the others lost: earliest death.
  const dead = others
    .filter((s) => s.combat.died)
    .sort((a, b) => (a.combat.diedAtTick ?? 0) - (b.combat.diedAtTick ?? 0));
  if (dead[0]) {
    lines.push(`  • First to fall: ${dead[0].kingdomId} at ${secs(dead[0].combat.diedAtTick ?? 0)}.`);
  }

  return lines.join("\n");
}

interface Labeled { label: string; total: number; pct: number }
function damageSourceShares(seat: SeatTelemetry): Labeled[] {
  const d = seat.damage;
  const total = d.total || 1;
  const parts: Labeled[] = [
    { label: "direct attacks", total: sum(d.byAbility), pct: 0 },
    { label: "ultimates", total: sum(d.byUltimate), pct: 0 },
    { label: "damage-over-time", total: sum(d.byStatus), pct: 0 },
    { label: "passives", total: sum(d.byPassive), pct: 0 },
    { label: "reflection", total: d.byReflection, pct: 0 },
  ];
  for (const p of parts) p.pct = round(div(p.total, total) * 100, 1);
  return parts.sort((a, b) => b.total - a.total);
}

function topByValue(
  ...maps: Record<string, number>[]
): { id: string; value: number } | null {
  let best: { id: string; value: number } | null = null;
  for (const map of maps) {
    for (const [id, value] of Object.entries(map)) {
      if (!best || value > best.value) best = { id, value };
    }
  }
  return best && best.value > 0 ? best : null;
}

function sum(record: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(record)) total += v;
  return total;
}
