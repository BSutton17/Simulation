import { ALL_ABILITIES } from "../../src/data/abilitiesRegistry.js";
import { KINGDOM_ABILITIES } from "../../src/data/kingdomAbilities.js";
import { TICK } from "../../src/data/balance.js";
import type { MatchRecord } from "./types.js";
import type { MatchTelemetry } from "./telemetry.js";
import { abilityMetrics, kingdomMetrics, statusMetrics, telemetryOf } from "./metrics.js";

/**
 * Intelligent Balance Assistant (Part 4 — the "recommendations" phase).
 *
 * Rule-based diagnostics — NOT machine learning — layered on the Part 2/3
 * analytics. It reads a batch of match telemetry and flags likely balance
 * issues (overpowered / underpowered kingdoms, dead abilities, economy leaks,
 * value-model gaps) with a concrete, human-actionable recommendation for each.
 * Every threshold is a plain constant a designer can reason about and override.
 */

export type ConcernCategory =
  | "overpowered"
  | "underpowered"
  | "economy"
  | "underused"
  | "control";

export type ConcernSeverity = "high" | "medium" | "low";

export interface BalanceConcern {
  category: ConcernCategory;
  severity: ConcernSeverity;
  /** What the concern is about — a kingdom or "Kingdom Ability". */
  subject: string;
  kingdomId?: string;
  abilityId?: string;
  /** The headline stat (e.g. "Win rate 86%"). */
  headline: string;
  /** The evidence / likely cause (e.g. "Poison contributes 47% of damage"). */
  detail: string;
  /** A short mechanical reason, when there is one (e.g. "Low value/gold"). */
  reason?: string;
  /** The recommended designer action. */
  recommendation: string;
  /** Sortable severity score (higher = more urgent). */
  score: number;
}

export interface BalanceDiagnostics {
  matches: number;
  kingdoms: number;
  /** Fair win share for the field (1 / kingdoms). */
  fairWinRate: number;
  /** Concerns, most urgent first. */
  concerns: BalanceConcern[];
}

export interface DiagnoseOptions {
  /**
   * The balanced win-rate baseline. Defaults to 1/kingdoms (a free-for-all
   * brawl). For matrix/duel data pass 0.5 — each 1v1 is 50/50 when balanced.
   */
  fairWinRate?: number;
  /** A kingdom is overpowered above fair × this (default 1.6). */
  overpoweredFactor?: number;
  /** …and at least this absolute win rate (default 0.33). */
  overpoweredMinWinRate?: number;
  /** A kingdom is underpowered below fair × this (default 0.4). */
  underpoweredFactor?: number;
  /** A single source ≥ this share of a kingdom's damage is its "primary cause"
   *  (default 0.4). */
  primaryCauseShare?: number;
  /** Gold floated (idle treasury) above this flags an economy leak (default 700). */
  floatedGoldThreshold?: number;
  /** …combined with casting less than this share of total spend (default 0.2). */
  castSpendShareThreshold?: number;
  /** An ability unlocked in ≥ this share of matches (default 0.6)… */
  unlockedShareThreshold?: number;
  /** …but making up ≤ this share of its kingdom's casts is "underused"
   *  (default 0.03). */
  usedShareThreshold?: number;
  /** A control status must block at least this many attacks to be judged on its
   *  payoff (default 5). */
  controlMinBlocks?: number;
  /** …and if its follow-up damage per blocked attack is below this, the control
   *  is "not converted to damage" (default 300). */
  controlLowPayoffPerBlock?: number;
}

const DEFAULTS: Required<Omit<DiagnoseOptions, "fairWinRate">> = {
  overpoweredFactor: 1.6,
  overpoweredMinWinRate: 0.33,
  underpoweredFactor: 0.4,
  primaryCauseShare: 0.4,
  floatedGoldThreshold: 700,
  castSpendShareThreshold: 0.2,
  unlockedShareThreshold: 0.6,
  usedShareThreshold: 0.03,
  controlMinBlocks: 5,
  controlLowPayoffPerBlock: 300,
};

const ABILITY_KINGDOM: Record<string, string> = {};
for (const [kingdomId, abilities] of Object.entries(KINGDOM_ABILITIES)) {
  for (const a of abilities) ABILITY_KINGDOM[a.id] = kingdomId;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A labelled damage source within a kingdom, for "primary cause" reporting. */
interface Source { label: string; damage: number; kind: string }

/** Flattens a kingdom's damage into individual labelled sources across the
 *  batch — each status, ability, ultimate, passive, and reflection separately. */
function kingdomSources(telemetry: MatchTelemetry[]): Map<string, { total: number; sources: Source[] }> {
  const out = new Map<string, { total: number; map: Map<string, Source> }>();
  const get = (k: string) => {
    let e = out.get(k);
    if (!e) { e = { total: 0, map: new Map() }; out.set(k, e); }
    return e;
  };
  const add = (e: { total: number; map: Map<string, Source> }, key: string, label: string, kind: string, dmg: number) => {
    e.total += dmg;
    const s = e.map.get(key) ?? { label, damage: 0, kind };
    s.damage += dmg;
    e.map.set(key, s);
  };
  for (const match of telemetry) {
    for (const seat of match.seats) {
      const e = get(seat.kingdomId ?? "unknown");
      for (const [id, d] of Object.entries(seat.damage.byStatus)) add(e, `status:${id}`, `${cap(id)} (DoT)`, "status", d);
      for (const [id, d] of Object.entries(seat.damage.byAbility)) add(e, id, ALL_ABILITIES[id]?.name ?? id, "ability", d);
      for (const [id, d] of Object.entries(seat.damage.byUltimate)) add(e, id, ALL_ABILITIES[id]?.name ?? id, "ultimate", d);
      for (const [id, d] of Object.entries(seat.damage.byPassive)) add(e, `passive:${id}`, `${cap(id)} (passive)`, "passive", d);
      if (seat.damage.byReflection > 0) add(e, "reflection", "Reflection", "reflection", seat.damage.byReflection);
    }
  }
  const flat = new Map<string, { total: number; sources: Source[] }>();
  for (const [k, e] of out) {
    flat.set(k, { total: e.total, sources: [...e.map.values()].sort((a, b) => b.damage - a.damage) });
  }
  return flat;
}

/** Per (kingdom, ability): unlock frequency and cast share of the kingdom. */
function kingdomAbilityUsage(telemetry: MatchTelemetry[]) {
  const seatMatches = new Map<string, number>(); // kingdom → seat-matches
  const unlocked = new Map<string, number>(); // `${k}|${ability}` → unlock count
  const casts = new Map<string, number>(); // `${k}|${ability}` → casts
  const kingdomCasts = new Map<string, number>(); // kingdom → total casts
  for (const match of telemetry) {
    for (const seat of match.seats) {
      const k = seat.kingdomId ?? "unknown";
      seatMatches.set(k, (seatMatches.get(k) ?? 0) + 1);
      for (const id of Object.keys(seat.unlocks)) {
        unlocked.set(`${k}|${id}`, (unlocked.get(`${k}|${id}`) ?? 0) + 1);
      }
      for (const [id, n] of Object.entries(seat.abilities.byAbility)) {
        casts.set(`${k}|${id}`, (casts.get(`${k}|${id}`) ?? 0) + n);
        kingdomCasts.set(k, (kingdomCasts.get(k) ?? 0) + n);
      }
    }
  }
  return { seatMatches, unlocked, casts, kingdomCasts };
}

/** Runs the rule-based diagnostics over a batch of telemetry. */
export function diagnose(
  telemetry: MatchTelemetry[],
  options: DiagnoseOptions = {},
): BalanceDiagnostics {
  const o = { ...DEFAULTS, ...options };
  const kMetrics = kingdomMetrics(telemetry);
  const aMetrics = new Map(abilityMetrics(telemetry).map((m) => [m.abilityId, m]));
  const sources = kingdomSources(telemetry);
  const usage = kingdomAbilityUsage(telemetry);
  const n = kMetrics.length;
  const fair = options.fairWinRate ?? (n > 0 ? 1 / n : 0);
  const concerns: BalanceConcern[] = [];

  // Field baselines, shared by several detectors.
  const survivalsSorted = kMetrics.map((k) => k.averageSurvivalSeconds).sort((a, b) => a - b);
  const medSurvival = median(survivalsSorted);
  const shieldPerMatch = kingdomShieldGained(telemetry);

  for (const k of kMetrics) {
    // --- Overpowered ---------------------------------------------------------
    if (k.winRate >= fair * o.overpoweredFactor && k.winRate >= o.overpoweredMinWinRate) {
      const src = sources.get(k.kingdomId);
      const top = src?.sources[0];
      const share = top && src!.total > 0 ? top.damage / src!.total : 0;
      const overBy = k.winRate / (fair || 1);
      let detail = `Wins ${overBy.toFixed(1)}× its fair share.`;
      let recommendation = `Reduce ${k.kingdomId}'s output or increase its costs.`;
      let reason: string | undefined;
      if (top && share >= o.primaryCauseShare) {
        detail = `${top.label} contributes ${pct(share)} of its damage.`;
        reason = `${top.label} dominates`;
        recommendation = `Investigate ${top.label} scaling (its share is ${pct(share)}).`;
      } else if (
        (medSurvival > 0 && k.averageSurvivalSeconds >= medSurvival * 1.3) ||
        (shieldPerMatch.get(k.kingdomId) ?? 0) > 3000
      ) {
        // No single damage source dominates → it wins by outlasting the field
        // (durability/shields), not by out-damaging it.
        const shield = shieldPerMatch.get(k.kingdomId) ?? 0;
        detail = `Wins by attrition, not damage — survives ${Math.round(k.averageSurvivalSeconds)}s (median ${Math.round(medSurvival)}s)${shield > 500 ? ` and generates ~${Math.round(shield)} shield/match` : ""}.`;
        reason = "Exceptional durability";
        recommendation = `Reduce ${k.kingdomId}'s durability (starting shield, shield regen, or HP) rather than its damage.`;
      }
      concerns.push({
        category: "overpowered",
        severity: k.winRate >= Math.max(fair * 2.5, 0.5) ? "high" : "medium",
        subject: cap(k.kingdomId),
        kingdomId: k.kingdomId,
        headline: `Win rate ${pct(k.winRate)}`,
        detail,
        reason,
        recommendation,
        // Proportional to how far above fair share — so a runaway kingdom
        // outranks any single dead ability regardless of field size.
        score: 200 * (k.winRate / (fair || 1) - 1),
      });
    }

    // --- Underpowered --------------------------------------------------------
    if (k.winRate <= fair * o.underpoweredFactor) {
      const survivalNote =
        k.averageSurvivalSeconds > 0 ? ` Survives only ${Math.round(k.averageSurvivalSeconds)}s.` : "";
      concerns.push({
        category: "underpowered",
        severity: k.winRate <= fair * 0.15 ? "high" : "medium",
        subject: cap(k.kingdomId),
        kingdomId: k.kingdomId,
        headline: `Win rate ${pct(k.winRate)}`,
        detail: `Only ${(k.winRate / (fair || 1)).toFixed(2)}× its fair share.${survivalNote} Damage per gold ${k.economy.damagePerGold}.`,
        reason: "Loses the field",
        recommendation: `Buff ${k.kingdomId} (more damage or survivability) or soften its weaknesses.`,
        score: 120 * (1 - k.winRate / (fair || 1)),
      });
    }

    // --- Economy leak --------------------------------------------------------
    const castSpendShare = k.economy.goldSpentAvg > 0
      ? castSpend(telemetry, k.kingdomId) / k.economy.goldSpentAvg
      : 0;
    if (
      k.economy.floatedAvg >= o.floatedGoldThreshold &&
      castSpendShare <= o.castSpendShareThreshold
    ) {
      concerns.push({
        category: "economy",
        severity: k.economy.floatedAvg >= o.floatedGoldThreshold * 1.5 ? "high" : "low",
        subject: cap(k.kingdomId),
        kingdomId: k.kingdomId,
        headline: `Floats ${Math.round(k.economy.floatedAvg)} gold`,
        detail: `Only ${pct(castSpendShare)} of spending goes to casting; the treasury sits idle.`,
        reason: "Under-spends on offense",
        recommendation: `Increase cast frequency — lower ability costs or income, so gold converts to pressure.`,
        score: 30 + k.economy.floatedAvg / 50,
      });
    }
  }

  // --- Underused abilities (unlocked but rarely cast), grouped per kingdom ---
  // One dead ability is noise; a kingdom whose whole premium kit is dead is a
  // real signal — so these are grouped and named rather than flooding the list.
  const dead = new Map<string, { ids: string[]; ultimate: boolean; worstOne: string }>();
  for (const [key, unlockCount] of usage.unlocked) {
    const [kingdomId, abilityId] = key.split("|");
    if (!kingdomId || !abilityId) continue;
    const matches = usage.seatMatches.get(kingdomId) ?? 0;
    if (matches === 0) continue;
    const unlockShare = unlockCount / matches;
    const casts = usage.casts.get(key) ?? 0;
    const totalCasts = usage.kingdomCasts.get(kingdomId) ?? 0;
    const useShare = totalCasts > 0 ? casts / totalCasts : 0;
    if (unlockShare < o.unlockedShareThreshold || useShare > o.usedShareThreshold) continue;
    const e = dead.get(kingdomId) ?? { ids: [], ultimate: false, worstOne: "" };
    e.ids.push(abilityId);
    if (ALL_ABILITIES[abilityId]?.kind === "ultimate") e.ultimate = true;
    dead.set(kingdomId, e);
  }
  for (const [kingdomId, e] of dead) {
    const names = e.ids.map((id) => ALL_ABILITIES[id]?.name ?? id);
    const best = bestDamagePerGold(aMetrics, kingdomId);
    concerns.push({
      category: "underused",
      severity: e.ids.length >= 3 ? "medium" : "low",
      subject: cap(kingdomId),
      kingdomId,
      headline: `${e.ids.length} abilit${e.ids.length === 1 ? "y" : "ies"} unlocked but never cast`,
      detail: `Bought but sidelined by the value-based AI: ${names.join(", ")}${e.ultimate ? " (including the ultimate)" : ""}. Best-cast option lands ${round1(best)} damage/gold.`,
      reason: "Never the highest-value play",
      recommendation: `Lower cost or raise impact so these enter the rotation — or confirm they are meant to be situational.`,
      score: 15 + e.ids.length * 5,
    });
  }

  // --- Can't-finish (survives well but rarely lands the kill) ----------------
  const killRates = kingdomKillsPerMatch(telemetry);
  const medKills = median([...killRates.values()].sort((a, b) => a - b));
  for (const k of kMetrics) {
    const kr = killRates.get(k.kingdomId) ?? 0;
    if (k.averageSurvivalSeconds >= medSurvival && kr < medKills * 0.5 && medKills > 0) {
      concerns.push({
        category: "underused",
        severity: "low",
        subject: cap(k.kingdomId),
        kingdomId: k.kingdomId,
        headline: `Outlasts but under-finishes`,
        detail: `Above-median survival (${Math.round(k.averageSurvivalSeconds)}s) yet only ${round1(kr)} kills/match vs ${round1(medKills)} median.`,
        reason: "Weak closing power",
        recommendation: `Give ${k.kingdomId} more burst or finishing pressure — it stalls games it should win.`,
        score: 25 + (medKills - kr) * 10,
      });
    }
  }

  // --- Control without payoff (status effectiveness) -------------------------
  // A crowd-control status that denies many attacks but whose bearers take
  // little follow-up damage is control the applier is not converting into a win.
  for (const s of statusMetrics(telemetry)) {
    if (s.attacksBlocked < o.controlMinBlocks) continue;
    if (s.followUpDamagePerBlock >= o.controlLowPayoffPerBlock) continue;
    const label = cap(s.statusId);
    concerns.push({
      category: "control",
      severity: s.followUpDamagePerBlock < o.controlLowPayoffPerBlock * 0.5 ? "medium" : "low",
      subject: label,
      kingdomId: s.kingdomId === "unknown" ? undefined : s.kingdomId,
      abilityId: undefined,
      headline: `Blocks ${s.attacksBlocked} attacks, ${Math.round(s.followUpDamage)} follow-up damage`,
      detail: `Only ${round1(s.followUpDamagePerBlock)} follow-up damage per attack blocked (avg ${round1(s.averageDurationSeconds)}s active) — the control is not being converted into damage.`,
      reason: "Control without payoff",
      recommendation: `Increase ${s.kingdomId}'s payoff DURING the control (damage that lands while ${label} is active) rather than extending the status.`,
      score: 20 + s.attacksBlocked,
    });
  }

  concerns.sort((a, b) => b.score - a.score);
  return { matches: telemetry.length, kingdoms: n, fairWinRate: round1(fair * 100) / 100, concerns };
}

function castSpend(telemetry: MatchTelemetry[], kingdomId: string): number {
  let cast = 0;
  let seatMatches = 0;
  for (const match of telemetry) {
    for (const seat of match.seats) {
      if ((seat.kingdomId ?? "unknown") !== kingdomId) continue;
      cast += seat.economy.spent.casts;
      seatMatches += 1;
    }
  }
  return seatMatches > 0 ? cast / seatMatches : 0;
}

function bestDamagePerGold(
  aMetrics: Map<string, { kingdomId: string; damagePerGold: number }>,
  kingdomId: string,
): number {
  let best = 0;
  for (const m of aMetrics.values()) {
    if (m.kingdomId === kingdomId && m.damagePerGold > best) best = m.damagePerGold;
  }
  return best;
}

/** Average shield HP gained per seat-match, by kingdom (durability signal). */
function kingdomShieldGained(telemetry: MatchTelemetry[]): Map<string, number> {
  const gained = new Map<string, number>();
  const matches = new Map<string, number>();
  for (const match of telemetry) {
    for (const seat of match.seats) {
      const k = seat.kingdomId ?? "unknown";
      gained.set(k, (gained.get(k) ?? 0) + seat.economy.shieldGained);
      matches.set(k, (matches.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<string, number>();
  for (const [k, n] of matches) out.set(k, n > 0 ? (gained.get(k) ?? 0) / n : 0);
  return out;
}

/** Average eliminations landed per seat-match, by kingdom. */
function kingdomKillsPerMatch(telemetry: MatchTelemetry[]): Map<string, number> {
  const kills = new Map<string, number>();
  const matches = new Map<string, number>();
  for (const match of telemetry) {
    for (const seat of match.seats) {
      const k = seat.kingdomId ?? "unknown";
      kills.set(k, (kills.get(k) ?? 0) + seat.combat.kills);
      matches.set(k, (matches.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<string, number>();
  for (const [k, n] of matches) out.set(k, n > 0 ? (kills.get(k) ?? 0) / n : 0);
  return out;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Convenience: diagnose straight from simulation records. */
export function diagnoseRecords(records: MatchRecord[], options?: DiagnoseOptions): BalanceDiagnostics {
  return diagnose(telemetryOf(records), options);
}

// ---------------------------------------------------------------------------
// Rendering — the automatic "TOP BALANCE CONCERNS" report.
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<ConcernCategory, string> = {
  overpowered: "OVERPOWERED",
  underpowered: "UNDERPOWERED",
  economy: "ECONOMY",
  underused: "AI / UNDERUSED",
  control: "CONTROL",
};

export function renderConcerns(diag: BalanceDiagnostics, limit = 8): string {
  const lines: string[] = [];
  lines.push("TOP BALANCE CONCERNS");
  lines.push(`(${diag.matches} matches · ${diag.kingdoms} kingdoms · fair win share ${pct(diag.fairWinRate)})`);
  lines.push("");
  if (diag.concerns.length === 0) {
    lines.push("  None — the field looks balanced within the current thresholds.");
    return lines.join("\n");
  }
  const shown = diag.concerns.slice(0, limit);
  shown.forEach((c, i) => {
    const sev = c.severity === "high" ? "!!" : c.severity === "medium" ? "! " : "  ";
    lines.push(`${sev}${i + 1}. ${c.subject} — ${CATEGORY_LABEL[c.category]}`);
    lines.push(`      ${c.headline}. ${c.detail}`);
    if (c.reason) lines.push(`      Reason: ${c.reason}.`);
    lines.push(`      → ${c.recommendation}`);
    lines.push("");
  });
  if (diag.concerns.length > limit) {
    lines.push(`  …and ${diag.concerns.length - limit} more.`);
  }
  return lines.join("\n").trimEnd();
}
