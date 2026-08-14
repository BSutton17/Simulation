/**
 * Gameplay event framework (ticket #204).
 *
 * Every significant gameplay occurrence is published as a typed event on the
 * match's EventBus. Consumers — the simulation recorder, the live `evt:*`
 * network layer, replays, future animations — subscribe and translate; they
 * never duplicate gameplay logic to infer what happened.
 *
 * Hard rules:
 *  - Emission NEVER affects gameplay: producers fire-and-forget, listener
 *    exceptions are swallowed, and with zero listeners `emit` is a no-op
 *    (producers guard object construction behind `bus.enabled`, keeping the
 *    hot path allocation-free for live matches with no subscribers).
 *  - Events describe WHAT happened in gameplay units. Rendering concerns
 *    (pixels, animation names) never appear here.
 */

/** Why a value changed — an ability id, `status:<id>`, or a system tag. */
export type EventCause = string;

export type GameplayEvent =
  | {
      type: "abilityCast";
      tick: number;
      casterId: string;
      abilityId: string;
      targetIds: string[];
      cost: number;
      chargesUsed?: number;
      /**
       * Attacks Air's wind passive deflected (Epic 9 VFX). Each entry maps the
       * kingdom that intercepted the shot (`via`) to the kingdom it was turned
       * toward (`to`, also in `targetIds`). The renderer plays a two-leg
       * deflection (attacker → via → to); absent when nothing was redirected.
       */
      redirects?: { via: string; to: string }[];
    }
  | {
      type: "damage";
      tick: number;
      sourceId: string;
      targetId: string;
      amount: number;
      absorbedByShield: number;
      dealtToHp: number;
      /** Damage that could not land because the target was already at 0 HP
       *  (or the hit exceeded remaining HP) — the "wasted" portion. */
      overkill: number;
      crit: boolean;
      element?: string;
      cause: EventCause;
      /**
       * A decoy damage number that did NOT actually land (Love's "Love Galore"
       * stealth phase): the hit was silently converted to healing, but enemies
       * still see a normal-looking damage number. The client hides it from the
       * bearer (they know they weren't hurt) and shows it to everyone else.
       */
      phantom?: boolean;
    }
  | {
      type: "heal";
      tick: number;
      targetId: string;
      /** HP actually restored (effective healing). */
      amount: number;
      /** Requested healing that was wasted because the castle was near full. */
      overheal: number;
      cause: EventCause;
    }
  | {
      type: "shieldGained";
      tick: number;
      playerId: string;
      amount: number;
      total: number;
      cause: EventCause;
    }
  | { type: "shieldDestroyed"; tick: number; playerId: string; cause: EventCause }
  | {
      type: "statusApplied";
      tick: number;
      targetId: string;
      sourceId: string;
      statusId: string;
      durationTicks: number;
      stacks: number;
    }
  | { type: "statusExpired"; tick: number; playerId: string; statusId: string }
  | {
      // Magma's "The End of the World": a volcano is standing in the middle of
      // the field, and every kingdom but Magma has until `endTick` to break it.
      type: "volcanoSpawned";
      tick: number;
      ownerId: string;
      hp: number;
      maxHp: number;
      endTick: number;
      durationTicks: number;
    }
  | {
      type: "volcanoDamaged";
      tick: number;
      attackerId: string;
      amount: number;
      hp: number;
      maxHp: number;
    }
  | { type: "volcanoBroken"; tick: number; ownerId: string }
  | {
      // It survived. Every kingdom but Magma takes the SAME shortfall.
      type: "volcanoErupted";
      tick: number;
      ownerId: string;
      /** How much the field managed to take off it in total. */
      absorbed: number;
      /** What each kingdom but Magma is charged — one shared number. */
      amount: number;
      /** Who helped, for display only; it does not change anyone's bill. */
      contributions: Record<string, number>;
    }
  | {
      // Insects' "Infected": the bearer fumbled a swing and it came back at
      // them. Paired with the `attackMissed` for the same swing — this one
      // says the miss also cost them.
      type: "attackDeflected";
      tick: number;
      /** Whoever swung, and is now wearing it. */
      playerId: string;
      abilityId: string;
      cause: EventCause;
    }
  | {
      // Insects' "Creepy Crawlers": the victim landed a click on one of the
      // bugs eating their gold.
      type: "crawlerSquashed";
      tick: number;
      playerId: string;
      /** Which bug of the swarm was hit. */
      index: number;
      /** True if that click finished it off. */
      killed: boolean;
      /** How many are still crawling afterwards. */
      remaining: number;
    }
  | {
      // Gold taken by something other than a purchase (Creepy Crawlers).
      type: "goldDrained";
      tick: number;
      playerId: string;
      amount: number;
      cause: EventCause;
    }
  | {
      // Insects' "Caprice": the butterfly is on the field, and for as long as
      // it is, nobody but Insects chooses who they are fighting.
      type: "capriceSpawned";
      tick: number;
      ownerId: string;
      durationTicks: number;
    }
  | {
      type: "capriceEnded";
      tick: number;
      ownerId: string;
    }
  | {
      // One kingdom's aim was taken away and pointed somewhere else.
      type: "targetScrambled";
      tick: number;
      playerId: string;
      targetId: string;
    }
  | {
      // Magma's "Floor is Lava": the whole battlefield is alight, so every burn
      // on it — anyone's — hits harder until it cools.
      type: "lavaFloorLit";
      tick: number;
      ownerId: string;
      durationTicks: number;
      multiplier: number;
    }
  | {
      // Magma's "Hot ash": a periodic public readout of who is currently
      // aiming at Magma — and therefore taking extra damage from it. Not a
      // status: nothing changes when it fires, it only shows what is already
      // true, so the client marks those kingdoms for `durationTicks` and drops
      // it again.
      type: "hotAshMarked";
      tick: number;
      /** The Magma kingdom being aimed at. */
      ownerId: string;
      /** Every kingdom currently targeting it. */
      targeterIds: string[];
      durationTicks: number;
    }
  | {
      // A status was turned away before it could land — Light's Fireflies
      // bouncing off a shield. Announced rather than silent: without it the
      // caster sees an ability apparently do nothing, and the defender never
      // learns their shield is what saved them.
      type: "statusRepelled";
      tick: number;
      /** The kingdom that shrugged it off. */
      playerId: string;
      sourceId: string;
      statusId: string;
      abilityId: string;
      /** What repelled it — currently always "shield". */
      cause: string;
    }
  | {
      // A two-phase hidden status revealed itself (Love's "Love Galore"): its
      // stealth window ended or its healing threshold was crossed. The client
      // starts the reveal aura and switches from phantom damage to visible
      // healing numbers on the bearer. The status stays active for a fresh
      // window afterward.
      type: "statusRevealed";
      tick: number;
      playerId: string;
      statusId: string;
    }
  | {
      // Time's Blip! rewound the most recent attack on `playerId`: HP/shield
      // restored, its statuses stripped. `sourceId`/`abilityId` name the undone
      // attack so the client can rewind a travel projectile back to its caster.
      type: "attackUndone";
      tick: number;
      playerId: string;
      sourceId: string;
      abilityId: string;
      removedStatusIds: string[];
    }
  | {
      // A recurring status's interval tick fired (Father Time's per-second
      // punish). `interrupted` = the bearer avoided it by landing a damaging
      // attack, so the countdown reset instead of dealing damage. The damage
      // itself (when not interrupted) still arrives as a `damage` event with
      // cause `status:<id>`.
      type: "statusTick";
      tick: number;
      playerId: string;
      statusId: string;
      interrupted: boolean;
    }
  | {
      type: "purchase";
      tick: number;
      playerId: string;
      kind: "citizen" | "repair" | "shield" | "unlock" | "upgrade" | "dispel";
      /** The ability id for unlock/upgrade purchases; the status id for a
       *  dispel. */
      itemId?: string;
      cost: number;
    }
  | {
      type: "citizensChanged";
      tick: number;
      playerId: string;
      delta: number;
      total: number;
      cause: EventCause;
    }
  | {
      type: "resourceTransfer";
      tick: number;
      fromId: string;
      toId: string;
      resource: "currency" | "citizens";
      amount: number;
      cause: EventCause;
    }
  | {
      type: "castFailed";
      tick: number;
      casterId: string;
      abilityId: string;
      /** The engine rejection reason (ON_COOLDOWN, INSUFFICIENT_FUNDS, …). */
      reason: string;
      /** When the rejection was caused by an active status on the caster (e.g.
       *  a crowd-control status barring attacks), the id of that status —
       *  populated generically from the caster's active statuses, never by
       *  naming a specific one. Absent for non-status rejections. */
      statusId?: string;
    }
  | { type: "eliminated"; tick: number; playerId: string }
  | { type: "targetChanged"; tick: number; playerId: string; targetId: string }
  | { type: "cooldownReady"; tick: number; playerId: string; abilityId: string }
  | {
      type: "chargeReady";
      tick: number;
      playerId: string;
      abilityId: string;
      /** How many charges finished regenerating on this tick. */
      regenerated: number;
    }
  | { type: "matchEnded"; tick: number; winnerId: string | null }
  /** Space's Supernova meter gained progress (Shooting Star / Saturn's Rings /
   *  Orion's Belt misses). `level` is the resulting Supernova level (0–3). */
  | {
      type: "supernovaCharged";
      tick: number;
      playerId: string;
      meter: number;
      level: number;
    }
  /** Space fired its Supernova at `targetId` at the given level, emptying the
   *  meter. The damage arrives as a separate `damage` event. */
  | {
      type: "supernovaFired";
      tick: number;
      playerId: string;
      targetId: string;
      level: number;
    }
  /** An incoming attack was negated by Orion's Belt (a chance-based miss on the
   *  bearer). `attackerId`/`abilityId` name the whiffed attack. */
  | {
      type: "attackMissed";
      tick: number;
      playerId: string;
      attackerId: string;
      abilityId: string;
      cause: string;
    }
  /** Joker's Slot Machine landed in front of `playerId`; their gold production
   *  is frozen until they pull the lever. */
  | {
      type: "slotMachineOpened";
      tick: number;
      playerId: string;
      sourceId: string;
      abilityId: string;
    }
  /** A player pulled the lever. The effect has already applied; `revealTick` is
   *  when the reels stop and the result becomes public on every screen. */
  | {
      type: "slotSpun";
      tick: number;
      playerId: string;
      symbols: string[];
      result: string;
      revealTick: number;
    }
  /** Joker's Roulette wheel landed in front of `playerId`; their gold
   *  production is frozen until they call a colour. */
  | {
      type: "rouletteOpened";
      tick: number;
      playerId: string;
      sourceId: string;
      abilityId: string;
    }
  /** A bet was placed and the wheel resolved. The effect has already applied;
   *  `revealTick` is when the ball settles publicly on every screen. */
  | {
      type: "rouletteSettled";
      tick: number;
      playerId: string;
      pocket: number;
      color: string;
      bet: string;
      result: string;
      revealTick: number;
    }
  /** Joker drew a Blackjack card; `card` is its label ("7", "Queen", "Joker")
   *  and `damage` the pre-pipeline hit it rolled. */
  | {
      type: "cardDrawn";
      tick: number;
      playerId: string;
      abilityId: string;
      card: string;
      /** The suit drawn, or null for a joker (which has none). Decides the
       *  rider the card leaves behind, and which pip the reveal shows. */
      suit: string | null;
      damage: number;
    }
  /** Joker gambled on Lucky Draw. `outcome` names what came up, or is null
   *  when the roll missed and nothing happened at all. */
  | {
      type: "luckyDraw";
      tick: number;
      playerId: string;
      abilityId: string;
      outcome: string | null;
    }
  /** Dark spent a full Unlimited Rage meter (it empties on cast). */
  | {
      type: "rageSpent";
      tick: number;
      playerId: string;
      abilityId: string;
    }
  /** A field-wide strike has been called down and will land at `resolveTick`
   *  (Light's "Light Show"). Public by design — the warning window is when
   *  everyone scrambles for a shield. */
  | {
      type: "strikeIncoming";
      tick: number;
      ownerId: string;
      abilityId: string;
      resolveTick: number;
    }
  /** The gold price to shake off a status changed (Light's Illumination
   *  inflating the Fireflies ransom); `cost` is the new outstanding price. */
  | {
      type: "dispelCostChanged";
      tick: number;
      playerId: string;
      statusId: string;
      cost: number;
      cause: string;
    }
  /** Space's Black Hole opened over the field (`playerId` = its owner); for
   *  `durationTicks` all attacks are absorbed into it. */
  | {
      type: "blackHoleOpened";
      tick: number;
      playerId: string;
      durationTicks: number;
    }
  /** The Black Hole swallowed an attack's damage instead of it landing. */
  | {
      type: "blackHoleAbsorbed";
      tick: number;
      ownerId: string;
      attackerId: string;
      amount: number;
    }
  /** The Black Hole collapsed, dumping all absorbed damage onto `victimId`. */
  | {
      type: "blackHoleCollapsed";
      tick: number;
      ownerId: string;
      victimId: string | null;
      amount: number;
    }
  /** Reserved for the projectile system (GAME_TICK.md §5); no emitter yet. */
  | {
      type: "projectileSpawned";
      tick: number;
      projectileId: string;
      sourceId: string;
      targetId: string;
      kind: string;
      impactTick: number;
    };

export type GameplayEventListener = (event: GameplayEvent) => void;

/**
 * A minimal synchronous pub/sub bus, one per match. Deliberately tiny: no
 * wildcards, no async, no ordering guarantees beyond emission order — the
 * cheapest thing that can feed recorders and the network layer.
 */
export class EventBus {
  private listeners: GameplayEventListener[] = [];

  /** True when anyone is listening — producers guard emission on this so a
   *  live match with no subscribers pays nothing. */
  get enabled(): boolean {
    return this.listeners.length > 0;
  }

  /** Subscribes; returns an unsubscribe function. */
  on(listener: GameplayEventListener): () => void {
    this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: GameplayEventListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Publishes to all listeners. Listener errors are swallowed — events must
   *  never affect gameplay (#204). */
  emit(event: GameplayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers are read-only conveniences; a broken one cannot be
        // allowed to break the authoritative simulation.
      }
    }
  }
}
