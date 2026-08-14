import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { roundMoney } from "./money.js";
import { param } from "./parameters.js";
import { TICK } from "../data/balance.js";

/**
 * Insects' "Creepy Crawlers".
 *
 * Three bugs land on a kingdom and start eating its gold. Each one drains on
 * its own, so the bleed eases with every one the victim swats rather than
 * running flat until the last is gone — swatting the first is worth something
 * immediately, which is what makes frantically clicking feel productive.
 *
 * Killing one takes two clicks. That is the whole interaction: not a dispel
 * price and not a wait, but the victim actually having to stop what they were
 * doing and deal with it, which costs them the thing the ability is really
 * taking — their attention.
 */

/** The status id the swarm rides on. */
export const CRAWLERS_STATUS_ID = "creepyCrawlers";

/** The crawler swarm currently on `player`, or undefined. */
export function crawlerSwarm(player: PlayerState) {
  return player.statuses.find((s) => s.id === CRAWLERS_STATUS_ID && s.bugHits);
}

/** How many of the swarm's bugs are still alive. */
export function livingCrawlers(player: PlayerState): number {
  const swarm = crawlerSwarm(player);
  if (!swarm?.bugHits) return 0;
  const needed = swarm.hitsToKill ?? 1;
  return swarm.bugHits.filter((hits) => hits < needed).length;
}

/**
 * Lands one click on bug `index`. Returns what happened, or null if there is
 * nothing there to swat — a click on an already-dead bug, an out-of-range
 * index, or a player carrying no swarm at all.
 *
 * Authoritative on purpose: the client sends "I hit bug 2", never "bug 2 is
 * dead". A client that could declare its own kills could clear the swarm the
 * instant it landed.
 */
export function squashCrawler(
  match: Match,
  player: PlayerState,
  index: number,
): { killed: boolean; remaining: number } | null {
  const swarm = crawlerSwarm(player);
  if (!swarm?.bugHits) return null;
  if (!Number.isInteger(index) || index < 0 || index >= swarm.bugHits.length) {
    return null;
  }

  const needed = swarm.hitsToKill ?? 1;
  if (swarm.bugHits[index]! >= needed) return null; // already squashed

  swarm.bugHits[index]! += 1;
  const killed = swarm.bugHits[index]! >= needed;
  const remaining = livingCrawlers(player);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "crawlerSquashed",
      tick: match.tick,
      playerId: player.id,
      index,
      killed,
      remaining,
    });
  }

  // The last one is gone: the swarm leaves rather than sitting there inert
  // until its clock runs out.
  if (remaining === 0) {
    player.statuses = player.statuses.filter((s) => s !== swarm);
    if (bus.enabled) {
      bus.emit({
        type: "statusExpired",
        tick: match.tick,
        playerId: player.id,
        statusId: CRAWLERS_STATUS_ID,
      });
    }
  }

  return { killed, remaining };
}

/**
 * Drains gold for every bug still crawling, once per tick. Run from the tick
 * loop. Gold only — it never touches HP, so a kingdom being eaten alive is
 * losing tempo rather than dying to it.
 */
export function drainCrawledKingdoms(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const rate = param("tick.rate", TICK.RATE);

  for (const player of state.getPlayers()) {
    if (player.eliminated) continue;
    const swarm = crawlerSwarm(player);
    if (!swarm) continue;

    const alive = livingCrawlers(player);
    if (alive === 0) continue;

    const perTick = ((swarm.drainPerSecond ?? 0) * alive) / rate;
    if (perTick <= 0) continue;

    const before = player.economy.currency;
    // Floored at zero: a drain can empty a treasury but never overdraw it.
    player.economy.currency = roundMoney(Math.max(0, before - perTick));
    const taken = before - player.economy.currency;

    if (taken > 0 && state.events.enabled) {
      state.events.emit({
        type: "goldDrained",
        tick: state.tick,
        playerId: player.id,
        amount: taken,
        cause: CRAWLERS_STATUS_ID,
      });
    }
  }
}
