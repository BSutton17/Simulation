import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Time Kingdom ability set — pure data on the shared frameworks. The kingdom's
 * identity: "Time forces players to either increase or decrease their speed of
 * play." Grandfather-clock theme (brown & beige) lives in the client.
 *
 * SCOPE (current pass): only **Tik Tok** is wired as a fully-working basic
 * attack (damage + client bolt), matching every other kingdom's "Q". The four
 * remaining abilities are scaffolded as valid, castable definitions with their
 * damage where the design says "deals damage", and their SPECIAL mechanics
 * marked `TODO` — deliberately not yet built (see each ability). Magnitudes are
 * initial, tunable defaults.
 *
 * Passives are not yet designed (see KINGDOM_PASSIVES.time in kingdoms.ts).
 */

/**
 * Tik Tok (basic): a straightforward Time attack — the reliable "Q". No special
 * mechanic, mirrors every other kingdom's basic bolt.
 */
export const TIK_TOK: AbilityDefinition = {
  id: "tikTok",
  name: "Tik Tok",
  kind: "attack",
  cost: 84,
  cooldownTicks: Math.round(4.35 * TICK.RATE), // 3.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 238, element: "time" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: { effectParams: [{ amount: 205 }] },
    },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9), // 54 ticks (2.7 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15%
      },
    },
    {
      level: 3,
      cost: 400,
      changes: { effectParams: [{ amount: 270 }] },
    },
  ],
};

/**
 * "Scrambled" — the mark Half Passed 12 leaves: the victim's UI is scrambled.
 * Declared here so the status id is stable; the actual client scramble VFX is a
 * later pass ("don't worry about effects for now").
 *
 * TODO(time): once effects land, wire the UI-scramble visual to this status id
 * (client), likely via the `vision` effect primitive.
 */
export const SCRAMBLED_STATUS: StatusEffectDefinition = {
  id: "scrambled",
  name: "Scrambled",
  category: "debuff",
  stacking: "refresh",
};

/**
 * Half Passed 12 (med): "Devastating time attack that scrambles the player's UI
 * for 12 seconds." Deals moderate damage now; the UI-scramble status is applied
 * but its client visual is TODO (effects pass).
 */
export const HALF_PASSED_12: AbilityDefinition = {
  id: "halfPassed12",
  name: "Half Passed 12",
  kind: "attack",
  cost: 141,
  cooldownTicks: Math.round(16.5 * TICK.RATE), // 27.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 461, element: "time" },
    },
    // TODO(time): the "scramble the UI" effect. The status is applied so the
    // mechanic hook exists; the client scramble visual is a later pass.
    {
      type: "status",
      target: "target",
      params: { status: SCRAMBLED_STATUS, durationTicks: 12 * TICK.RATE }, // 12 s
    },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 620 }] } },
    { level: 2, cost: 300, changes: { effectParams: [{ amount: 730 }] } },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // Lv5: the scramble lasts longer (12 s -> 16 s).
    { level: 4, cost: 500, changes: { effectParams: [null, { durationTicks: 16 * TICK.RATE }] } },
  ],
};

/**
 * Father Time's Mark — applied by Father Time after its heavy strike. Once per
 * second (`intervalTicks`) it deals damage, but ONLY while the bearer has not
 * landed a damaging attack in that second (`onlyIfBearerIdleSinceLastTick`):
 * attacking someone "buys back" the second and resets the countdown. Punishes
 * hesitation — keep attacking or bleed. The bleed doubles (100 → 200) once the
 * mark passes its halfway point — the longer you hesitate, the worse it gets.
 */
export const FATHER_TIME_MARK: StatusEffectDefinition = {
  id: "fatherTimeMark",
  name: "Father Time's Mark",
  category: "debuff",
  stacking: "refresh",
  tickEffects: [
    {
      type: "damage",
      amount: 100, // per idle second in the first half
      amountAfterHalfLife: 200, // …doubling past the halfway point
      intervalTicks: TICK.RATE, // once per second
      onlyIfBearerIdleSinceLastTick: true,
    },
  ],
};

/**
 * Father Time (heavy): heavy up-front damage, then marks the victim. For every
 * second they fail to land a damaging attack, Father Time's Mark bleeds them.
 */
export const FATHER_TIME: AbilityDefinition = {
  id: "fatherTime",
  name: "Father Time",
  kind: "attack",
  cost: 593,
  cooldownTicks: Math.round(13.35 * TICK.RATE), // 22.25 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 570, element: "time" },
    },
    {
      type: "status",
      target: "target",
      params: { status: FATHER_TIME_MARK, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    { level: 1, cost: 250, changes: { effectParams: [{ amount: 885 }] } },
    { level: 2, cost: 400, changes: { effectParams: [{ amount: 1025 }] } },
    {
      level: 3,
      cost: 500,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // Lv5: the Mark lingers longer (10 s -> 14 s), more idle seconds to punish.
    { level: 4, cost: 600, changes: { effectParams: [null, { durationTicks: 14 * TICK.RATE }] } },
  ],
};

/**
 * Blip! (utility): "The most recent attack done to Time is undone — including
 * all immediate damage, lingering status effects, and any DoT/status-based
 * damage that originated from that attack." Reads the caster's attack journal
 * (playerState.attackJournal) and reverses its last successful incoming attack:
 * heals the HP it took, restores the shield it absorbed, and strips its
 * statuses. Fizzles harmlessly if nothing has hit you recently.
 */
export const BLIP: AbilityDefinition = {
  id: "blip",
  name: "Blip!",
  kind: "utility",
  cost: 105,
  cooldownTicks: Math.round(5.4 * TICK.RATE), // 9 s
  targeting: { mode: "self" },
  effects: [
    { type: "undoLastAttack", target: "self", params: {} },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(15 * TICK.RATE * 0.85), // 12.75 s
        costMultiplier: 0.85,
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(15 * TICK.RATE * 0.7), // 10.5 s
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Rewinding — the mark Back to the Future puts on every enemy: time runs
 * backward on their treasury, so instead of earning income they LOSE it each
 * tick (their own gold/sec rate, floored at 0), via `drainsIncome`.
 */
export const GOLD_REWIND_STATUS: StatusEffectDefinition = {
  id: "goldRewind",
  name: "Back to the Future",
  category: "debuff",
  stacking: "refresh",
  drainsIncome: true,
};

/**
 * Back to the Future (ultimate): rewinds every enemy castle's gold for 10
 * seconds — each loses income at its own rate (25 g/s → 250 gold lost),
 * bottoming out at 0. Applies the Rewinding status to all enemies.
 */
export const BACK_TO_THE_FUTURE: AbilityDefinition = {
  id: "backToTheFuture",
  name: "Back to the Future",
  kind: "ultimate",
  cost: 900,
  cooldownTicks: 90 * TICK.RATE, // 90 s
  targeting: { mode: "allEnemies" },
  effects: [
    {
      type: "status",
      target: "target",
      params: { status: GOLD_REWIND_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      // Lv2: the rewind lasts longer (10 s -> 14 s).
      changes: { effectParams: [{ durationTicks: 14 * TICK.RATE }] },
    },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85), // 76.5 s
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Time kingdom's activatable ability set. */
export const TIME_ABILITIES: AbilityDefinition[] = [
  TIK_TOK,
  HALF_PASSED_12,
  FATHER_TIME,
  BLIP,
  BACK_TO_THE_FUTURE,
];
