import type { Match } from "../../src/match/Match.js";
import type { PlayerState } from "../../src/match/playerState.js";
import type { KingdomId } from "../../src/data/kingdoms.js";
import type { GameplayEvent } from "../../src/engine/events.js";
import type { MatchTelemetry } from "./telemetry.js";
import type { Rng } from "./rng.js";

/**
 * Core types for the simulation framework (ticket #201).
 *
 * The framework NEVER implements gameplay: it constructs real `Match`
 * instances, lets AI controllers issue the same engine calls the socket
 * handlers make, and advances time with the production `tickMatch`. Everything
 * here is orchestration and observation.
 */

/** One seat in a simulated match. */
export interface PlayerSpec {
  kingdomId: KingdomId;
  /** Display name; defaults to `p<i>-<kingdom>`. */
  name?: string;
  /**
   * Per-seat controller factory (ticket #205): lets a single match pit
   * different personalities against each other. Falls back to the run-level
   * `createAI`, then to the balanced default.
   */
  ai?: AIFactory;
}

/**
 * What an AI sees when it acts: the live match, its own authoritative player
 * state, the upcoming tick number, and its private deterministic RNG stream.
 * Controllers act by calling engine functions (activateAbility, buyCitizen,
 * selectTarget, …) — exactly the calls the live socket handlers make.
 */
export interface AIContext {
  match: Match;
  player: PlayerState;
  /** The tick that is about to run (intents drain before the tick, GAME_TICK.md §2). */
  tick: number;
  rng: Rng;
}

/** A controller drives one player for the duration of one match. */
export interface AIController {
  /** Called once per tick, before the tick advances. */
  act(ctx: AIContext): void;
}

/** Builds a controller for one player seat; called once per match. */
export type AIFactory = (player: PlayerState, rng: Rng) => AIController;

/** A player's end-of-match snapshot, for analytics. */
export interface PlayerOutcome {
  id: string;
  name: string;
  kingdomId: string | null;
  hp: number;
  shield: number;
  citizens: number;
  currency: number;
  eliminatedAtTick: number | null;
}

/** The full result of one simulated match. */
export interface MatchRecord {
  /** Zero-based index of this match within the simulation run. */
  index: number;
  /** The derived seed this match ran under (replayable on its own). */
  seed: number;
  winnerId: string | null;
  winnerKingdom: string | null;
  /** Tick at which the match ended (or the cap, when timed out). */
  endedAtTick: number;
  /** True when the tick cap was hit before a winner emerged. */
  timedOut: boolean;
  players: PlayerOutcome[];
  /** Full per-seat telemetry for this match (Telemetry Foundation). Present
   *  unless the run disabled collection (`SimulationConfig.telemetry: false`). */
  telemetry?: MatchTelemetry;
}

/** Aggregate result of a simulation run. */
export interface SimulationResult {
  records: MatchRecord[];
  totalTicks: number;
  /** Wall-clock duration of the run, for throughput measurements. */
  durationMs: number;
}

/**
 * Extension point for analytics, recording, and reporting (later tickets).
 * All hooks are optional; observers must not mutate gameplay state.
 */
export interface SimulationObserver {
  onMatchStart?(match: Match, index: number, seed: number): void;
  /** After each completed tick. */
  onTick?(match: Match, tick: number): void;
  /**
   * Every gameplay event the engine publishes (#204) — ability casts, damage,
   * heals, statuses, economy changes, shields, eliminations, cooldowns. The
   * foundation for recording, analytics, and replays.
   */
  onEvent?(event: GameplayEvent, match: Match): void;
  onMatchEnd?(record: MatchRecord, match: Match): void;
  onComplete?(result: SimulationResult): void;
}

/** Configuration for a simulation run. */
export interface SimulationConfig {
  /** Number of complete matches to run. */
  matches: number;
  /** Master seed — identical seeds replay the entire run identically. */
  seed: number | string;
  /** The seats in every match (2–8 players). */
  players: PlayerSpec[];
  /**
   * Safety cap per match, in ticks (default 24_000 = 20 min at 20 t/s).
   * Matches that reach the cap are recorded as timed out, never hung.
   */
  maxTicks?: number;
  /** Controller factory; defaults to the baseline AI. */
  createAI?: AIFactory;
  observers?: SimulationObserver[];
  /**
   * Collect full per-match telemetry and attach it to each MatchRecord
   * (Telemetry Foundation). Defaults to ON. Set false for throughput-critical
   * runs — the optimizer disables it for its evaluation batches.
   */
  telemetry?: boolean;
  /**
   * Candidate balance configuration (ticket #202): parameter overrides the
   * engine reads through for the duration of this run. Production balance
   * data is never modified — omit to simulate the live game exactly.
   */
  parameters?: Readonly<Record<string, number>>;
  /**
   * Rotate the seat order each match (FFA fairness). With a fixed seat order a
   * free-for-all conflates kingdom strength with positional luck — seat index
   * drives turn order, targeting, and each seat's RNG stream. When enabled, the
   * players array is cyclically rotated by (matchIndex mod N) so every kingdom
   * plays every seat an equal number of times once `matches` is a multiple of
   * N. Analytics key by kingdom, so aggregation is unaffected. Defaults to OFF
   * (1v1 duels don't need it); the `ffa` command turns it on.
   */
  rotateSeats?: boolean;
}
