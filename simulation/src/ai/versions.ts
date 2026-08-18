/**
 * Version identity for the AI runtime.
 *
 * The repository already has a settled convention for this — a version
 * constant, an identity struct, and a comparison that refuses and NAMES the
 * field that differs (`evaluation/provenance.ts`, `search/checkpoint.ts`,
 * `distributed/protocol.ts`). This module supplies the constants; `model.ts`
 * supplies the identity and the refusal.
 *
 * Why these are separate constants rather than one "AI version": a trained
 * network is a set of weights on SPECIFIC input and output indices. Changing
 * what input 31 means does not make an old model worse, it makes it a different
 * function reading the same 64 numbers — and it will play confidently and
 * wrongly, with nothing raising an error. Each constant therefore guards one
 * thing that can silently invalidate a model.
 */

/** The `AiModel` envelope shape (model.ts). */
export const MODEL_FORMAT_VERSION = 1;

/**
 * The observation contract: the 64 inputs, their order, their normalization,
 * AND the visibility table that decides which of them are gated.
 *
 * Bump when any of those change. A test pins this against the observation
 * specification hash so the two cannot drift apart silently.
 */
export const OBSERVATION_VERSION = "v1";

/**
 * The action contract: the 22 outputs, their order, and the target ordering
 * rule. The ordering is part of this version because outputs 14–19 are
 * meaningless without it.
 */
export const ACTION_VERSION = "v1";

/**
 * The genome/network serialization shape. Declared now, unused until Phase 2 —
 * a model written today must already say which genome format it is in.
 */
export const GENOME_VERSION = "v1";
