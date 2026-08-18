import { runHeadlessMatch } from "../headless.js";
import { mulberry32 } from "../rng.js";
import { PERSONALITIES } from "../personalities.js";
import { personalityAI, type PersonalityProfile } from "../personality.js";
import {
  NetworkController,
  OBSERVATION_SIZE,
  ACTION_SIZE,
  type ControllerStats,
  type Network,
} from "../ai/index.js";
import { buildNetwork, type ActivationNetwork, type Genome, type GenomeShape } from "../neat/index.js";
import type { PlayerSpec } from "../types.js";
import type { Difficulty } from "../ai/index.js";
import type { FitnessConfig } from "./config.js";
import { aggregate, scoreMatch, type GenomeFitness, type MatchScore } from "./fitness.js";
import type { SlateEntry } from "./slate.js";

/**
 * The adapter: genome → network → controller → real matches → fitness.
 *
 * The only module that knows both halves. NEAT never learns what a genome is
 * for; the AI runtime never learns where its network came from.
 */

/**
 * Compile-time proof that a compiled genome satisfies the runtime contract.
 *
 * `neat/networkBuilder.ts` deliberately does not import `ai/network.ts` — that
 * would put an Elementals edge into the generic algorithm — so the two `Network`
 * shapes are kept aligned structurally instead. If either drifts, this
 * assignment stops compiling, here, rather than at some later cast.
 */
type NetworkContractHolds = ActivationNetwork extends Network ? true : never;
const _contract: NetworkContractHolds = true;
void _contract;

/** The genome shape the Elementals runtime requires. */
export const ELEMENTALS_SHAPE: GenomeShape = {
  inputs: OBSERVATION_SIZE,
  outputs: ACTION_SIZE,
  activation: "tanh",
};

export interface GenomeEvaluation extends GenomeFitness {
  scores: MatchScore[];
}

function profileFor(id: string): PersonalityProfile {
  const profile = PERSONALITIES[id as keyof typeof PERSONALITIES];
  if (!profile) throw new Error(`unknown opponent profile "${id}"`);
  return profile as PersonalityProfile;
}

/**
 * Plays one slate entry and scores it.
 *
 * The genome's controller stats are captured so `casts` can feed the inactivity
 * guard — a genome that never acted must not be rewarded for outlasting seats
 * that fought each other.
 */
export function playMatch(
  genomeNetwork: Network,
  entry: SlateEntry,
  fitness: FitnessConfig,
  maxTicks: number,
  difficulty: Difficulty = "hard",
): { score: MatchScore; stats: ControllerStats } {
  const seats: PlayerSpec[] = [];
  let opponentIndex = 0;
  for (let i = 0; i < entry.opponentKingdoms.length + 1; i++) {
    if (i === entry.seat) {
      seats.push({ kingdomId: entry.kingdom, name: `neat-${entry.kingdom}` });
    } else {
      const kingdom = entry.opponentKingdoms[opponentIndex]!;
      const profile = profileFor(entry.opponentProfiles[opponentIndex]!);
      opponentIndex += 1;
      seats.push({ kingdomId: kingdom, name: `${profile.name}-${kingdom}`, ai: personalityAI(profile) });
    }
  }

  let stats: ControllerStats | null = null;
  seats[entry.seat] = {
    ...seats[entry.seat]!,
    ai: (player, rng) => {
      const controller = new NetworkController(player, {
        network: genomeNetwork,
        rng,
        difficulty,
      });
      stats = controller.stats;
      return controller;
    },
  };

  const record = runHeadlessMatch({
    players: seats,
    seed: entry.seed,
    maxTicks,
    // Seats carry their own factories; this is only the fallback.
    createAI: personalityAI(profileFor("balanced")),
    telemetry: false,
  });

  const playerId = `p${entry.seat}`;
  const captured: ControllerStats = stats ?? {
    decisions: 0, casts: 0, invests: 0, citizens: 0, repairs: 0, shields: 0,
    retargets: 0, waits: 0, rejected: 0, rejectedBy: {}, forcedWaits: 0,
  };
  return {
    score: scoreMatch(record, playerId, captured.casts, fitness),
    stats: captured,
  };
}

/** Plays a genome's whole slate and returns its fitness. */
export function evaluateGenome(
  genome: Genome,
  slate: readonly SlateEntry[],
  fitness: FitnessConfig,
  maxTicks: number,
  difficulty: Difficulty = "hard",
): GenomeEvaluation {
  const network = buildNetwork(genome);
  const scores: MatchScore[] = [];
  let rejected = 0;
  for (const entry of slate) {
    const { score, stats } = playMatch(network, entry, fitness, maxTicks, difficulty);
    rejected += stats.rejected;
    scores.push(score);
  }
  if (rejected > 0) {
    // The mask and the engine disagreeing is a defect, not a strategy problem,
    // and it would quietly distort every fitness number in the run.
    throw new Error(
      `genome ${genome.id}: the engine refused ${rejected} action(s) the mask permitted`,
    );
  }
  return { ...aggregate(scores), scores };
}

/** A seeded stream for anything the evaluator itself needs to randomize. */
export function evaluatorRng(seed: number) {
  return mulberry32(seed);
}
