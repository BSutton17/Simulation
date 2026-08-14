import type { Match } from "../match/Match.js";
import { VOLCANO_TARGET_ID } from "../match/GameState.js";
import { applyDamage } from "./combat.js";
import { MAGMA } from "../data/balance.js";
import type { StatusEffectDefinition } from "./status.js";
import type { VolcanoStatus } from "../match/GameState.js";

/**
 * Magma's "The End of the World".
 *
 * A volcano stands in the middle of the battlefield with 1000 health per living
 * kingdom and a visible countdown. Everyone except Magma has twenty seconds to
 * break it.
 *
 * If it survives, EVERY kingdom but Magma takes `ERUPTION_YIELD` minus what the
 * FIELD dealt between them — one shared number, not per-player scores.
 *
 * That is the point of it. A shared bill forces a table that has spent the
 * whole match attacking each other to cooperate for twenty seconds or all go
 * down together, and it means no kingdom can save itself alone: mutually
 * assured destruction, with a way out that requires everyone.
 *
 * Contributions are still tracked per attacker, but only so the client can show
 * who actually helped — they do not change anyone's bill.
 */

/** How much a volcano is worth per living kingdom. */
export const VOLCANO_HP_PER_PLAYER = 1000;

/** True while a volcano is standing and its timer has not run out. */
export function volcanoIsLive(match: Match): boolean {
  const v = match.gameState?.volcano;
  return !!v && v.hp > 0 && match.tick < v.endTick;
}

/**
 * Puts a volcano on the field. Sized off the kingdoms that are actually still
 * playing, so a late-game duel does not face a wall built for eight.
 */
export function spawnVolcano(match: Match, ownerId: string, durationTicks: number): void {
  const state = match.gameState!;
  const living = state.getPlayers().filter((p) => !p.eliminated).length;
  const maxHp = VOLCANO_HP_PER_PLAYER * living;

  state.volcano = {
    ownerId,
    hp: maxHp,
    maxHp,
    endTick: match.tick + durationTicks,
    contributions: {},
    statuses: [],
  };

  if (state.events.enabled) {
    state.events.emit({
      type: "volcanoSpawned",
      tick: match.tick,
      ownerId,
      hp: maxHp,
      maxHp,
      endTick: state.volcano.endTick,
      durationTicks,
    });
  }
}

/**
 * Lands a hit on the volcano. Returns how much it actually absorbed — capped at
 * what was left, so overkill is not counted toward reducing the eruption.
 */
export function damageVolcano(match: Match, attackerId: string, amount: number): number {
  const state = match.gameState!;
  const volcano = state.volcano;
  if (!volcano || volcano.hp <= 0) return 0;

  const dealt = Math.min(volcano.hp, Math.max(0, Math.round(amount)));
  volcano.hp -= dealt;
  // Credited to the attacker: the eruption is scored per kingdom, off exactly
  // this number. Overkill is not credited — `dealt` is capped at what was left.
  volcano.contributions[attackerId] =
    (volcano.contributions[attackerId] ?? 0) + dealt;

  if (state.events.enabled && dealt > 0) {
    state.events.emit({
      type: "volcanoDamaged",
      tick: match.tick,
      attackerId,
      amount: dealt,
      hp: volcano.hp,
      maxHp: volcano.maxHp,
    });
  }
  return dealt;
}

/**
 * Lays a status on the volcano — a burn, a freeze, whatever the attack carried.
 *
 * Attacks are not split into "the part that works on the volcano" and "the part
 * that is thrown away": if an ability inflicts something, it inflicts it here
 * too. What that status then DOES is another matter — the mountain has no stats
 * to modify and takes no actions to interrupt, so a freeze simply sits on it
 * and only tick damage moves the health bar.
 *
 * Stacking follows the definition, so a stacking DoT builds on the volcano the
 * same way it would on a castle.
 */
export function applyVolcanoStatus(
  match: Match,
  sourceId: string,
  definition: StatusEffectDefinition,
  durationTicks: number,
  stacks = 1,
): VolcanoStatus | null {
  const volcano = match.gameState?.volcano;
  if (!volcano || volcano.hp <= 0) return null;

  const existing = volcano.statuses.find((s) => s.id === definition.id);
  if (existing) {
    switch (definition.stacking) {
      case "stack":
        existing.stacks = Math.min(
          definition.maxStacks ?? Number.POSITIVE_INFINITY,
          existing.stacks + stacks,
        );
        existing.remainingTicks = Math.max(existing.remainingTicks, durationTicks);
        break;
      case "extend":
        existing.remainingTicks += durationTicks;
        break;
      case "none":
        return existing; // first application wins; nothing to refresh
      default: // "refresh" | "replace"
        existing.remainingTicks = durationTicks;
        existing.stacks = stacks;
        break;
    }
    // Re-credit to the latest applier, so the newest attacker gets the ticks.
    existing.sourceId = sourceId;
    return existing;
  }

  const instance: VolcanoStatus = {
    id: definition.id,
    sourceId,
    remainingTicks: durationTicks,
    stacks,
    tickEffects: definition.tickEffects?.map((t) => ({ ...t })),
  };
  volcano.statuses.push(instance);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "statusApplied",
      tick: match.tick,
      targetId: VOLCANO_TARGET_ID,
      sourceId,
      statusId: instance.id,
      durationTicks: instance.remainingTicks,
      stacks: instance.stacks,
    });
  }
  return instance;
}

/**
 * Runs the volcano's own statuses for one tick. Damage-over-time chips the
 * mountain and is CREDITED to whoever applied it, so setting a burn on it
 * counts toward breaking it exactly as swinging at it does.
 *
 * Deliberately does not honour "Floor is Lava": that multiplier is written in
 * terms of a bearing PLAYER, and a burn on a rock is not the thing that rule is
 * about. Keeping it out also stops Magma's own utility from helping the field
 * dismantle Magma's own ultimate.
 */
export function tickVolcanoStatuses(match: Match): void {
  const volcano = match.gameState?.volcano;
  if (!volcano || volcano.hp <= 0) return;
  const bus = match.gameState!.events;

  for (let i = volcano.statuses.length - 1; i >= 0; i--) {
    const status = volcano.statuses[i]!;

    for (const effect of status.tickEffects ?? []) {
      if (effect.type !== "damage") continue; // nothing else can touch a rock
      const amount = effect.perStack
        ? effect.amount * status.stacks
        : effect.amount;
      if (amount > 0) damageVolcano(match, status.sourceId, amount);
    }

    // A status with no clock (Old Friends) never times out on its own; on the
    // volcano there is no shield to buy, so it simply rides until it erupts.
    if (status.remainingTicks > 0) {
      status.remainingTicks -= 1;
      if (status.remainingTicks <= 0) {
        volcano.statuses.splice(i, 1);
        if (bus.enabled) {
          bus.emit({
            type: "statusExpired",
            tick: match.tick,
            playerId: VOLCANO_TARGET_ID,
            statusId: status.id,
          });
        }
      }
    }
  }
}

/**
 * Resolves a volcano whose time is up, or that has been broken. Run once per
 * tick from the game loop, before death detection so a fatal eruption settles
 * on the same tick.
 */
export function resolveVolcano(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const volcano = state.volcano;
  if (!volcano) return;

  const broken = volcano.hp <= 0;
  if (!broken && match.tick < volcano.endTick) return;

  state.volcano = null; // gone either way
  const bus = state.events;

  // Broken in time: the field took it down and nobody is hurt.
  if (broken) {
    if (bus.enabled) {
      bus.emit({ type: "volcanoBroken", tick: match.tick, ownerId: volcano.ownerId });
    }
    return;
  }

  // Still standing. The field takes ONE shared shortfall — what everybody
  // together failed to chip off — so a kingdom that did nothing and a kingdom
  // that did everything take the same hit. That is what makes it cooperative.
  const yieldAmount = MAGMA.VOLCANO_ERUPTION_YIELD;
  const absorbed = volcano.maxHp - volcano.hp;
  const owed = Math.max(0, yieldAmount - absorbed);

  if (bus.enabled) {
    bus.emit({
      type: "volcanoErupted",
      tick: match.tick,
      ownerId: volcano.ownerId,
      absorbed,
      amount: owed,
      contributions: { ...volcano.contributions },
    });
  }

  if (owed <= 0) return; // the field did the work; everyone walks away clean

  for (const victim of state.getPlayers()) {
    // Magma is spared — it called this down.
    if (victim.id === volcano.ownerId || victim.eliminated) continue;
    const applied = applyDamage(victim, owed, { tick: match.tick });
    if (bus.enabled) {
      bus.emit({
        type: "damage",
        tick: match.tick,
        sourceId: volcano.ownerId,
        targetId: victim.id,
        amount: applied.absorbedByShield + applied.dealtToHp,
        absorbedByShield: applied.absorbedByShield,
        dealtToHp: applied.dealtToHp,
        overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
        crit: false,
        cause: "volcano",
      });
    }
  }
}

export { VOLCANO_TARGET_ID };
