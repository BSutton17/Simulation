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
import {
  ACTION_SIZE,
  CAST_BASE,
  INVEST_BASE,
  KIT_SLOTS,
  PRIMARY_ACTION_COUNT,
  WAIT,
  orderEnemies,
} from "./actions.js";
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
  /** Overrides the difficulty's sampling temperature. 0 forces a pure argmax. */
  readonly temperature?: number;
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
  /**
   * Decisions where the chosen head differed from the previous decision's.
   *
   * The difference between a policy and a constant. A deterministic argmax over
   * an observation that changes slowly can return the SAME head for thousands of
   * consecutive ticks — which is not "learning when to wait", it is a network
   * that cannot express a change of mind. Low switching with a high legal-action
   * count means evolution is being asked to learn timing through a mechanism
   * that cannot represent it.
   */
  actionSwitches: number;
  /** Distinct heads chosen across the match, out of 22. */
  distinctActions: number;
  /** Summed legal actions over all decisions, for the choice-per-decision rate. */
  legalOffered: number;
  /**
   * Per kit slot: decisions on which casting it was LEGAL, and on which it was
   * actually CHOSEN.
   *
   * ⚠️ THE TWO NUMBERS ANSWER DIFFERENT QUESTIONS, and only together do they
   * say whether balance can fix a dead ability. An ability that is never legal
   * is out of reach — unaffordable, gated behind a meter or a status — and no
   * amount of retuning its damage will make it appear. One that is legal all
   * match and never chosen is being REJECTED on value, which is exactly what a
   * price or a damage figure controls.
   *
   * Fourteen of eighty abilities are never cast. Which of those two groups they
   * fall into decides whether a balance search can reach 80/80 at all.
   */
  castLegal: number[];
  castChosen: number[];
  /**
   * WHY a slot was not castable, counted per decision and per reason.
   *
   * ⚠️ "NEVER LEGAL" IS THREE DIFFERENT PROBLEMS WEARING ONE LABEL, and the
   * distinction decides who can fix it:
   *
   *   notUnlocked  — the policy never spent the gold to BUY the ability. That is
   *     an investment decision, not a price one. A cheaper ultimate still never
   *     appears if the network would rather buy citizens.
   *   notAffordable — bought, but never enough gold in hand to cast. THIS is the
   *     one a price change fixes.
   *   otherwise blocked — cooldown, charges, a meter, a status, the centrepiece,
   *     or a payload the action space cannot express.
   *
   * Balance V4 assumed the middle case and moved prices. Coverage went from
   * 64/80 to 62/80, so the assumption is worth checking rather than repeating.
   */
  castBlockedNotUnlocked: number[];
  castBlockedNotAffordable: number[];
  castBlockedOther: number[];
  /** Decisions on which BUYING this slot was affordable, and on which it was bought. */
  investAffordable: number[];
  investChosen: number[];
}

export class NetworkController implements AIController {
  private readonly network: Network;
  private readonly rng: Rng;
  private readonly period: number;
  private readonly secondBestRate: number;
  private readonly buckets: number;
  private readonly temperature: number;

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
    actionSwitches: 0, distinctActions: 0, legalOffered: 0,
    castLegal: new Array<number>(KIT_SLOTS).fill(0),
    castChosen: new Array<number>(KIT_SLOTS).fill(0),
    castBlockedNotUnlocked: new Array<number>(KIT_SLOTS).fill(0),
    castBlockedNotAffordable: new Array<number>(KIT_SLOTS).fill(0),
    castBlockedOther: new Array<number>(KIT_SLOTS).fill(0),
    investAffordable: new Array<number>(KIT_SLOTS).fill(0),
    investChosen: new Array<number>(KIT_SLOTS).fill(0),
  };

  /** Diagnostics only: what was chosen last, and everything chosen so far. */
  private previousAction = -1;
  private readonly actionsSeen = new Set<number>();

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
    this.temperature = options.temperature ?? config.temperature;
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
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (this.mask[i] === 1) this.stats.legalOffered += 1;
    }
    for (let slot = 0; slot < KIT_SLOTS; slot++) {
      if (this.mask[CAST_BASE + slot] === 1) {
        this.stats.castLegal[slot]! += 1;
        continue;
      }
      // Attributed in the order the player experiences them: an ability you have
      // not bought is not "too expensive to cast", it is not yours yet.
      const kit = knowledge.self.kit[slot];
      if (kit === undefined) continue;
      if (!kit.unlocked) this.stats.castBlockedNotUnlocked[slot]! += 1;
      else if (!kit.affordable) this.stats.castBlockedNotAffordable[slot]! += 1;
      else this.stats.castBlockedOther[slot]! += 1;
      if (kit.investAffordable) this.stats.investAffordable[slot]! += 1;
    }

    let decision = decide(this.out, this.mask, {
      temperature: this.temperature,
      rng: this.rng,
    });
    if (this.secondBestRate > 0 && this.rng() < this.secondBestRate) {
      decision = this.secondBest(decision);
    }
    this.stats.decisions += 1;
    if (this.previousAction >= 0 && decision.primaryIndex !== this.previousAction) {
      this.stats.actionSwitches += 1;
    }
    if (
      decision.primaryIndex >= CAST_BASE &&
      decision.primaryIndex < CAST_BASE + KIT_SLOTS
    ) {
      this.stats.castChosen[decision.primaryIndex - CAST_BASE]! += 1;
    }
    if (
      decision.primaryIndex >= INVEST_BASE &&
      decision.primaryIndex < INVEST_BASE + KIT_SLOTS
    ) {
      this.stats.investChosen[decision.primaryIndex - INVEST_BASE]! += 1;
    }
    this.previousAction = decision.primaryIndex;
    this.actionsSeen.add(decision.primaryIndex);
    this.stats.distinctActions = this.actionsSeen.size;

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
    return decide(this.out, this.altMask, { temperature: this.temperature, rng: this.rng });
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
