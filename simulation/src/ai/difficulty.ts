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
}

export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyConfig>> = {
  hard: { decisionPeriod: 5, secondBestRate: 0, observationBuckets: 0 },
  medium: { decisionPeriod: 10, secondBestRate: 0.05, observationBuckets: 0 },
  easy: { decisionPeriod: 20, secondBestRate: 0.15, observationBuckets: 5 },
};

/** The cadence the heuristic controller uses, and the reference for Hard. */
export const DEFAULT_DECISION_PERIOD = 5;
