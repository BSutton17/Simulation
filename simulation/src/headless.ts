import { Match } from "../../src/match/Match.js";
import { createMatchConfig } from "../../src/match/matchConfig.js";
import { tickMatch } from "../../src/engine/tick.js";
import type { MatchPlayer } from "../../src/match/types.js";
import { mulberry32, deriveSeed } from "./rng.js";
import { TelemetryCollector } from "./telemetry.js";
import type {
  AIController,
  AIFactory,
  MatchRecord,
  PlayerSpec,
  SimulationObserver,
} from "./types.js";

/**
 * Headless match execution (ticket #201).
 *
 * A simulated match is EXACTLY a live match minus the transport: the same
 * `Match` + `GameState`, started through the same `createMatchConfig`
 * snapshot, advanced by the same `tickMatch` phases. There are no sockets, no
 * timers, and no rendering — one match is a plain synchronous loop, which is
 * what makes six-figure match counts feasible.
 */

/** Default per-match safety cap: 20 minutes of game time at 20 ticks/sec. */
export const DEFAULT_MAX_TICKS = 24_000;

export interface HeadlessCreateOptions {
  label?: string;
  /** Match-level RNG (#203) — the sole source of gameplay randomness. */
  rng?: () => number;
}

/** Builds a started, socketless Match from player specs. */
export function createHeadlessMatch(
  players: PlayerSpec[],
  options: HeadlessCreateOptions = {},
): Match {
  const match = new Match(options.label ?? "SIM", { rng: options.rng });
  players.forEach((spec, i) => {
    const seat: MatchPlayer = {
      id: `p${i}`,
      socketId: null, // headless: no transport behind this seat
      name: spec.name ?? `p${i}-${spec.kingdomId}`,
      kingdomId: spec.kingdomId,
      ready: true,
      connected: true,
    };
    match.addPlayer(seat);
  });
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  return match;
}

export interface HeadlessMatchOptions {
  players: PlayerSpec[];
  /** Seed for this match; every AI stream derives from it. */
  seed: number;
  maxTicks?: number;
  createAI: AIFactory;
  /** Zero-based index within the parent run (0 for standalone matches). */
  index?: number;
  observers?: SimulationObserver[];
  /** Collect and attach full match telemetry (default true). */
  telemetry?: boolean;
}

/** Snapshot a finished (or timed-out) match into a MatchRecord. */
function recordMatch(
  match: Match,
  index: number,
  seed: number,
  endedAtTick: number,
  timedOut: boolean,
): MatchRecord {
  const state = match.gameState!;
  const players = state.getPlayers().map((p) => ({
    id: p.id,
    name: p.name,
    kingdomId: p.kingdomId,
    hp: p.castle.hp,
    shield: p.castle.shield,
    citizens: p.economy.citizens,
    currency: p.economy.currency,
    eliminatedAtTick: p.eliminatedAtTick,
  }));
  const winner = players.find((p) => p.id === match.winnerId) ?? null;
  return {
    index,
    seed,
    winnerId: match.winnerId,
    winnerKingdom: winner?.kingdomId ?? null,
    endedAtTick,
    timedOut,
    players,
  };
}

/**
 * Runs one complete match to its end (or the tick cap).
 *
 * Per tick, in deterministic order: every living player's controller acts
 * (issuing engine calls — the drained-intent phase of GAME_TICK.md §2), then
 * `tickMatch` advances the world one tick. Identical seeds produce identical
 * matches because every dice roll flows through per-player seeded streams.
 */
export function runHeadlessMatch(options: HeadlessMatchOptions): MatchRecord {
  const {
    players,
    seed,
    maxTicks = DEFAULT_MAX_TICKS,
    createAI,
    index = 0,
    observers = [],
    telemetry = true,
  } = options;

  // Telemetry (Part 1) is collected by an internal observer and attached to the
  // record; it participates in the event/tick/start hooks but not onMatchEnd
  // (it is finalized explicitly, below, so downstream observers see it).
  const telemetryCollector = telemetry ? new TelemetryCollector() : null;
  const allObservers = telemetryCollector
    ? [...observers, telemetryCollector]
    : observers;

  // Stream 0 is the match-level RNG (#203): every gameplay dice roll in the
  // engine draws from it. Streams 1..N are per-seat AI decision streams.
  const match = createHeadlessMatch(players, {
    rng: mulberry32(deriveSeed(seed, 0)),
  });
  const state = match.gameState!;

  // One controller and one private RNG stream per seat, derived from the
  // match seed so seat order is stable and streams are independent. A seat
  // may carry its own factory (PlayerSpec.ai) so personalities can face each
  // other within one match (#205).
  const controllers = new Map<
    string,
    { controller: AIController; rng: () => number }
  >();
  state.getPlayers().forEach((p, i) => {
    const rng = mulberry32(deriveSeed(seed, i + 1));
    const factory = players[i]?.ai ?? createAI;
    controllers.set(p.id, { controller: factory(p, rng), rng });
  });

  // Gameplay-event forwarding (#204): observers with onEvent hear everything
  // the engine publishes. Subscribing only when needed keeps unmonitored
  // simulations on the bus's zero-listener fast path.
  const eventObservers = allObservers.filter((o) => o.onEvent);
  const unsubscribe =
    eventObservers.length > 0
      ? state.events.on((event) => {
          for (const o of eventObservers) o.onEvent!(event, match);
        })
      : null;

  for (const o of allObservers) o.onMatchStart?.(match, index, seed);

  let endedAtTick = maxTicks;
  let ended = false;

  for (let t = 1; t <= maxTicks; t++) {
    // Intent phase: controllers act in seat order (deterministic).
    for (const p of state.getPlayers()) {
      if (p.eliminated) continue;
      const entry = controllers.get(p.id);
      if (!entry) continue;
      entry.controller.act({ match, player: p, tick: t, rng: entry.rng });
      if (match.phase !== "active") break; // a cast may end the match mid-phase
    }

    if (match.phase === "active") {
      ended = tickMatch(match, t);
    } else {
      ended = true;
    }

    for (const o of allObservers) o.onTick?.(match, t);

    if (ended) {
      endedAtTick = t;
      break;
    }
  }

  unsubscribe?.();
  const record = recordMatch(match, index, seed, endedAtTick, !ended);
  // Attach telemetry before onMatchEnd so downstream observers can read it.
  if (telemetryCollector) {
    record.telemetry = telemetryCollector.finalize(record, endedAtTick);
  }
  for (const o of observers) o.onMatchEnd?.(record, match);
  return record;
}
