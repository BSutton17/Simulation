import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNetwork, type Genome } from "../neat/index.js";
import { NetworkController, assertModelCompatible, type AiModel, type Difficulty } from "../ai/index.js";
import type { AIFactory } from "../types.js";

/**
 * The trained models the balance search plays its matches with.
 *
 * Loaded from JSON on disk rather than compiled in: a genome is ~500 tuned
 * floats, and checking that into source would make every retrain a code change.
 * The files ship in `models/` at the repository root so a Kaggle worker gets
 * them with the checkout — there is no download step and no network dependency
 * inside a search run.
 *
 * REFUSES an incompatible model. If a model's observation or action schema does
 * not match this build, input 37 means something it was never trained on and the
 * bot plays confidently wrong — which would silently corrupt an entire balance
 * search rather than fail it. `assertModelCompatible` names the differing field.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function searchPaths(): string[] {
  const fromEnv = process.env.ELEMENTALS_AI_MODEL_DIR;
  return [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    // From source (simulation/src/evaluation) and from dist, respectively.
    resolve(HERE, "../../../models"),
    resolve(HERE, "../../../../models"),
    resolve(process.cwd(), "models"),
  ];
}

export function modelPath(difficulty: Difficulty): string | null {
  for (const dir of searchPaths()) {
    const candidate = join(dir, `${difficulty}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Loaded {
  model: AiModel;
  network: ReturnType<typeof buildNetwork>;
}

const cache = new Map<Difficulty, Loaded>();

/**
 * Loads and compiles one difficulty, once.
 *
 * A compiled network is read-only during activation — it writes only into the
 * caller's output buffer — so one instance is shared by every seat in every
 * match and every worker thread's own copy. Recompiling 500 connections per
 * seat per match would be a meaningful slice of a search's runtime.
 */
export function loadNeatModel(difficulty: Difficulty): Loaded {
  const hit = cache.get(difficulty);
  if (hit) return hit;

  const path = modelPath(difficulty);
  if (path === null) {
    throw new Error(
      `no trained model for "${difficulty}" — looked in ${searchPaths().join(", ")}. ` +
        `The balance search plays with trained models; copy easy/medium/hard.json into models/.`,
    );
  }

  const model = JSON.parse(readFileSync(path, "utf8")) as AiModel & { genome: Genome };
  assertModelCompatible(model);
  const loaded: Loaded = { model, network: buildNetwork(model.genome) };
  cache.set(difficulty, loaded);
  return loaded;
}

/** An AI factory driving a seat with the trained model for `difficulty`. */
export function neatFactory(difficulty: Difficulty): AIFactory {
  const { network } = loadNeatModel(difficulty);
  return (player, rng) => new NetworkController(player, { network, rng, difficulty });
}

/** Provenance for a run header: exactly which models this search played with. */
export function describeNeatModels(difficulties: readonly Difficulty[]): string[] {
  return difficulties.map((d) => {
    const { model } = loadNeatModel(d);
    return (
      `${d}: engine ${model.identity.engineSha.slice(0, 10)}` +
      `${model.identity.engineDirty ? "+dirty" : ""}, ` +
      `balance ${model.identity.balanceConfigHash}, generation ${model.training.generation}`
    );
  });
}

/** True when all three models are present and loadable. For a preflight check. */
export function neatModelsReady(difficulties: readonly Difficulty[]): {
  ok: boolean;
  detail: string;
} {
  const problems: string[] = [];
  for (const d of difficulties) {
    try {
      loadNeatModel(d);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems.length === 0
    ? { ok: true, detail: `${difficulties.length} model(s) loaded` }
    : { ok: false, detail: problems.join(" | ") };
}
