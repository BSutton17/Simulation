import type { MatchRecord } from "../types.js";
import type { MatchFormat } from "./slate.js";
import type { SeatCombat } from "./matchObserver.js";
import type { KingdomId } from "../../../src/data/kingdoms.js";
import { PLAYSTYLES, comboProgress, spamPenalty } from "./playstyle.js";

/**
 * AI fitness — how good a PLAYER is.
 *
 * Deliberately not the balance fitness in `fitness/fitness.ts`. That scores how
 * far a 21,000-match reading sits from parity across sixteen kingdoms; it is a
 * property of a balance configuration, and a single genome has no win-rate
 * spread to be fair about. Reusing it here would be a category error.
 *
 * The formula is small on purpose. Four terms, each observable in the result,
 * and winning dominates. A pile of shaping rewards is how a fitness function
 * becomes something nobody can reason about and a policy learns to farm.
 */

export const AI_FITNESS_VERSION = "v5";

/** Everything one evaluation match produced. Kept whole, not reduced to a number. */
export interface ScenarioResult {
  scenarioId: string;
  format: MatchFormat;
  seats: number;
  kingdom: string;
  seat: number;

  // outcome
  placement: number;
  won: boolean;
  drawn: boolean;
  lost: boolean;
  eliminated: boolean;
  timedOut: boolean;

  // survival
  endedAtTick: number;
  survivedTicks: number;
  survivedFraction: number;
  hpRemaining: number;
  hpFraction: number;

  // combat
  damageDealt: number;
  damageReceived: number;
  kills: number;

  // behaviour
  casts: number;
  invests: number;
  citizensBought: number;
  repairs: number;
  shields: number;
  retargets: number;
  waits: number;
  decisions: number;
  forcedWaits: number;
  /** How many of this kingdom's abilities were cast at least once. */
  distinctAbilities: number;
  /** How many it had to choose from. */
  kitSize: number;

  // scoring
  score: number;
  /** Per-term contributions, so a score can always be taken apart. */
  terms: FitnessTerms;
}

export interface FitnessTerms {
  win: number;
  placement: number;
  survival: number;
  combat: number;
  activity: number;
  variety: number;
  resource: number;
  /** The kingdom's intended line, in full or in part. */
  combo: number;
  /** Casting the kingdom's ultimate at all. */
  ultimate: number;
  /** Holding a shield through Light Show, and breaking a volcano. */
  defense: number;
  /**
   * Repeating one ability, as a NEGATIVE contribution.
   *
   * Recorded like any other term so a score can be taken apart, but it is the
   * only one that subtracts.
   */
  spam: number;
  /** Multiplier applied by the guards (1 = untouched). */
  guard: number;
  guardReason: string | null;
}

export interface FitnessConfig {
  /** Outright victory. Dominant by design. */
  winWeight: number;
  /** Normalized placement, 1 = first. Carries the free-for-all signal. */
  placementWeight: number;
  /** Fraction of the match survived. Small: a tiebreak between losses. */
  survivalWeight: number;
  /**
   * Damage dealt as a share of damage exchanged, in [0,1].
   *
   * A ratio rather than raw damage, deliberately. Raw damage is farmable — the
   * volcano is a legal target that is not a kingdom — while a ratio rewards
   * winning exchanges, which is what fighting well actually looks like.
   */
  combatWeight: number;
  /**
   * Ceiling on a match that hit the tick cap.
   *
   * Without it, turtling wins: placement ranks timeout survivors by remaining
   * HP, so a genome that buys shields and never attacks places first having
   * accomplished nothing. The baseline produces timeouts at roughly one match
   * in eighty, so the state is reachable.
   */
  timeoutCap: number;
  /** Score for a match in which the genome never cast anything. */
  inactivityScore: number;
  /**
   * A small, SATURATING reward for acting at all.
   *
   * The inactivity guard is all-or-nothing: one cast passes it, zero fails. That
   * leaves a wide flat basin between "did nothing" and "played", and evolution
   * has no gradient across it. This gives the basin a slope.
   *
   * Saturating is the whole design. It pays up to `activityTarget` casts and not
   * one point beyond, so it cannot be farmed by spamming the cheapest ability —
   * which is exactly the failure mode a naive damage-or-actions reward produces,
   * and which this project has already measured in its heuristic controller.
   * Past the target the term is constant and winning is the only thing left to
   * optimise, so the AI still decides for itself when waiting is right.
   */
  activityWeight: number;
  /** Casts at which the activity reward is fully paid. */
  activityTarget: number;
  /**
   * Using a WIDE PART OF THE KIT, as a fraction of it.
   *
   * ⚠️ THE PROBLEM THIS EXISTS FOR. v1 and v2 rewarded winning, and spamming the
   * cheapest attack wins: measured, the cheapest ability has the best
   * damage-per-gold in nine of sixteen kingdoms and the best sustained damage in
   * thirteen. A policy that banks for an ultimate deals less damage while it
   * saves, so evolution correctly learned never to. The trained champion's
   * wallet never once exceeded 290 gold against ultimates costing 300 to 1,345,
   * and sixteen of eighty abilities were never cast in a whole evaluation.
   *
   * So the reward is for RANGE, not volume: the share of this kingdom's kit cast
   * at least once. Casting one ability four hundred times scores exactly what
   * casting it once scores. That is what makes it a variety term rather than
   * another way to pay for spam.
   *
   * NOT a rule about when to use anything. Nothing here says "cast the ultimate
   * at 3,000 gold" or "shield below half health" — the term says only that a
   * kingdom's tools are worth reaching for, and leaves evolution to discover
   * when. A scripted trigger would be a hand-written policy wearing a fitness
   * function's clothes.
   */
  varietyWeight: number;
  /**
   * Playing the kingdom the way it was designed to be played.
   *
   * ⚠️ A HABIT, NOT A SCRIPT. Partial credit means the first two steps of a
   * five-step line already pay, so the behaviour can be learned incrementally
   * instead of only rewarding a finished combo nobody stumbles into. The term
   * saturates, so a genome cannot farm it by running the line and nothing else,
   * and it sits under winWeight so a combo never beats a victory.
   */
  comboWeight: number;
  /**
   * Casting the kingdom's ultimate at all.
   *
   * Deliberately large. Ultimates are the abilities the policy never buys —
   * measured, 13 of 16 never-cast abilities are never even unlocked — so the
   * reward has to be worth the detour of saving for one.
   */
  ultimateWeight: number;
  /**
   * Reacting to the two telegraphed threats in the game.
   *
   * ⚠️ THE ONLY TERM THAT SCORES READING THE BOARD. Light Show announces itself
   * and a volcano stands in the middle of the field on a timer — both are
   * visible, and both punish a policy that just keeps casting. Holding a shield
   * through the first and helping break the second are the two places where
   * paying attention beats acting, so they are worth paying for directly.
   *
   * Small on purpose: these are situational, and a genome that never meets a
   * Light Show or a volcano must not be scored as though it failed.
   */
  defenseWeight: number;
  /**
   * Cost of casting the same ability consecutively.
   *
   * Scales with the run: a pair is a nudge, a triple costs real score, four or
   * more is meant to hurt. Multiplied by `repeatPenaltyFor`, which returns the
   * shape.
   */
  spamWeight: number;
  /** Ceiling on the spam penalty, as a share of the scale. */
  spamCap: number;
  /**
   * Spending on DEFENCE AND UPKEEP — shields and repairs — saturating.
   *
   * Bots buy essentially no shields today (0.16 per match across a full
   * evaluation), because gold spent on a shield is gold not spent on damage and
   * only damage was ever rewarded. Same shape as variety and for the same
   * reason: it opens the door without dictating when to walk through it.
   */
  resourceWeight: number;
  /** Shields + repairs per match at which the resource term is fully paid. */
  resourceTarget: number;
}

export const DEFAULT_FITNESS: FitnessConfig = {
  winWeight: 1,
  // ⚠️ PLACEMENT AND COMBAT WERE CUT to pay for variety, and the cut is the
  // point rather than a side effect. Both reward "did damage" — placement ranks
  // timeout survivors by remaining HP, combat by share of damage exchanged — so
  // both were REINFORCING the behaviour variety exists to displace. Spamming
  // the cheapest attack maximises damage per second, which is exactly how these
  // two terms are earned.
  //
  // Measured at the old weights over 250 generations: kit reach sat at 2.7 of 5
  // and never moved, while the champion's win rate climbed. Evolution optimised
  // what was worth the most, which was damage. Outbidding that by raising
  // variety alone would have pushed the shaping terms past winWeight and let a
  // stylish loss beat a scrappy win; taking the budget from the terms that
  // cause the problem keeps winning on top AND removes the incentive.
  //
  // ⚠️ EVERY SHAPING TERM WAS TRIMMED to pay for combo and ultimate without
  // breaking the rule that winning outranks everything else combined. The
  // non-win terms now total 0.93, still under winWeight's 1.00.
  //
  // Variety took the largest cut, from 0.30 to 0.12, because COMBO SUBSUMES IT:
  // a kingdom's intended line uses three to five different abilities by
  // construction, so paying for range separately was paying twice for the same
  // behaviour. Variety remains only to keep kingdoms whose intent is a single
  // ability (Dark, Kitsune, Love) from collapsing onto one cast.
  //
  // was 0.20
  placementWeight: 0.12,
  // was 0.10
  survivalWeight: 0.06,
  // was 0.10
  combatWeight: 0.06,
  timeoutCap: 0.25,
  inactivityScore: 0,
  // Deliberately smaller than every other term: it exists to leave the
  // do-nothing basin, not to compete with winning.
  activityWeight: 0.05,
  activityTarget: 20,
  // ⚠️ WINNING MUST REMAIN THE TOP PRIORITY, and that is an arithmetic property
  // rather than an intention: every non-win term sums to 0.84, which is less
  // than winWeight's 1.0. So a win with the worst possible resource use still
  // outscores a loss with the best possible. The margin survived raising
  // variety from 0.12 to 0.30 only because placement and combat paid for it —
  // raising variety alone would have totalled 1.04 and inverted the rule.
  varietyWeight: 0.1,
  comboWeight: 0.25,
  ultimateWeight: 0.15,
  defenseWeight: 0.06,
  // Applied per repeat-run via `repeatPenaltyFor`, then capped.
  spamWeight: 0.06,
  // ⚠️ CAPPED ON PURPOSE. An uncapped escalating penalty makes casting nothing
  // score better than playing badly, and the inactivity guard already owns that
  // failure mode. The cap keeps spam strictly worse than varied play without
  // making silence attractive.
  spamCap: 0.45,
  resourceWeight: 0.04,
  resourceTarget: 3,
};

/** The largest score the formula can produce, for normalizing reports. */
export function maxScore(config: FitnessConfig): number {
  return (
    config.winWeight +
    config.placementWeight +
    config.survivalWeight +
    config.combatWeight +
    config.activityWeight +
    config.varietyWeight +
    config.resourceWeight +
    config.comboWeight +
    config.ultimateWeight +
    config.defenseWeight
    // The spam penalty is excluded deliberately: it only ever subtracts, so it
    // cannot raise the ceiling, and including it would understate the maximum a
    // clean genome can actually reach.
  );
}

/** Finishing position, 1 = winner. Mirrors `evaluation/jobs.ts:runJob`. */
export function placementOf(record: MatchRecord, playerId: string): number {
  const ordered = [...record.players].sort((x, y) => {
    if (x.id === record.winnerId) return -1;
    if (y.id === record.winnerId) return 1;
    const xd = x.eliminatedAtTick;
    const yd = y.eliminatedAtTick;
    if (xd === null && yd === null) return y.hp - x.hp;
    if (xd === null) return -1;
    if (yd === null) return 1;
    return yd - xd;
  });
  return ordered.findIndex((p) => p.id === playerId) + 1;
}

export interface ScenarioContext {
  scenarioId: string;
  format: MatchFormat;
  seats: number;
  kingdom: string;
  seat: number;
  combat: SeatCombat;
  behaviour: {
    casts: number;
    invests: number;
    citizens: number;
    repairs: number;
    shields: number;
    retargets: number;
    waits: number;
    decisions: number;
    /**
     * Decisions where WAIT was the ONLY legal action.
     *
     * The difference between a policy that chooses to do nothing and one that
     * has nothing to do. Without it a 94%-wait genome is unexplainable: it could
     * be a network biased toward one output, or a seat that cannot afford, has
     * unlocked nothing, and has no legal target.
     */
    forcedWaits: number;
    /** Distinct ability ids cast this match — RANGE, not volume. */
    distinctAbilities: number;
    /** Castable abilities available to this seat. */
    kitSize: number;
    /**
     * Every cast IN ORDER, and the indices exempt from the repeat penalty.
     *
     * Order is what separates a rotation from spam and a combo from three
     * unrelated casts, and a Set cannot carry it. See `matchObserver`.
     */
    castSequence: readonly string[];
    exemptCasts: ReadonlySet<number>;
    /** Casts of this kingdom's `ultimate`-kind abilities. */
    ultimateCasts: number;
  };
}

/**
 * Scores one match from the genome's point of view.
 *
 * Every term is recorded alongside the total, so a surprising fitness can be
 * taken apart without re-running the match.
 */
export function scoreScenario(
  record: MatchRecord,
  playerId: string,
  context: ScenarioContext,
  config: FitnessConfig,
): ScenarioResult {
  const seats = record.players.length;
  const placement = placementOf(record, playerId);
  const me = record.players.find((p) => p.id === playerId)!;
  const won = record.winnerId === playerId;
  // A draw is the engine's no-survivors outcome: the match ended, nobody won.
  const drawn = record.winnerId === null && !record.timedOut;
  const eliminated = me.eliminatedAtTick !== null;
  const lost = !won && !drawn;

  const survivedTicks = me.eliminatedAtTick ?? record.endedAtTick;
  const survivedFraction = survivedTicks / Math.max(1, record.endedAtTick);
  const hpFraction = Math.max(0, Math.min(1, me.hp / 10_000));

  const normalizedPlacement = seats > 1 ? (seats - placement) / (seats - 1) : won ? 1 : 0;
  const exchanged = context.combat.damageDealt + context.combat.damageReceived;
  const combatShare = exchanged > 0 ? context.combat.damageDealt / exchanged : 0;

  const terms: FitnessTerms = {
    win: won ? config.winWeight : 0,
    placement: config.placementWeight * normalizedPlacement,
    survival: config.survivalWeight * survivedFraction,
    combat: config.combatWeight * combatShare,
    activity:
      config.activityWeight *
      Math.min(1, context.behaviour.casts / Math.max(1, config.activityTarget)),
    // Share of the kit reached, so repetition adds nothing.
    variety:
      config.varietyWeight *
      (context.behaviour.kitSize > 0
        ? Math.min(1, context.behaviour.distinctAbilities / context.behaviour.kitSize)
        : 0),
    resource:
      config.resourceWeight *
      Math.min(
        1,
        (context.behaviour.shields + context.behaviour.repairs) /
          Math.max(1, config.resourceTarget),
      ),
    // ── the kingdom's intended play ──────────────────────────────────────
    //
    // Partial credit by design: `comboProgress` returns how far along the line
    // the seat got, so two steps of Fire's five already pay. A genome cannot
    // learn a five-cast sequence that only rewards completion — there is
    // nothing to climb toward.
    //
    // Earth is the exception the data forces: its intent is the SHIELD, not a
    // cast sequence, so buying one is what scores.
    combo:
      config.comboWeight *
      (PLAYSTYLES[context.kingdom as KingdomId]?.shieldIsTheIntent
        ? Math.min(1, context.behaviour.shields)
        : comboProgress(context.kingdom as KingdomId, context.behaviour.castSequence)),
    // Flat, and paid on the FIRST ultimate rather than per cast. The problem is
    // that ultimates are never reached at all; paying per cast would reward
    // spamming one once it is, which is the behaviour the repeat penalty exists
    // to stop.
    ultimate: context.behaviour.ultimateCasts > 0 ? config.ultimateWeight : 0,
    // Reacting to what the board announced. Saturating, so one good read pays
    // most of the term and a genome cannot farm it by hoarding shields.
    defense:
      config.defenseWeight *
      Math.min(
        1,
        Math.min(1, context.combat.shieldedVsLightShow) * 0.5 +
          Math.min(1, context.combat.volcanoShare) * 0.5,
      ),
    // Negative. Subtracted below rather than added.
    spam: -Math.min(
      config.spamCap,
      config.spamWeight *
        spamPenalty(context.behaviour.castSequence, context.behaviour.exemptCasts),
    ),
    guard: 1,
    guardReason: null,
  };

  let score =
    terms.win +
    terms.placement +
    terms.survival +
    terms.combat +
    terms.activity +
    terms.variety +
    terms.resource +
    terms.combo +
    terms.ultimate +
    terms.defense +
    // Already negative. Floored at zero so the worst possible spammer scores
    // nothing rather than going negative and inverting comparisons downstream.
    terms.spam;
  score = Math.max(0, score);

  // Guards. Both describe strategies that score well while accomplishing
  // nothing, and both are reachable in this game.
  if (context.behaviour.casts === 0) {
    score = config.inactivityScore;
    terms.guard = 0;
    terms.guardReason = "never cast";
  } else if (record.timedOut && score > config.timeoutCap) {
    // SQUASHED PROPORTIONALLY, not clamped to a constant.
    //
    // Clamping made every timed-out match score EXACTLY the cap, so all
    // ordering between them was destroyed: in a run where matches routinely
    // time out, a whole population scored 0.2500 and selection had nothing to
    // read. Measured — six generations of identical best fitness and a frozen
    // champion, which looked like a broken search and was a flat scoring
    // function.
    //
    // The cap's purpose is that a timeout must never pay like a win; it is not
    // that every timeout is equally good. Scaling into [0, cap] keeps the
    // ceiling exactly where it was while preserving which of two stalemates was
    // played better.
    const ceiling = maxScore(config);
    terms.guard = (config.timeoutCap * (score / ceiling)) / score;
    terms.guardReason = "timeout";
    score = config.timeoutCap * (score / ceiling);
  }

  return {
    scenarioId: context.scenarioId,
    format: context.format,
    seats: context.seats,
    kingdom: context.kingdom,
    seat: context.seat,
    placement,
    won,
    drawn,
    lost,
    eliminated,
    timedOut: record.timedOut,
    endedAtTick: record.endedAtTick,
    survivedTicks,
    survivedFraction,
    hpRemaining: me.hp,
    hpFraction,
    damageDealt: context.combat.damageDealt,
    damageReceived: context.combat.damageReceived,
    kills: context.combat.kills,
    casts: context.behaviour.casts,
    invests: context.behaviour.invests,
    citizensBought: context.behaviour.citizens,
    repairs: context.behaviour.repairs,
    shields: context.behaviour.shields,
    retargets: context.behaviour.retargets,
    waits: context.behaviour.waits,
    decisions: context.behaviour.decisions,
    forcedWaits: context.behaviour.forcedWaits,
    distinctAbilities: context.behaviour.distinctAbilities,
    kitSize: context.behaviour.kitSize,
    score,
    terms,
  };
}

/** A genome's result over a whole slate. */
export interface TrainingResult {
  fitness: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  totalDamageDealt: number;
  totalDamageReceived: number;
  totalKills: number;
  totalCasts: number;
  scenarios: ScenarioResult[];
}

export function aggregate(scenarios: readonly ScenarioResult[]): TrainingResult {
  const all = [...scenarios];
  if (all.length === 0) {
    return {
      fitness: 0, matches: 0, wins: 0, losses: 0, draws: 0, timeouts: 0, inactive: 0,
      meanPlacement: 0, totalDamageDealt: 0, totalDamageReceived: 0, totalKills: 0,
      totalCasts: 0, scenarios: [],
    };
  }
  const sum = (pick: (s: ScenarioResult) => number): number =>
    all.reduce((total, s) => total + pick(s), 0);
  return {
    fitness: sum((s) => s.score) / all.length,
    matches: all.length,
    wins: all.filter((s) => s.won).length,
    losses: all.filter((s) => s.lost).length,
    draws: all.filter((s) => s.drawn).length,
    timeouts: all.filter((s) => s.timedOut).length,
    inactive: all.filter((s) => s.casts === 0).length,
    meanPlacement: sum((s) => s.placement) / all.length,
    totalDamageDealt: sum((s) => s.damageDealt),
    totalDamageReceived: sum((s) => s.damageReceived),
    totalKills: sum((s) => s.kills),
    totalCasts: sum((s) => s.casts),
    scenarios: all,
  };
}
