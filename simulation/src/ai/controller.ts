import { activateAbility, type AbilityDefinition } from "../../../src/engine/abilities.js";
import {
  buyCitizen,
  buyShield,
  repairCastle,
  unlockOrUpgradeAbility,
} from "../../../src/engine/purchases.js";
import { selectTarget } from "../../../src/engine/targeting.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import type { PlayerState } from "../../../src/match/playerState.js";
import type { AIContext, AIController, AIFactory } from "../types.js";
import type { Rng } from "../rng.js";
import { ACTION_SIZE, PRIMARY_ACTION_COUNT, WAIT, orderEnemies } from "./actions.js";
import { chargesToSpend, decide, type Decision } from "./decode.js";
import { DEFAULT_DECISION_PERIOD, DIFFICULTY, type Difficulty } from "./difficulty.js";
import { ObservedHistory, knowledgeFor } from "./knowledge.js";
import { createMask, legalActions, type ActionMask } from "./legality.js";
import { OBSERVATION_SIZE, encode } from "./observation.js";
import { randomNetwork, type Network } from "./network.js";

/**
 * The network-driven controller.
 *
 * One of exactly two modules in `ai/` that touch the simulation, and the only
 * one that WRITES to it. Reads go through `knowledge.ts`; writes go through the
 * same six engine functions the live socket handlers call, so this bot is
 * subject to identical validation and can no more cheat than a human can.
 *
 * It has no idea where its network came from. `Network` is the entire contract,
 * so a NEAT phenotype drops in with no change here — which is the point of
 * building the runtime before the algorithm.
 */

export interface NetworkControllerOptions {
  readonly network: Network;
  readonly rng: Rng;
  readonly difficulty?: Difficulty;
  /** Overrides the difficulty's cadence. Mainly for tests. */
  readonly decisionPeriod?: number;
}

/** Per-match counters, for proving the pipeline actually did things. */
export interface ControllerStats {
  decisions: number;
  casts: number;
  invests: number;
  citizens: number;
  repairs: number;
  shields: number;
  retargets: number;
  waits: number;
  /**
   * Engine calls the mask said were legal but the engine refused.
   *
   * Expected to be zero. A nonzero count means `legality.ts` and the engine
   * have drifted, which is a defect rather than a strategy problem — so it is
   * counted rather than swallowed.
   */
  rejected: number;
  /** Rejections keyed by `action:ENGINE_ERROR`, so a drift names itself. */
  rejectedBy: Record<string, number>;
  /** Ticks on which the mask offered nothing but WAIT. */
  forcedWaits: number;
}

export class NetworkController implements AIController {
  private readonly network: Network;
  private readonly rng: Rng;
  private readonly period: number;
  private readonly secondBestRate: number;
  private readonly buckets: number;

  /** Buffers owned for the life of the controller — see observation.ts. */
  private readonly obs = new Float32Array(OBSERVATION_SIZE);
  private readonly out = new Float32Array(ACTION_SIZE);
  private readonly mask: ActionMask = createMask();
  private readonly altMask: ActionMask = createMask();

  private readonly history = new ObservedHistory();
  private readonly kit: readonly AbilityDefinition[];
  private readonly phase: number;
  private subscribed = false;

  readonly stats: ControllerStats = {
    decisions: 0, casts: 0, invests: 0, citizens: 0, repairs: 0,
    shields: 0, retargets: 0, waits: 0, rejected: 0, rejectedBy: {}, forcedWaits: 0,
  };

  /** Records a rejection under a name that identifies the drift. */
  private reject(action: string, error: string | undefined): void {
    this.stats.rejected += 1;
    const key = `${action}:${error ?? "UNKNOWN"}`;
    this.stats.rejectedBy[key] = (this.stats.rejectedBy[key] ?? 0) + 1;
  }

  constructor(player: PlayerState, options: NetworkControllerOptions) {
    this.network = options.network;
    this.rng = options.rng;
    const config = DIFFICULTY[options.difficulty ?? "hard"];
    this.period = Math.max(1, options.decisionPeriod ?? config.decisionPeriod);
    this.secondBestRate = config.secondBestRate;
    this.buckets = config.observationBuckets;
    // Same expression knowledge.ts uses, so slot indices agree.
    this.kit = abilitiesForKingdom(player.kingdomId).filter((a) => a.kind !== "passive");
    // Stagger seats so they do not all decide on the same ticks, matching the
    // heuristic controller's behaviour.
    this.phase = Math.floor(this.rng() * this.period);
  }

  act(ctx: AIContext): void {
    const { match, player, tick } = ctx;
    if ((tick + this.phase) % this.period !== 0) return;
    if (match.phase !== "active" || player.eliminated) return;

    // The observed-damage memory is fed from the gameplay event stream rather
    // than by diffing enemy state, because diffing enemy state would BE the
    // leak this whole subsystem exists to prevent. Subscribed lazily: the
    // controller factory does not receive the match.
    if (!this.subscribed) {
      const bus = match.gameState!.events;
      const seatId = player.id;
      bus.on((event) => this.history.observe(seatId, event));
      this.subscribed = true;
    }

    const knowledge = knowledgeFor(match, player, this.history);
    encode(knowledge, this.obs);
    this.degrade();
    this.network.activate(this.obs, this.out);
    legalActions(knowledge, this.mask);

    if (onlyWaitIsLegal(this.mask)) this.stats.forcedWaits += 1;

    let decision = decide(this.out, this.mask);
    if (this.secondBestRate > 0 && this.rng() < this.secondBestRate) {
      decision = this.secondBest(decision);
    }
    this.stats.decisions += 1;

    this.apply(ctx, knowledge, decision);
  }

  /**
   * Applies the difficulty's observation degradation.
   *
   * Only the four revealed-enemy slots are quantized, and only when they were
   * legitimately revealed in the first place — degradation makes a bot read the
   * board less carefully, it never grants information.
   */
  private degrade(): void {
    if (this.buckets <= 0) return;
    if (this.obs[21] !== 1) return; // nothing was revealed; nothing to blur
    for (let i = 26; i <= 29; i++) {
      this.obs[i] = Math.round(this.obs[i]! * this.buckets) / this.buckets;
    }
  }

  /** Re-decides with the chosen head suppressed. */
  private secondBest(first: Decision): Decision {
    this.altMask.set(this.mask);
    this.altMask[first.primaryIndex] = 0;
    this.altMask[WAIT] = 1; // the floor survives suppression
    return decide(this.out, this.altMask);
  }

  /** The only place in `ai/` that mutates the match. */
  private apply(
    ctx: AIContext,
    knowledge: ReturnType<typeof knowledgeFor>,
    decision: Decision,
  ): void {
    const { match, player } = ctx;

    // Retargeting first, so a cast made this decision uses the new target —
    // the same order a player clicking a castle then an ability produces.
    if (decision.retargetSlot !== null) {
      const enemy = orderEnemies(knowledge)[decision.retargetSlot];
      if (enemy !== undefined) {
        const result = selectTarget(match, player, enemy.id);
        if (result.ok) this.stats.retargets += 1;
        else this.reject("target", result.error);
      }
    }
    if (match.phase !== "active") return;

    const action = decision.primary;
    switch (action.kind) {
      case "wait":
        this.stats.waits += 1;
        return;
      case "buyCitizen": {
        const result = buyCitizen(match, player);
        if (result.ok) this.stats.citizens += 1;
        else this.reject("citizen", result.error);
        return;
      }
      case "repair": {
        const result = repairCastle(match, player);
        if (result.ok) this.stats.repairs += 1;
        else this.reject("repair", result.error);
        return;
      }
      case "buyShield": {
        const result = buyShield(match, player);
        if (result.ok) this.stats.shields += 1;
        else this.reject("shield", result.error);
        return;
      }
      case "invest": {
        const ability = this.kit[action.slot];
        if (ability === undefined) return;
        const result = unlockOrUpgradeAbility(match, player, ability.id);
        if (result.ok) this.stats.invests += 1;
        else this.reject("invest", result.error);
        return;
      }
      case "cast": {
        const ability = this.kit[action.slot];
        if (ability === undefined) return;
        const charges = knowledge.self.kit[action.slot]?.charges ?? null;
        const result = activateAbility(match, player, ability, {
          targetId: player.target ?? undefined,
          chargesToUse: charges
            ? chargesToSpend(
                decision.chargeFraction,
                charges.available,
                charges.costPerCharge,
                knowledge.self.currency,
              )
            : undefined,
        });
        if (result.ok) this.stats.casts += 1;
        else this.reject("cast", result.error);
        return;
      }
    }
  }
}

function onlyWaitIsLegal(mask: ActionMask): boolean {
  for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
    if (i !== WAIT && mask[i] === 1) return false;
  }
  return true;
}

/**
 * A controller driven by a randomly-drawn network.
 *
 * Its purpose is not to play well — it is to prove that game → visibility →
 * knowledge → 64 observations → network → 22 outputs → mask → legal action →
 * game actually carries current, in real matches, before any NEAT code exists.
 * Deliberately unoptimized.
 */
export function randomNetworkAI(difficulty: Difficulty = "hard"): AIFactory {
  return (player, rng) =>
    new NetworkController(player, { network: randomNetwork(rng), rng, difficulty });
}

/** Binds an existing network to the controller contract. */
export function networkAI(
  network: Network,
  difficulty: Difficulty = "hard",
): AIFactory {
  return (player, rng) => new NetworkController(player, { network, rng, difficulty });
}

export { DEFAULT_DECISION_PERIOD };
