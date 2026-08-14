import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Insects' "Caprice".
 *
 * A butterfly holds the middle of the field for twenty-five seconds. While it
 * is there nobody chooses who they are fighting: every second it re-rolls
 * everyone's target. Insects is exempt and picks freely, and Insects is also
 * the one kingdom nobody may aim at — so for the duration it is the only
 * player still playing on purpose while everyone else swings at whoever the
 * butterfly happened to point them at.
 *
 * A scrambled target may be the player THEMSELVES. That is deliberate, and it
 * is why `activateAbility` relaxes its self-target rejection while a Caprice is
 * up: "you might end up hitting your own castle" is the whole joke, and a
 * silent refusal to fire would be a lockout instead.
 */

/** True while a butterfly is out. */
export function capriceIsActive(match: Match): boolean {
  const caprice = match.gameState?.caprice;
  return !!caprice && match.tick < caprice.endTick;
}

/** The Insects kingdom holding the field, or null when no butterfly is out. */
export function capriceOwnerId(match: Match): string | null {
  return capriceIsActive(match) ? match.gameState!.caprice!.ownerId : null;
}

/**
 * True if `playerId` is currently untargetable because of a Caprice. Only ever
 * the caster: everyone else is fair game, including themselves.
 */
export function capriceProtects(match: Match, playerId: string): boolean {
  return capriceOwnerId(match) === playerId;
}

/** True if `player` has their aim taken away right now. Everyone but the caster. */
export function capriceScrambles(match: Match, player: PlayerState): boolean {
  const owner = capriceOwnerId(match);
  return owner !== null && owner !== player.id;
}

/** Puts a butterfly on the field. */
export function spawnCaprice(
  match: Match,
  ownerId: string,
  durationTicks: number,
  scrambleTicks: number,
): void {
  const state = match.gameState!;
  state.caprice = {
    ownerId,
    endTick: match.tick + durationTicks,
    scrambleTicks: Math.max(1, scrambleTicks),
  };

  if (state.events.enabled) {
    state.events.emit({
      type: "capriceSpawned",
      tick: match.tick,
      ownerId,
      durationTicks,
    });
  }
  // Scramble immediately, so the butterfly takes hold the moment it lands
  // rather than leaving everyone a free second on their chosen target.
  scrambleTargets(match);
}

/**
 * Re-rolls every affected kingdom's target. Each one is pointed at a random
 * living kingdom that is NOT Insects — themselves included.
 */
export function scrambleTargets(match: Match): void {
  const state = match.gameState!;
  const owner = capriceOwnerId(match);
  if (owner === null) return;

  const living = state.getPlayers().filter((p) => !p.eliminated);
  // Everyone but Insects is a legal destination. Insects is untargetable for
  // the duration, which is what makes the ability a shield as well as chaos.
  const pool = living.filter((p) => p.id !== owner);
  if (pool.length === 0) return;

  for (const player of living) {
    if (player.id === owner) continue; // the caster keeps their own aim
    const pick = pool[Math.floor(match.rng() * pool.length)]!;
    if (player.target === pick.id) continue;
    player.target = pick.id;
    if (state.events.enabled) {
      state.events.emit({
        type: "targetScrambled",
        tick: state.tick,
        playerId: player.id,
        targetId: pick.id,
      });
    }
  }
}

/**
 * Runs the butterfly for one tick: re-rolls on its cadence, and clears it once
 * its time is up. Called from the tick loop.
 */
export function tickCaprice(match: Match): void {
  const state = match.gameState;
  const caprice = state?.caprice;
  if (!state || !caprice) return;

  if (match.tick >= caprice.endTick) {
    state.caprice = null;
    if (state.events.enabled) {
      state.events.emit({
        type: "capriceEnded",
        tick: match.tick,
        ownerId: caprice.ownerId,
      });
    }
    return;
  }

  if (match.tick % caprice.scrambleTicks === 0) scrambleTargets(match);
}
