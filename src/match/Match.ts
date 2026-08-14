import { MATCH } from "../data/balance.js";
import { hasFullPerkSelection } from "../data/perks.js";
import { createGameState, type GameState } from "./GameState.js";
import type { MatchConfig } from "./matchConfig.js";
import type { MatchPhase, MatchPlayer } from "./types.js";

export interface MatchOptions {
  /** Overrides the maximum player count (defaults to the balance value). */
  maxPlayers?: number;
  /**
   * Match-level random number generator (ticket #203). EVERY gameplay dice
   * roll flows through this: crits, proc chances, redirections, deflections,
   * status ticks. Live matches default to Math.random; simulations inject a
   * seeded generator so identical seeds replay identical matches.
   */
  rng?: () => number;
}

/**
 * The authoritative server-side representation of one match — a single game in
 * one Socket.IO room (see ARCHITECTURE.md, DATA_MODELS.md → Match).
 *
 * At this stage it is a container for room information, the connected roster,
 * and match state. Gameplay data (economy, abilities, statuses, projectiles,
 * the tick loop) attaches here as those systems are implemented.
 */
export class Match {
  /** Human-facing join code; also the Socket.IO room name. */
  readonly roomCode: string;
  readonly createdAt: number;
  readonly maxPlayers: number;
  /**
   * Host setting: once you are eliminated, you can see every surviving
   * kingdom's health. Off by default — knowing the whole board is a real
   * advantage to hand a player who can no longer be punished for it, and in a
   * room of friends it is also a channel for coaching whoever is still alive.
   * The host turns it on for the games where watching matters more.
   */
  eliminatedSeeAllHealth = false;

  /** Current lifecycle phase. */
  phase: MatchPhase = "lobby";
  /** Player id of the host (room owner); null until assigned. */
  hostId: string | null = null;
  /** Winner once the match ends; null otherwise. */
  winnerId: string | null = null;
  /** Current server tick (advanced by the game loop in a later ticket). */
  tick = 0;
  /** Ruleset snapshot, set when the match starts; null while in the lobby. */
  config: MatchConfig | null = null;
  /** When the match transitioned to active; null until then. */
  startedAt: number | null = null;
  /** Central gameplay state, created when the match starts; null in the lobby. */
  gameState: GameState | null = null;

  private readonly players = new Map<string, MatchPlayer>();

  /** Match-level RNG — the sole source of gameplay randomness (#203). */
  rng: () => number;

  /** Monotonic per-match sequence for engine-generated ids (#203): replaces
   *  Math.random/Date.now id salts so identical seeds produce identical ids. */
  private idSeq = 0;

  constructor(roomCode: string, options: MatchOptions = {}) {
    this.roomCode = roomCode;
    this.createdAt = Date.now();
    this.maxPlayers = options.maxPlayers ?? MATCH.MAX_PLAYERS;
    this.rng = options.rng ?? Math.random;
  }

  /** Next value of the deterministic id sequence. */
  nextSeq(): number {
    this.idSeq += 1;
    return this.idSeq;
  }

  /**
   * Adds a player to the match. Throws if the player is already present or the
   * room is full — callers that surface user-facing errors should check
   * `hasPlayer` / `isFull` first (see SOCKET_EVENTS.md error codes).
   */
  addPlayer(player: MatchPlayer): void {
    if (this.players.has(player.id)) {
      throw new Error(`Player ${player.id} is already in match ${this.roomCode}`);
    }
    if (this.isFull()) {
      throw new Error(`Match ${this.roomCode} is full (max ${this.maxPlayers})`);
    }
    this.players.set(player.id, player);
  }

  /** Removes a player. Returns true if one was removed. */
  removePlayer(playerId: string): boolean {
    return this.players.delete(playerId);
  }

  getPlayer(playerId: string): MatchPlayer | undefined {
    return this.players.get(playerId);
  }

  hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  getPlayers(): MatchPlayer[] {
    return [...this.players.values()];
  }

  isHost(playerId: string): boolean {
    return this.hostId === playerId;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** Kingdom-playing participants (spectators excluded) — the count capped at
   *  `MATCH.MAX_ACTIVE_PLAYERS`. */
  get activePlayerCount(): number {
    return this.getPlayers().filter((p) => !p.spectator).length;
  }

  /**
   * Transitions the match from the lobby into an active game with the given
   * config snapshot (ticket #37). Per-player gameplay state is initialized by
   * later systems (economy, abilities, …).
   */
  start(config: MatchConfig): void {
    this.phase = "active";
    this.config = config;
    this.startedAt = Date.now();
    this.tick = 0;
    this.gameState = createGameState(this.getPlayers(), config);
  }

  /** Ends the match with the given winner (null = draw). */
  end(winnerId: string | null): void {
    this.phase = "ended";
    this.winnerId = winnerId;
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  /**
   * Whether the match may start: at least the minimum number of players are
   * connected and every connected player is ready AND has selected a kingdom
   * AND a full set of perks (tickets #30, #33). Kingdoms are exclusive, so a
   * full 8-player lobby (7 kingdoms) can never satisfy this — an accepted
   * trade-off. Disconnected players (mid reconnection-grace) do not block the
   * start.
   */
  canStart(): boolean {
    // Spectators never gate the start — only connected, kingdom-playing
    // participants must be present (≥ MIN) and all ready with a kingdom.
    const players = this.getPlayers().filter((p) => p.connected && !p.spectator);
    return (
      players.length >= MATCH.MIN_PLAYERS &&
      players.every(
        (p) =>
          p.ready &&
          p.kingdomId !== null &&
          // The allowance is per kingdom — Kitsune needs three.
          hasFullPerkSelection(p.perks, p.kingdomId),
      )
    );
  }

  /** Plain, serializable view of the match for sending to clients. */
  serialize(): {
    roomCode: string;
    phase: MatchPhase;
    hostId: string | null;
    players: MatchPlayer[];
    playerCount: number;
    maxPlayers: number;
    maxActivePlayers: number;
    eliminatedSeeAllHealth: boolean;
    tick: number;
    winnerId: string | null;
    config: MatchConfig | null;
    startedAt: number | null;
  } {
    return {
      roomCode: this.roomCode,
      phase: this.phase,
      hostId: this.hostId,
      players: this.getPlayers(),
      playerCount: this.playerCount,
      maxPlayers: this.maxPlayers,
      maxActivePlayers: MATCH.MAX_ACTIVE_PLAYERS,
      eliminatedSeeAllHealth: this.eliminatedSeeAllHealth,
      tick: this.tick,
      winnerId: this.winnerId,
      config: this.config,
      startedAt: this.startedAt,
    };
  }
}
