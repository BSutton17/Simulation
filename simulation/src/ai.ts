import { personalityAI } from "./personality.js";
import { BALANCED } from "./personalities.js";
import type { AIFactory } from "./types.js";

/**
 * Default controller factory (ticket #205): the balanced personality.
 *
 * The original monolithic BaselineAI was superseded by the personality
 * framework — one generic, metadata-driven decision engine (personality.ts)
 * configured by pure-data profiles (personalities.ts). This module keeps the
 * runner's default in one obvious place.
 */
export const createBaselineAI: AIFactory = personalityAI(BALANCED);
