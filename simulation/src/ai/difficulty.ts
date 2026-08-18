/**
 * Difficulty as configuration, not as three implementations.
 *
 * The three levels are meant to be points on ONE lineage — the same architecture
 * and, for two of them, the same weights — differing along axes that map to how
 * a weaker human plays: reaction rate, attention, consistency. Never along "the
 * network is worse", because a damaged network does not play badly, it plays
 * incoherently, which reads to a player as broken rather than beatable.
 *
 * Phase 1 defines the shape and wires the knobs the runtime can already honour.
 * Which genome each level uses, and the calibration proving Hard > Medium >
 * Easy with non-overlapping intervals, is Phase 2+ work — there are no trained
 * models yet to calibrate.
 *
 * ⚠️ All three levels observe under the SAME information boundary as a human.
 * Hard is not "sees the server state"; Hard is "reads the board and reacts
 * fast". Easy's degradation applies to what it was already allowed to see.
 */

export type Difficulty = "easy" | "medium" | "hard";

export interface DifficultyConfig {
  /** Decide every N ticks. 20 ticks per second, so 5 = 4 Hz. */
  readonly decisionPeriod: number;
  /**
   * Probability of taking the second-best legal action instead of the best.
   * A bounded mistake: still a legal, sensible-ish play, never a self-
   * destructive one. Shaped like the heuristic controller's `exploration`
   * rather than its `chaos`, and for the same reason — chaos discards policy,
   * and that reads as a bug.
   */
  readonly secondBestRate: number;
  /**
   * Quantize revealed enemy values into this many buckets (0 = no
   * quantization). Models not reading the board carefully. Applies only to
   * values the seat was legitimately shown.
   */
  readonly observationBuckets: number;
  /**
   * Softmax temperature over the legal actions. 0 is a pure argmax.
   *
   * ⚠️ NOT a difficulty knob in disguise, and not a shaping reward — it is what
   * makes "when to wait" LEARNABLE at all. Measured: with a pure argmax, genomes
   * offered ~7 legal actions per decision used 2 of 14 and changed their choice
   * under 1% of the time. A deterministic network reading a slowly-changing
   * observation returns the same head for thousands of consecutive ticks, so
   * evolution was being asked to learn timing through a mechanism that cannot
   * represent it.
   *
   * Sampling restores the ability to vary. The network still decides — the
   * softmax follows its own output ordering — but a second-place action is now
   * reachable, so a genome can discover that acting sometimes beats waiting and
   * selection can keep the discovery. Drawn from the seat's seeded stream, so
   * replay is unaffected.
   */
  readonly temperature: number;
}

export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyConfig>> = {
  // Even Hard samples. A fully deterministic bot repeats itself, which is both
  // exploitable by a human and the exact pathology measured above.
  hard: { decisionPeriod: 5, secondBestRate: 0, observationBuckets: 0, temperature: 0.4 },
  medium: { decisionPeriod: 10, secondBestRate: 0.05, observationBuckets: 0, temperature: 0.6 },
  easy: { decisionPeriod: 20, secondBestRate: 0.15, observationBuckets: 5, temperature: 0.9 },
};

/** The cadence the heuristic controller uses, and the reference for Hard. */
export const DEFAULT_DECISION_PERIOD = 5;
