import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Genome } from "../neat/index.js";

/**
 * Packages a training run's champions as an evaluator-ready model set.
 *
 *   npx tsx simulation/src/tools/exportV4Models.ts <runDir> <outDir>
 *
 * ⚠️ WHY THIS IS NEEDED. `models/` still holds observation-v1 networks with 64
 * inputs. The observation grew to 80, so `loadNeatModel` now refuses all three
 * — correctly, via the identity check — and the balance evaluator cannot run at
 * all until a v2-era set replaces them. Any balance comparison taken against
 * the old set is not stale, it is impossible.
 *
 * WRITES TO A SEPARATE DIRECTORY, never to `models/`. The shipped set is the
 * game's live AI; swapping it is a decision for a person, not a side effect of
 * measuring a balance candidate. `ELEMENTALS_AI_MODEL_DIR` points the evaluator
 * here for a single run.
 *
 * THREE DIFFICULTIES FROM ONE LINEAGE, which is what the population wants: it
 * exists to average over strategies, and one policy in every seat replays the
 * same match every seed. Successive champions from a single run disagree about
 * play without being three unrelated players.
 */

const [, , runDir = "runs/neat/v4", outDir = "runs/neat/v4/models"] = process.argv;

interface Champion {
  generation: number;
  validation: number;
  genome: Genome;
}

/** The run's identity travels with the models, so the loader can vet them. */
const checkpoint = JSON.parse(
  readFileSync(join(runDir, "checkpoint.json"), "utf8"),
) as { identity: Record<string, unknown>; completedGenerations: number };

const read = (file: string): Champion =>
  JSON.parse(readFileSync(join(runDir, "champions", file), "utf8")) as Champion;

// Weakest to strongest by the validation score each was crowned on.
const ASSIGNMENT: Array<[string, string]> = [
  ["easy", "gen0016-g16-10.json"],
  ["medium", "gen0096-g96-18.json"],
  ["hard", "gen0136-g136-n.json"],
];

mkdirSync(outDir, { recursive: true });

for (const [difficulty, file] of ASSIGNMENT) {
  const champion = read(file);
  // The shape `loadNeatModel` and `describeNeatModels` expect — identity for
  // the compatibility gate, training for provenance. Assembled from the run's
  // own checkpoint rather than invented, so a model cannot claim a lineage it
  // does not have.
  const id = checkpoint.identity as Record<string, unknown>;
  const model = {
    formatVersion: 1,
    kind: "elementals.ai.model",
    difficulty,
    identity: {
      observationVersion: id.observationVersion,
      actionVersion: id.actionVersion,
      genomeVersion: id.genomeVersion,
      engineSha: id.engineSha,
      engineDirty: id.engineDirty,
      balanceConfigHash: id.balanceConfigHash,
      balanceBaselineHash: id.balanceBaselineHash,
      kingdomCount: 16,
    },
    training: {
      seed: id.seed,
      generation: champion.generation,
      fitnessVersion: id.fitnessVersion,
      trainedAt: new Date().toISOString(),
      validation: champion.validation,
      source: `${runDir}/champions/${file}`,
    },
    genome: champion.genome,
  };
  const path = join(outDir, `${difficulty}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2));
  const inputs = champion.genome.nodes.filter((n) => n.type === "input").length;
  console.log(
    `${difficulty.padEnd(7)} <- ${file.padEnd(22)} gen ${String(champion.generation).padStart(4)}  ` +
      `validation ${champion.validation.toFixed(4)}  ${inputs} inputs`,
  );
}

console.log(`\nwrote ${ASSIGNMENT.length} models to ${outDir}`);
console.log(`point the evaluator at them with ELEMENTALS_AI_MODEL_DIR=${outDir}`);
