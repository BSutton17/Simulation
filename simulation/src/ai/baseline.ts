import { personalityAI } from "../personality.js";
import { BALANCED } from "../personalities.js";
import type { AIFactory } from "../types.js";

/**
 * Default controller factory (ticket #205): the balanced personality.
 *
 * The original monolithic BaselineAI was superseded by the personality
 * framework — one generic, metadata-driven decision engine (personality.ts)
 * configured by pure-data profiles (personalities.ts). This module keeps the
 * runner's default in one obvious place.
 *
 * Moved here from `simulation/src/ai.ts` when `simulation/src/ai/` became the
 * home of the network-driven runtime: a module and a directory of the same name
 * resolve differently under NodeNext (`./ai.js` vs `./ai/index.js`) and are a
 * trap worth removing. Behaviour is unchanged — this is the same heuristic
 * controller, and `test/aiEquivalence.test.ts` still fingerprints it.
 */
export const createBaselineAI: AIFactory = personalityAI(BALANCED);
