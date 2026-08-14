import type { GameState } from "../match/GameState.js";

export interface WinOutcome {
  ended: boolean;
  /** The last kingdom standing, or null for a draw (no survivors). */
  winnerId: string | null;
}

/**
 * Win-condition check (ticket #50): a match ends when at most one kingdom
 * remains alive (not eliminated). With exactly one survivor they win; with none
 * (simultaneous elimination) it is a draw.
 */
export function resolveWinner(state: GameState): WinOutcome {
  const alive = state.getPlayers().filter((p) => !p.eliminated);
  if (alive.length <= 1) {
    return { ended: true, winnerId: alive[0]?.id ?? null };
  }
  return { ended: false, winnerId: null };
}
