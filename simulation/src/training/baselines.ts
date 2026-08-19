import { NeatRng, buildNetwork, createGenome, type Genome } from "../neat/index.js";
import { randomNetwork } from "../ai/index.js";
import { mulberry32 } from "../rng.js";
import {
  ELEMENTALS_SHAPE,
  evaluateCandidate,
  networkCandidate,
  personalityCandidate,
  type Candidate,
} from "./matchEvaluator.js";
import type { FitnessConfig, TrainingResult } from "./fitness.js";
import { baselineKey, genomeKey, type EvaluationCache } from "./evaluationCache.js";
import type { MatchRunner } from "./parallel/runner.js";
import type { CandidateSpec } from "./parallel/protocol.js";
import type { Slate } from "./slate.js";

/**
 * Baselines — the answer to "is NEAT actually learning anything?"
 *
 * A rising fitness curve proves only that the number went up. It does not say
 * whether the policy is any good, because fitness is measured against a slate
 * that rotates and a formula that could be flattering it. The honest test is to
 * put several controllers through the SAME scenarios and compare.
 *
 * Two of the baselines are load-bearing:
 *
 *   - a RANDOM network is the floor. A trained genome that cannot beat random
 *     has learned nothing, however pretty the curve.
 *   - the heuristic PERSONALITIES are the ceiling that matters. They are the
 *     opponent slate, the balance-evaluation population, and the thing a player
 *     currently faces; beating them is the first result worth reporting.
 *
 * Nothing here judges. It measures, and prints comparable numbers.
 */

export interface BaselineEntry {
  name: string;
  kind: "random" | "personality" | "genome";
  result: TrainingResult;
}

export interface BaselineReport {
  slateHash: string;
  scenarios: number;
  entries: BaselineEntry[];
}

/** A random-network candidate, drawn from a seeded stream so it replays. */
export function randomCandidate(seed: number, name = "random"): Candidate {
  return networkCandidate(randomNetwork(mulberry32(seed)), name);
}

/** A minimal, unevolved genome — the "generation zero" reference. */
export function minimalGenomeCandidate(seed: number, name = "minimal"): Candidate {
  const genome = createGenome("minimal", ELEMENTALS_SHAPE);
  const rng = new NeatRng(seed);
  // Wire it sparsely so it is a legal phenotype rather than a genome with no
  // connections, which would emit a constant and never act.
  const sources = genome.nodes.filter((n) => n.type === "input" || n.type === "bias");
  const outputs = genome.nodes.filter((n) => n.type === "output");
  let innovation = 0;
  for (const out of outputs) {
    for (const from of sources) {
      if (rng.next() > 0.25) continue;
      genome.connections.push({
        innovation: innovation++,
        from: from.id,
        to: out.id,
        weight: rng.spread(2),
        enabled: true,
      });
    }
  }
  genome.connections.sort((a, b) => a.innovation - b.innovation);
  return networkCandidate(buildNetwork(genome), name);
}

export interface BaselineOptions {
  slate: Slate;
  fitness: FitnessConfig;
  /** Heuristic profiles to include. */
  personalities?: string[];
  /** Trained genomes to include, by label. */
  genomes?: { name: string; genome: Genome }[];
  seed?: number;
  /**
   * Optional memo across calls.
   *
   * Baselines are re-run every benchmark check against the SAME fixed slate, so
   * without this the heuristic rows are recomputed identically every time — 3,456
   * wasted matches on the last 50-generation run. Evaluation is deterministic, so
   * a hit is the same number, not an approximation.
   */
  cache?: EvaluationCache;
  /** Content hash per genome, for cache identity. Ids are not content. */
  fingerprint?: (genome: Genome) => string;
}

/**
 * Runs every baseline over one slate.
 *
 * Same slate for every entry, deliberately: the scenarios carry their own seeds,
 * so each controller meets identical kingdoms, opponents, seats and dice.
 */
export async function runBaselines(
  runner: MatchRunner,
  options: BaselineOptions,
): Promise<BaselineReport> {
  const seed = options.seed ?? 12345;
  const entries: BaselineEntry[] = [];
  const hash = options.slate.hash;
  // Without a cache every lookup simply computes, so behaviour is unchanged.
  const memo = async (key: string, spec: CandidateSpec): Promise<TrainingResult> => {
    const hit = options.cache?.peek(key);
    if (hit) return hit;
    const value = await runner.evaluate(spec, options.slate, options.fitness);
    return options.cache ? options.cache.put(key, value) : value;
  };

  entries.push({
    name: "random",
    kind: "random",
    result: await memo(baselineKey("bench", "random", seed, hash), {
      kind: "random",
      seed,
      name: "random",
    }),
  });

  for (const profile of options.personalities ?? ["balanced", "aggressive", "economic"]) {
    entries.push({
      name: profile,
      kind: "personality",
      result: await memo(baselineKey("bench", profile, seed, hash), {
        kind: "personality",
        profile,
      }),
    });
  }

  for (const entry of options.genomes ?? []) {
    // Keyed by CONTENT, so an unchanged champion under a new label still hits,
    // and a mutated genome that kept its id still misses.
    const identity = options.fingerprint?.(entry.genome) ?? entry.genome.id;
    entries.push({
      name: entry.name,
      kind: "genome",
      result: await memo(genomeKey("bench", identity, hash), {
        kind: "genome",
        genome: entry.genome,
        name: entry.name,
      }),
    });
  }

  return { slateHash: hash, scenarios: options.slate.scenarios.length, entries };
}

/** A fixed-width table, ordered by fitness. */
export function formatBaselines(report: BaselineReport): string {
  const lines: string[] = [];
  lines.push(`slate ${report.slateHash} — ${report.scenarios} scenarios per candidate`);
  lines.push("");
  lines.push(
    "  candidate         kind         fitness   win%   place   dmg+/-   casts",
  );
  const ranked = [...report.entries].sort((a, b) => b.result.fitness - a.result.fitness);
  for (const entry of ranked) {
    const r = entry.result;
    const winRate = r.matches > 0 ? (100 * r.wins) / r.matches : 0;
    const ratio =
      r.totalDamageDealt + r.totalDamageReceived > 0
        ? r.totalDamageDealt / (r.totalDamageDealt + r.totalDamageReceived)
        : 0;
    lines.push(
      `  ${entry.name.padEnd(17)} ${entry.kind.padEnd(12)} ` +
        `${r.fitness.toFixed(4).padStart(7)} ${winRate.toFixed(0).padStart(5)}% ` +
        `${r.meanPlacement.toFixed(2).padStart(7)} ${ratio.toFixed(2).padStart(8)} ` +
        `${String(r.totalCasts).padStart(7)}`,
    );
  }
  return lines.join("\n");
}
