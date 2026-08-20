import type { PlayerKnowledge } from "./knowledge.js";
import { KIT_SLOTS } from "./actions.js";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { OBSERVATION_VERSION } from "./versions.js";
import { visibilitySpecHash } from "./visibility.js";

/**
 * The observation vector: exactly 64 floats, all in [0,1] or [-1,1].
 *
 * Consumes `PlayerKnowledge` and nothing else, so it is structurally incapable
 * of reading hidden state — the fields simply are not on the type. That is the
 * point: the encoder is a dumb projection, and all the judgement lives one
 * module upstream where it can be reviewed as a table.
 *
 * Unbounded quantities go through `tanh`, never division by a hand-picked
 * constant. A CMA-ES balance search is concurrently moving costs, cooldowns and
 * damage by ±40–60%, and a divisor calibrated against today's numbers would
 * quietly mis-scale under tomorrow's. A saturating squash degrades gracefully
 * where a divisor does not.
 */

export const OBSERVATION_SIZE = 80;

/** Where the kingdom one-hot starts. */
export const KINGDOM_BASE = 64;

/** Where each group starts, so the layout is stated once. */
export const SELF_BASE = 0;
export const FIELD_BASE = 14;
export const REVEAL_BASE = 21;
export const TARGET_BASE = 24;
export const KIT_BASE = 34;
/** Values per ability slot. */
export const KIT_STRIDE = 6;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const bit = (b: boolean): number => (b ? 1 : 0);

/**
 * The neutral stand-in for a value this seat cannot see.
 *
 * 0.5 rather than 0, and always paired with the reveal flag at index 21. A
 * hidden HP encoded as 0 reads as "they are dead" — actionable, and wrong. The
 * network can only tell 0.5-because-unknown from a genuine 50% by consulting
 * the flag, which is exactly why the flag is an input.
 */
export const UNKNOWN = 0.5;

/** Ability kinds as one normalized ordinal, so a slot stays six values wide. */
function kindValue(kind: string): number {
  return kind === "attack" ? 0 : kind === "utility" ? 0.5 : 1;
}

/**
 * Writes this seat's observation into `out`.
 *
 * Allocation-free on a warm buffer: the caller owns a single `Float32Array` for
 * the life of the controller. The AI is already the dominant cost in a
 * simulated match, and a per-decision allocation at 4 Hz × 7 seats × 12,000
 * ticks is not a rounding error.
 */
export function encode(knowledge: PlayerKnowledge, out: Float32Array): void {
  if (out.length !== OBSERVATION_SIZE) {
    throw new Error(`observation buffer must be ${OBSERVATION_SIZE}, got ${out.length}`);
  }
  const { self, field, reveal } = knowledge;

  // ── Group 1 · self (0–13) — always fully known ────────────────────────
  out[0] = clamp01(self.hp / Math.max(1, self.maxHp));
  out[1] = clamp01(self.shield / STANDARD_SHIELD_HP);
  out[2] = Math.tanh(self.currency / 1000);
  out[3] = Math.tanh(self.incomePerTick / 1.5);
  out[4] = clamp01(self.citizens / 40);
  out[5] = clamp01(1 - self.repairsUsed / Math.max(1, self.maxRepairs));
  out[6] = self.repairCost > 0 ? clamp01(self.currency / self.repairCost) : 0;
  out[7] = self.shieldCost > 0 ? clamp01(self.currency / self.shieldCost) : 0;
  out[8] = self.meter ? clamp01(self.meter.value / Math.max(1, self.meter.full)) : 0;
  out[9] = bit(self.meter !== null);
  out[10] = bit(self.offensiveLock);
  out[11] = bit(self.economicLock);
  out[12] = bit(self.targetingLock);
  out[13] = bit(self.pendingObligation);

  // ── Group 2 · public field (14–20) ────────────────────────────────────
  out[14] = clamp01(field.livingEnemies / 6);
  out[15] = clamp01(field.tick / MAX_TICKS);
  out[16] = bit(field.centrepieceHeld);
  out[17] = bit(field.volcanoLive);
  out[18] = clamp01(field.volcanoHpFraction);
  out[19] = bit(field.capriceActive);
  out[20] = clamp01(field.besiegedBy / 6);

  // ── Group 3 · reveal state (21–23) ────────────────────────────────────
  out[21] = bit(reveal.statsRevealed);
  out[22] =
    reveal.grantedTicks > 0 ? clamp01(reveal.ticksRemaining / reveal.grantedTicks) : 0;
  out[23] = bit(reveal.available);

  // ── Group 4 · current target (24–33) ──────────────────────────────────
  const target = self.targetId
    ? knowledge.enemies.find((e) => e.id === self.targetId && !e.eliminated)
    : undefined;
  out[24] = bit(target !== undefined);
  out[25] = bit(self.switchReady);
  if (target === undefined) {
    // No target: the gated slots carry the neutral stand-in rather than zero,
    // so "no target" and "target at 0 HP" stay distinguishable via index 24.
    out[26] = UNKNOWN;
    out[27] = UNKNOWN;
    out[28] = UNKNOWN;
    out[29] = UNKNOWN;
    out[30] = 0.5;
    out[31] = 0;
    out[32] = 0;
    out[33] = 0;
  } else {
    out[26] = target.hp.known ? clamp01(target.hp.value) : UNKNOWN;
    out[27] = target.shield.known ? clamp01(target.shield.value / STANDARD_SHIELD_HP) : UNKNOWN;
    out[28] = target.citizens.known ? clamp01(target.citizens.value / 40) : UNKNOWN;
    out[29] = target.income.known ? Math.tanh(target.income.value / 1.5) : UNKNOWN;
    // Amplification is public-only (kingdom elemental resistance); see
    // knowledge.ts for why the engine's full damageTaken pass is not used.
    // Centred so 0.5 means "neither resisted nor amplified".
    out[30] = clamp01(target.amplification / 2);
    out[31] = bit(target.comboSetup);
    out[32] = Math.tanh(target.damageDealt / 5000);
    out[33] =
      target.ticksSinceDamaged === null
        ? 1
        : clamp01(target.ticksSinceDamaged / RECENCY_TICKS);
  }

  // ── Group 5 · kit (34–63) — five slots × six values ───────────────────
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    const base = KIT_BASE + slot * KIT_STRIDE;
    const ability = self.kit[slot];
    if (ability === undefined) {
      // A kingdom with fewer than five castable abilities would land here. None
      // currently do; zeroing keeps the vector well-formed if one ever does.
      out[base] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = 0;
      out[base + 4] = 0;
      out[base + 5] = 0;
      continue;
    }
    out[base] = bit(ability.unlocked);
    out[base + 1] = clamp01(1 - ability.cooldownRemaining / ability.cooldownTicks);
    out[base + 2] = clamp01(ability.cost / Math.max(1, self.currency));
    out[base + 3] = kindValue(ability.kind);
    out[base + 4] =
      ability.maxUpgradeLevel > 0
        ? clamp01(ability.upgradeLevel / ability.maxUpgradeLevel)
        : 0;
    out[base + 5] = Math.tanh(ability.heuristicValue / 1000);
  }

  // ── Group 6 · kingdom identity (64–79) ────────────────────────────────
  //
  // ⚠️ WITHOUT THIS THE NETWORK CANNOT TELL WHICH KINGDOM IT IS PLAYING.
  //
  // The kit slots are POSITIONAL: slot 3 is `flood` in Water and `hurricane` in
  // Air, and nothing else in the vector distinguishes them. One network plays
  // all sixteen kingdoms, so every per-kingdom strategy had to be averaged into
  // a single generic policy — "cast slot 3 when the numbers look like this" —
  // and a play that wins in one kingdom while losing in another cancelled out.
  //
  // Measured before this existed: a scripted policy that spams its cheapest
  // attack AND fires its most expensive one beat pure spam outright in six of
  // sixteen kingdoms. The trained network played neither, because it could not
  // condition on which kingdom it was in.
  //
  // A one-hot rather than a scalar id: an index would imply that kingdom 3 sits
  // between 2 and 4, which is meaningless and would leak a false ordering into
  // the weights.
  const kingdomIndex = KINGDOM_IDS.indexOf(self.kingdomId);
  for (let i = 0; i < KINGDOM_IDS.length; i++) {
    out[KINGDOM_BASE + i] = i === kingdomIndex ? 1 : 0;
  }
}

/** Standard shield purchase size, used to normalize shield pools. */
const STANDARD_SHIELD_HP = 1750;
/** The simulation's default per-match tick cap, for match progress. */
const MAX_TICKS = 24_000;
/** How long a hit stays "recent" for input 33 (30 s at 20 t/s). */
const RECENCY_TICKS = 600;

/**
 * Fingerprint of the observation contract.
 *
 * Covers the layout AND the visibility rule, because a model is invalidated by
 * a change to either. Pinned against `OBSERVATION_VERSION` by a test, so
 * widening what a seat may see cannot happen without a deliberate bump.
 */
export function observationSpecHash(): string {
  const text = [
    `size=${OBSERVATION_SIZE}`,
    `groups=${SELF_BASE},${FIELD_BASE},${REVEAL_BASE},${TARGET_BASE},${KIT_BASE}`,
    `kit=${KIT_SLOTS}x${KIT_STRIDE}`,
    `visibility=${visibilitySpecHash()}`,
    `version=${OBSERVATION_VERSION}`,
  ].join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
