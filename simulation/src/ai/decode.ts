import {
  ACTION_SIZE,
  CHARGE_FRACTION,
  PRIMARY_ACTION_COUNT,
  SWITCH_GATE,
  TARGET_BASE,
  TARGET_SLOTS,
  WAIT,
  primaryActionOf,
  type PrimaryAction,
} from "./actions.js";
import type { ActionMask } from "./legality.js";

/**
 * Turns 22 network outputs into one described decision.
 *
 * Pure and engine-free: it returns a DESCRIPTION of what to do, and
 * `controller.ts` is the only thing that turns a description into an engine
 * call. That split is what lets the decoder be tested exhaustively without a
 * match, and what keeps the number of modules touching the simulation at two.
 *
 * Reproducible throughout. With `temperature: 0` the choice is a pure argmax and
 * ties break toward the lower index. Above zero it samples the network's own
 * preference ordering from the SEAT'S SEEDED STREAM, so a given seed still
 * replays exactly — sampling adds variety within a match without adding variance
 * between runs, which is the distinction the evaluation framework cares about.
 */

export interface Decision {
  /** The single action to take this decision. Never null: WAIT is the floor. */
  readonly primary: PrimaryAction;
  /** Index of the chosen primary head, for telemetry. */
  readonly primaryIndex: number;
  /**
   * Target slot to switch to, or null to keep the current target. Independent
   * of `primary` — a seat may retarget and act on the same decision, exactly as
   * a player clicking a castle and then an ability would.
   */
  readonly retargetSlot: number | null;
  /**
   * How hard the network leaned on the charge head, squashed to (0,1). Null
   * when the head is masked off.
   *
   * A FRACTION rather than a count, deliberately. The count depends on which
   * slot was chosen and on what the seat can afford — the engine bills
   * `costPerCharge × chargesPlanned`, so a three-charge cast costs three times
   * a one-charge cast — and the decoder does not know the prices. Resolving the
   * count here produced casts the mask had approved and the engine refused with
   * INSUFFICIENT_FUNDS. `controller.ts` converts it against the chosen slot.
   */
  readonly chargeFraction: number | null;
}

const WAIT_ACTION: PrimaryAction = { kind: "wait" };

/**
 * Picks a LEGAL head, by argmax or by sampling the network's preferences.
 *
 * Illegal heads are skipped rather than penalized, so a network that would have
 * chosen one simply acts on its next preference. Because WAIT is always legal,
 * this cannot fail.
 */
export function decide(
  outputs: Float32Array,
  mask: ActionMask,
  options: { temperature?: number; rng?: () => number } = {},
): Decision {
  if (outputs.length !== ACTION_SIZE) {
    throw new Error(`outputs must be ${ACTION_SIZE}, got ${outputs.length}`);
  }

  const temperature = options.temperature ?? 0;
  const rng = options.rng;
  let bestIndex = WAIT;
  if (temperature > 0 && rng !== undefined) {
    // Sample from the network's own preference ordering rather than taking only
    // its top pick. A pure argmax over a slowly-changing observation returns the
    // same head for thousands of ticks, which makes timing unlearnable; see
    // `difficulty.ts` on temperature.
    let total = 0;
    let peak = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (mask[i] === 1 && outputs[i]! > peak) peak = outputs[i]!;
    }
    const weights: number[] = new Array(PRIMARY_ACTION_COUNT).fill(0);
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (mask[i] !== 1) continue;
      // Shifted by the peak before exponentiating, so a large output cannot
      // overflow into Infinity and make every probability NaN.
      const w = Math.exp((outputs[i]! - peak) / temperature);
      weights[i] = w;
      total += w;
    }
    let roll = rng() * total;
    bestIndex = WAIT;
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (mask[i] !== 1) continue;
      roll -= weights[i]!;
      if (roll <= 0) {
        bestIndex = i;
        break;
      }
    }
  } else {
    let best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (mask[i] !== 1) continue;
      const value = outputs[i]!;
      if (value > best) {
        best = value;
        bestIndex = i;
      }
    }
  }

  // Targeting is a separate channel, suppressed unless the gate is positive.
  let retargetSlot: number | null = null;
  if (mask[SWITCH_GATE] === 1 && outputs[SWITCH_GATE]! > 0) {
    let bestTarget = Number.NEGATIVE_INFINITY;
    for (let slot = 0; slot < TARGET_SLOTS; slot++) {
      if (mask[TARGET_BASE + slot] !== 1) continue;
      const value = outputs[TARGET_BASE + slot]!;
      if (value > bestTarget) {
        bestTarget = value;
        retargetSlot = slot;
      }
    }
  }

  return {
    primary: bestIndex === WAIT ? WAIT_ACTION : primaryActionOf(bestIndex),
    primaryIndex: bestIndex,
    retargetSlot,
    chargeFraction: mask[CHARGE_FRACTION] === 1 ? squash(outputs[CHARGE_FRACTION]!) : null,
  };
}

/**
 * Turns the charge signal into a count the seat can actually pay for.
 *
 * Clamped by both what has regenerated and what the treasury covers, so the
 * network's preference is honoured without ever proposing a cast the engine
 * would refuse. At least one charge, since the cast itself was already approved.
 */
export function chargesToSpend(
  fraction: number | null,
  available: number,
  costPerCharge: number,
  currency: number,
): number | undefined {
  if (fraction === null || available <= 0) return undefined;
  const affordable = costPerCharge > 0 ? Math.floor(currency / costPerCharge) : available;
  const ceiling = Math.min(available, Math.max(1, affordable));
  return Math.min(ceiling, Math.max(1, Math.ceil(fraction * ceiling)));
}

/** Maps an unbounded output onto (0,1) without assuming the activation used. */
function squash(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
