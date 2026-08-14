import type { Match } from "../match/Match.js";
import { targeterMarkSpec } from "./passives.js";

/**
 * Magma's "Hot ash", public half.
 *
 * Aiming at Magma makes Magma's attacks land harder on you (that part is in the
 * damage pipeline). This is the warning: on a fixed cadence, every kingdom
 * currently targeting Magma is marked for a few seconds so the whole table can
 * see who is in the ash cloud — including the players themselves, who may not
 * have realised what pointing at Magma costs.
 *
 * It is announced as an event rather than a status because it changes nothing:
 * it is a periodic readout of who is already targeting Magma, and a status
 * would imply the mark itself does something.
 */
export function markHotAshTargeters(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const bus = state.events;
  if (!bus.enabled) return;

  for (const magma of state.getPlayers()) {
    if (magma.eliminated) continue;
    const spec = targeterMarkSpec(magma);
    if (!spec || spec.intervalTicks <= 0) continue;
    // Fires on the interval only. Tick 0 is skipped: a match should not open
    // with a warning nobody has had a chance to earn yet.
    if (match.tick === 0 || match.tick % spec.intervalTicks !== 0) continue;

    const targeters = state
      .getPlayers()
      .filter((p) => !p.eliminated && p.id !== magma.id && p.target === magma.id)
      .map((p) => p.id);
    if (targeters.length === 0) continue;

    bus.emit({
      type: "hotAshMarked",
      tick: match.tick,
      ownerId: magma.id,
      targeterIds: targeters,
      durationTicks: spec.durationTicks,
    });
  }
}
