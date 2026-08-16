import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSearch, buildSchema, searchable, type SearchScope } from "../search/index.js";
import { WEIGHT_PRESETS, fitnessText } from "../fitness/index.js";
import { QueueClient } from "./client.js";
import { distributedEvaluator, assertCoordinatorMatches } from "./coordinator.js";
import { localIdentity } from "./identity.js";

/**
 * Coordinator entry point.
 *
 *   node dist/simulation/src/distributed/runCoordinator.js \
 *     --generations 60 [--population 19] [--out runs/v2] [--name elementals-v2]
 *
 * Owns the CMA-ES state and nothing else. It asks the strategy for a
 * population, writes each candidate to the queue, waits for every one to come
 * back, and hands the ordered results to the search loop, which calls tell()
 * once. It never evaluates anything itself.
 *
 * Checkpointing, provenance, validation and promotion are unchanged: this is
 * the ordinary search with its evaluation step pointed somewhere else.
 */

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};

const scope = (arg("scope", "expanded") ?? "expanded") as SearchScope;
const generations = Number(arg("generations", "60"));
const seed = Number(arg("seed", "20260813"));
const sigma = Number(arg("sigma", "0.2"));
const schema = buildSchema({ scope });
const dimensions = searchable(schema).length;
const population = Number(arg("population", String(4 + Math.floor(3 * Math.log(dimensions)))));
const name = arg("name", `elementals-${scope}-s${seed}`)!;
const out = arg("out", "runs/distributed")!;
const promote = Number(arg("promote", "1"));
const validate = Number(arg("validate", "1"));

mkdirSync(out, { recursive: true });
const started = Date.now();
const stamp = () => `[${((Date.now() - started) / 60000).toFixed(1)}m]`;
const lines: string[] = [];
function log(line: string): void {
  const stamped = `${stamp()} ${line}`;
  console.log(stamped);
  lines.push(stamped);
  try {
    writeFileSync(join(out, "coordinator.log"), lines.join("\n") + "\n", "utf8");
  } catch {
    /* the log is a convenience, never a reason to stop */
  }
}

const identity = localIdentity({ scope, seed, populationSize: population, sigma });

log("=".repeat(70));
log("DISTRIBUTED CMA-ES — COORDINATOR");
log("=".repeat(70));
log(`  experiment   ${name}`);
log(`  scope        ${scope} (schema ${schema.version}, ${dimensions} dimensions)`);
log(`  engine       ${identity.engineSha.slice(0, 12)}`);
log(`  generations  ${generations}   population ${population}   sigma ${sigma}   seed ${seed}`);
log("");

const client = new QueueClient({ role: "coordinator" });
const experiment = await client.ensureExperiment(name, identity, generations);

// A rebuild between sessions can drift the coordinator from its own experiment,
// and it is the one process whose drift would poison every generation after it.
await assertCoordinatorMatches(client, experiment.id, identity);

log("=".repeat(70));
log(`EXPERIMENT ID: ${experiment.id}`);
log("Give this to every worker notebook (EXPERIMENT_ID in kaggle_worker.py).");
log("=".repeat(70));
log("");
writeFileSync(join(out, "experiment-id.txt"), experiment.id, "utf8");

const result = await runSearch({
  schema,
  seed,
  generations,
  populationSize: population,
  sigma,
  promote,
  validate,
  checkpointPath: join(out, "checkpoint.json"),
  fitness: { weights: WEIGHT_PRESETS.designerPriority, weightsName: "designerPriority" },
  // The only change from a local search: evaluation happens elsewhere. The
  // loop's own guards on count and per-index hash still apply on top of the
  // coordinator's, deliberately — the checks are cheap and what they prevent
  // is silent.
  evaluateGeneration: distributedEvaluator({
    client, experimentId: experiment.id, onProgress: log,
  }),
  onProgress: (event) => log(`  ${event.message}`),
});

log("");
log("=".repeat(70));
log("RESULT");
log("=".repeat(70));
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(6));
log(`  baseline   ${fmt(result.baseline.full)}   verdict ${fmt(result.baselineVerdict.full)}`);
if (result.best) {
  log(`  best       ${fmt(result.best.full)}   verdict ${fmt(result.best.fullVerdict)}`);
  log(`  validated  ${fmt(result.best.validation)}`);
  log(`  candidate  ${result.best.candidate.id} (${result.best.candidate.hash})`);
  writeFileSync(
    join(out, "candidate.json"),
    JSON.stringify({
      id: result.best.candidate.id,
      hash: result.best.candidate.hash,
      parameters: result.best.candidate.parameters,
      scores: { full: result.best.full, validation: result.best.validation },
      promotion: "NOT PROMOTED — requires two independent validation pools",
    }, null, 2),
    "utf8",
  );
}
if (result.stoppedEarly) log(`  STOPPED EARLY: ${result.stoppedEarly.reason}`);
log(`  totals     ${JSON.stringify(result.totals)}`);

writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2), "utf8");
log(`\nwrote result.json, candidate.json and coordinator.log to ${out}`);
