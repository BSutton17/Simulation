import type { KingdomId } from "../../../src/data/kingdoms.js";

/**
 * What each kingdom is FOR, expressed as something a fitness function can score.
 *
 * ⚠️ THE GOAL IS A HABIT, NOT A SCRIPT. A genome that only ever runs its combo
 * is as broken as one that only ever spams — it would throw the line into a
 * losing board because the line pays. So the reward is shaped to make the
 * intended play COMFORTABLE and frequent, never mandatory:
 *
 *   - partial credit for getting part-way, so the first steps are worth taking
 *     before the whole line is learned;
 *   - saturating totals, so the fifth execution is worth far less than the
 *     first and there is nothing to farm;
 *   - and it all sits under `winWeight`, so no amount of stylish play beats
 *     winning.
 *
 * ORDER MATTERS. These are sequences, not sets: Nature's line is Acid Rain to
 * soften, Gastro Acid to poison, Sludge to cash in. The same three casts in the
 * wrong order are three casts, not a combo. Matching is SUBSEQUENCE-based
 * rather than contiguous — other casts may fall between steps, because a real
 * match will interrupt a plan and a genome should not be punished for reacting.
 */

/** A kingdom's intended line, plus anything that pays on top of it. */
export interface Playstyle {
  /**
   * The ordered line. An empty sequence means the kingdom has no combo and is
   * scored on `alternatives` or on its ultimate alone.
   */
  sequence: readonly string[];
  /**
   * Any ONE of these counts as executing the intent.
   *
   * For kingdoms whose identity is a single payoff rather than a chain — Dark
   * wants Unlimited Rage out, Kitsune wants Old Friends or Azure Guidance.
   */
  alternatives?: readonly string[];
  /**
   * Buying a shield counts as the intended play.
   *
   * Earth's whole identity is the shield: "Rock Hard Determination" starts it
   * with one and "Distraught" regenerates it from damage dealt. Its intent is
   * not a cast sequence at all, and bots currently buy 0.04 shields a match.
   */
  shieldIsTheIntent?: boolean;
  /**
   * Executing the line pays extra on top of the flat ultimate bonus.
   *
   * Light's line ENDS in its ultimate and Magma's identity is its ultimate, so
   * both are worth more than a stray ultimate cast elsewhere.
   */
  ultimateBonusInCombo?: boolean;
}

/**
 * ⚠️ VERIFIED AGAINST THE LIVE KITS, not transcribed from memory. Two entries
 * are shaped by facts worth stating:
 *
 *   love/bffs CANNOT BE CAST. It needs a second target, which the 22 action
 *   heads cannot express, so `legality.ts` never offers it. Love's intent is
 *   therefore carried by Cupid's Arrow alone — listing BFFS would set a reward
 *   the policy is structurally unable to earn.
 *
 *   fire HAS NO ULTIMATE. Heat Wave and Blazing Determination are both
 *   `utility`, so Fire cannot earn the flat ultimate bonus at all. Its line is
 *   long enough to compensate, but the asymmetry is in the data, not here.
 */
export const PLAYSTYLES: Record<KingdomId, Playstyle> = {
  // Waterfall applies Current; Flood and Water Ball cash it in through lifesteal.
  water: { sequence: ["waterfall", "flood", "waterBall"] },
  fire: {
    sequence: [
      "heatWave",
      "scorchingSun",
      "blazingDetermination",
      "firenado",
      "fireball",
    ],
  },
  air: { sequence: ["hurricane", "birdsEyeView", "aLightBreeze"] },
  earth: { sequence: [], shieldIsTheIntent: true },
  ice: { sequence: ["floodOfFrost", "freezeToTheCore", "icicle"] },
  // Zap repeated inside the Fate window is the payoff; the repeat penalty is
  // lifted there, see SPAM_EXEMPT_STATUSES in matchObserver.
  electricity: { sequence: ["thunderdome", "thunderingFate", "zap"] },
  nature: { sequence: ["acidRain", "gastroAcid", "sludge"] },
  time: { sequence: ["halfPassed12", "fatherTime", "tikTok"] },
  // Supernova is scored on its METER LEVEL rather than the cast, because firing
  // it at level 1 is the opposite of the intent.
  space: { sequence: ["supernova"] },
  light: {
    sequence: ["fireflies", "illumination", "lightShow"],
    ultimateBonusInCombo: true,
  },
  dark: { sequence: [], alternatives: ["unlimitedRage"] },
  love: { sequence: [], alternatives: ["cupidsArrow"] },
  joker: { sequence: ["aceOfSpades", "blackjack"] },
  kitsune: { sequence: [], alternatives: ["oldFriends", "azureGuidance"] },
  magma: { sequence: [], ultimateBonusInCombo: true },
  insects: { sequence: ["butterflies", "infected", "venomShot"] },
};

/**
 * How far along its line a seat got, as a fraction in [0,1].
 *
 * Subsequence matching, restarting on each fresh attempt: the best run through
 * the line anywhere in the match is what counts. Reacting to the board between
 * steps must not void the attempt.
 */
export function comboProgress(
  kingdomId: KingdomId,
  castSequence: readonly string[],
): number {
  const style = PLAYSTYLES[kingdomId];
  if (!style) return 0;

  if (style.alternatives && style.alternatives.length > 0) {
    return style.alternatives.some((id) => castSequence.includes(id)) ? 1 : 0;
  }
  if (style.sequence.length === 0) return 0;

  // Walk the casts once, advancing through the line and remembering the
  // furthest point reached.
  let step = 0;
  let best = 0;
  for (const cast of castSequence) {
    if (cast === style.sequence[step]) {
      step += 1;
      best = Math.max(best, step);
      if (step === style.sequence.length) step = 0; // completed; allow another run
    }
  }
  return best / style.sequence.length;
}

/** How many times the full line was completed. */
export function comboCompletions(
  kingdomId: KingdomId,
  castSequence: readonly string[],
): number {
  const style = PLAYSTYLES[kingdomId];
  if (!style || style.sequence.length === 0) return 0;
  let step = 0;
  let done = 0;
  for (const cast of castSequence) {
    if (cast === style.sequence[step]) {
      step += 1;
      if (step === style.sequence.length) { done += 1; step = 0; }
    }
  }
  return done;
}

/**
 * The repeat penalty for a run of the same ability.
 *
 * Escalating hard, as asked: a second cast in a row is a nudge, a third is a
 * real cost, a fourth is meant to hurt. Expressed per RUN rather than per cast
 * so that A A A is one penalty of 3-in-a-row, not three separate ones.
 */
export function repeatPenaltyFor(runLength: number): number {
  if (runLength <= 1) return 0;
  if (runLength === 2) return 0.25;
  if (runLength === 3) return 1;
  // Massive, and still bounded — an inactivity-style cliff would make a genome
  // that stops casting altogether score better than one that plays badly.
  return 3 + (runLength - 4);
}

/**
 * Total repeat penalty across a seat's casts, ignoring exempt ones.
 *
 * A cast made under an exemption neither incurs a penalty nor breaks the run it
 * sits in — Zap inside Thundering Fate is invisible to this, in both directions.
 */
export function spamPenalty(
  castSequence: readonly string[],
  exempt: ReadonlySet<number>,
): number {
  let penalty = 0;
  let run = 0;
  let previous: string | null = null;
  for (let i = 0; i < castSequence.length; i++) {
    if (exempt.has(i)) continue;
    const cast = castSequence[i]!;
    if (cast === previous) {
      run += 1;
    } else {
      penalty += repeatPenaltyFor(run);
      run = 1;
      previous = cast;
    }
  }
  penalty += repeatPenaltyFor(run);
  return penalty;
}
