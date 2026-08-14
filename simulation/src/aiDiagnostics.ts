/**
 * AI decision diagnostics.
 *
 * An opt-in trace of WHY the controller chose what it chose. The question this
 * exists to answer is "why was a legal, affordable ability never cast?" — which
 * outcome-level telemetry cannot answer, because an ability that is never
 * considered leaves no trace in the event stream.
 *
 * Off by default and free when off: every emit site is guarded by one null
 * check, exactly like the parameter registry's `param()` gate. Never enable it
 * for training batches — it allocates per decision.
 */

/** Why a candidate play was not cast (or that it was). */
export type DecisionOutcome =
  | "cast"
  | "locked"              // not purchased yet
  | "ultimateWindowClosed" // held for the profile's HP window
  | "zeroValue"           // the value model scored it 0 → filtered out entirely
  | "onCooldown"          // cooling down / no charge available
  | "unaffordable"        // priced out after floor + reservations
  | "heldForFinisher"     // skipped so a saved-for ultimate stays affordable
  | "notReached";         // treasury exhausted by earlier casts this decision

export interface DecisionEntry {
  abilityId: string;
  kind: string;
  outcome: DecisionOutcome;
  /** Heuristic value the model assigned (0 when it understands nothing). */
  value: number;
  cost: number;
  efficiency: number;
  readyInTicks: number;
  /** Effect types on this ability that `abilityValue()` has no case for. */
  unmodeledEffects?: string[];
  /** For `unaffordable`: what was spendable vs what was required. */
  spendable?: number;
  required?: number;
}

export interface DecisionTrace {
  tick: number;
  playerId: string;
  kingdomId: string | null;
  currency: number;
  /** Gold withheld by the abilities category for its next unlock/upgrade. */
  reserved: number;
  /** Gold withheld to keep a nearly-affordable finisher reachable. */
  hold: number;
  entries: DecisionEntry[];
}

let sink: DecisionTrace[] | null = null;

/** True when a trace is being collected — guards every emit site. */
export function aiTraceEnabled(): boolean {
  return sink !== null;
}

/** Record one decision point. Callers must check `aiTraceEnabled()` first so
 *  no work is done when tracing is off. */
export function recordDecision(trace: DecisionTrace): void {
  sink?.push(trace);
}

/**
 * Runs `fn` with decision tracing enabled and returns the traces alongside the
 * result. Scoped and exception-safe, so a trace can never leak into a
 * neighbouring run.
 */
export function withAiTrace<T>(fn: () => T): { result: T; traces: DecisionTrace[] } {
  const previous = sink;
  const traces: DecisionTrace[] = [];
  sink = traces;
  try {
    return { result: fn(), traces };
  } finally {
    sink = previous;
  }
}

/** Per-ability tally of decision outcomes, for reporting. */
export interface AbilitySummary {
  abilityId: string;
  kind: string;
  considered: number;
  cast: number;
  byOutcome: Record<string, number>;
  /** Highest value the model ever assigned across the trace. */
  peakValue: number;
  unmodeledEffects: string[];
}

/** Collapses a trace into a per-kingdom, per-ability outcome table. */
export function summarize(traces: DecisionTrace[]): Map<string, AbilitySummary[]> {
  const byKingdom = new Map<string, Map<string, AbilitySummary>>();
  for (const trace of traces) {
    const key = trace.kingdomId ?? "unknown";
    let abilities = byKingdom.get(key);
    if (!abilities) { abilities = new Map(); byKingdom.set(key, abilities); }
    for (const entry of trace.entries) {
      let row = abilities.get(entry.abilityId);
      if (!row) {
        row = {
          abilityId: entry.abilityId, kind: entry.kind, considered: 0, cast: 0,
          byOutcome: {}, peakValue: 0, unmodeledEffects: entry.unmodeledEffects ?? [],
        };
        abilities.set(entry.abilityId, row);
      }
      row.considered += 1;
      if (entry.outcome === "cast") row.cast += 1;
      row.byOutcome[entry.outcome] = (row.byOutcome[entry.outcome] ?? 0) + 1;
      if (entry.value > row.peakValue) row.peakValue = entry.value;
    }
  }
  const out = new Map<string, AbilitySummary[]>();
  for (const [kingdom, abilities] of byKingdom) out.set(kingdom, [...abilities.values()]);
  return out;
}
