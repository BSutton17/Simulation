import { runHeadlessMatch } from "../headless.js";
import { PERSONALITIES } from "../personalities.js";
import { personalityAI, type PersonalityProfile } from "../personality.js";
import {
  ACTION_SIZE,
  NetworkController,
  OBSERVATION_SIZE,
  type ControllerStats,
  type Difficulty,
  type Network,
} from "../ai/index.js";
import {
  buildNetwork,
  type ActivationNetwork,
  type Genome,
  type GenomeShape,
} from "../neat/index.js";
import type { AIFactory, PlayerSpec } from "../types.js";
import {
  aggregate,
  scoreScenario,
  type FitnessConfig,
  type ScenarioResult,
  type TrainingResult,
} from "./fitness.js";
import { CombatObserver } from "./matchObserver.js";
import type { Slate, SlateScenario } from "./slate.js";

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
 * would put an Elementals edge into the generic algorithm — so the two network
 * shapes are kept aligned structurally instead. If either drifts, this stops
 * compiling here rather than failing at some later cast.
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

function profileFor(id: string): PersonalityProfile {
  const profile = PERSONALITIES[id as keyof typeof PERSONALITIES];
  if (!profile) throw new Error(`unknown opponent profile "${id}"`);
  return profile as PersonalityProfile;
}

const emptyStats = (): ControllerStats => ({
  decisions: 0, casts: 0, invests: 0, citizens: 0, repairs: 0, shields: 0,
  retargets: 0, waits: 0, rejected: 0, rejectedBy: {}, forcedWaits: 0,
});

/**
 * A candidate: something that can drive the seat under evaluation.
 *
 * `stats` is optional because a heuristic personality has none — only the
 * network controller reports decision counters. The behaviour fields of a
 * personality's result are therefore zero, which the baseline report says
 * plainly rather than implying the heuristic never acted.
 */
export interface Candidate {
  readonly name: string;
  readonly factory: AIFactory;
  /** Stats for the most recent match, when the controller keeps them. */
  stats(): ControllerStats | null;
}

/** Drives the seat with a compiled network. */
export function networkCandidate(
  network: Network,
  name = "neat",
  difficulty: Difficulty = "hard",
): Candidate {
  let latest: ControllerStats | null = null;
  return {
    name,
    factory: (player, rng) => {
      const controller = new NetworkController(player, { network, rng, difficulty });
      latest = controller.stats;
      return controller;
    },
    stats: () => latest,
  };
}

/** Drives the seat with one of the shipped heuristic personalities. */
export function personalityCandidate(profileId: string): Candidate {
  const profile = profileFor(profileId);
  const factory = personalityAI(profile);
  return { name: profileId, factory, stats: () => null };
}

/** Plays one scenario and scores it. */
export function playScenario(
  candidate: Candidate,
  scenario: SlateScenario,
  config: FitnessConfig,
): ScenarioResult {
  const seats: PlayerSpec[] = [];
  let opponentIndex = 0;
  for (let i = 0; i < scenario.seats; i++) {
    if (i === scenario.candidateSeat) {
      seats.push({
        kingdomId: scenario.candidateKingdom,
        name: `candidate-${scenario.candidateKingdom}`,
        ai: candidate.factory,
      });
    } else {
      const kingdom = scenario.opponentKingdoms[opponentIndex]!;
      const profile = profileFor(scenario.opponentProfiles[opponentIndex]!);
      opponentIndex += 1;
      seats.push({
        kingdomId: kingdom,
        name: `${profile.name}-${kingdom}`,
        ai: personalityAI(profile),
      });
    }
  }

  const observer = new CombatObserver();
  const record = runHeadlessMatch({
    players: seats,
    seed: scenario.seed,
    maxTicks: scenario.maxTicks,
    // Every seat carries its own factory; this is only the fallback.
    createAI: personalityAI(profileFor("balanced")),
    observers: [observer],
    // The training-side CombatObserver supplies everything fitness reads, so
    // the far heavier TelemetryCollector stays off.
    telemetry: false,
  });

  const playerId = `p${scenario.candidateSeat}`;
  const combat = observer.for(playerId);
  // Controller stats are diagnostics and exist only for the network controller;
  // `casts` comes from the event stream so every candidate is measured the same
  // way. A heuristic reports no stats and must not therefore look inactive.
  const stats = candidate.stats() ?? emptyStats();
  return scoreScenario(
    record,
    playerId,
    {
      scenarioId: scenario.id,
      format: scenario.format,
      seats: scenario.seats,
      kingdom: scenario.candidateKingdom,
      seat: scenario.candidateSeat,
      combat,
      behaviour: {
        casts: combat.casts, invests: stats.invests, citizens: stats.citizens,
        repairs: stats.repairs, shields: stats.shields, retargets: stats.retargets,
        waits: stats.waits, decisions: stats.decisions,
        forcedWaits: stats.forcedWaits,
      },
    },
    config,
  );
}

/**
 * Plays a whole slate with one candidate.
 *
 * Taking a `Candidate` rather than a network is what lets `baselines.ts` put a
 * heuristic personality, a random network and a trained genome through the
 * IDENTICAL scenarios — same kingdoms, same opponents, same seats, same seeds.
 * Without that, "NEAT beat the heuristic" would be a claim about two different
 * sets of matches.
 */
export function evaluateCandidate(
  candidate: Candidate,
  slate: Slate,
  config: FitnessConfig,
): TrainingResult {
  const scenarios: ScenarioResult[] = [];
  let rejected = 0;
  const causes: Record<string, number> = {};
  const where: string[] = [];
  for (const scenario of slate.scenarios) {
    scenarios.push(playScenario(candidate, scenario, config));
    const stats = candidate.stats();
    if (stats && stats.rejected > 0) {
      rejected += stats.rejected;
      for (const [key, count] of Object.entries(stats.rejectedBy)) {
        causes[key] = (causes[key] ?? 0) + count;
      }
      if (where.length < 5) where.push(scenario.id);
    }
  }
  if (rejected > 0) {
    // The action mask and the engine disagreeing is a defect, not a strategy
    // problem, and it would quietly distort every fitness number in the run —
    // so it names what drifted rather than only that something did.
    const detail = Object.entries(causes)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} x${count}`)
      .join(", ");
    throw new Error(
      `the engine refused ${rejected} action(s) the action mask permitted: ${detail}` +
        ` (first scenarios: ${where.join(", ")})`,
    );
  }
  return aggregate(scenarios);
}

/** Evaluates one genome over a slate. */
export function evaluateGenome(
  genome: Genome,
  slate: Slate,
  config: FitnessConfig,
  difficulty: Difficulty = "hard",
): TrainingResult {
  return evaluateCandidate(
    networkCandidate(buildNetwork(genome), `neat-${genome.id}`, difficulty),
    slate,
    config,
  );
}
