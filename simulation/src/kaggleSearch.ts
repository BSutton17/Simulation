import { ACTIVE_POPULATION } from "./evaluation/population.js";
import { describeNeatModels, neatModelsReady } from "./evaluation/neatModels.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { runSearch, fitnessOf, buildSchema, searchable, type SearchResult, type SearchScope } from "./search/index.js";
import { WEIGHT_PRESETS, fitnessText } from "./fitness/index.js";
import { defaultWorkerCount } from "./evaluation/index.js";

/**
 * Unattended balance search, for a hosted runner.
 *
 * The distinguishing constraint of a cloud session is that it ends whether or
 * not the work is done. Everything here follows from that: the search is
 * checkpointed every generation, it stops itself at a generation boundary
 * before the clock runs out, and re-running the identical command resumes
 * rather than restarting. A session that dies unexpectedly loses at most the
 * generation in flight.
 *
 *   npx tsx simulation/src/kaggleSearch.ts \
 *     --generations 20 --population 8 --hours 8 \
 *     --out /kaggle/working/run
 *
 * Every artifact lands in --out. Nothing is written back into the repository,
 * and no balance change is ever applied to the game: the output is a candidate
 * plus the evidence for it, for a human to accept or reject.
 */

interface Args {
  generations: number;
  population: number | undefined;
  sigma: number;
  seed: number;
  workers: number;
  promote: number;
  validate: number;
  hours: number | undefined;
  out: string;
  restart: boolean;
  /** Which slice of the engine the optimizer may move. */
  scope: SearchScope;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} expects a number, got "${raw}"`);
    return value;
  };
  const optional = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} expects a number, got "${raw}"`);
    return value;
  };

  return {
    generations: num("generations", 20),
    population: optional("population"),
    sigma: num("sigma", 0.2),
    seed: num("seed", 20260813),
    workers: num("workers", defaultWorkerCount()),
    promote: num("promote", 3),
    validate: num("validate", 1),
    hours: optional("hours"),
    out: get("out") ?? "runs/kaggle",
    // "curated" is the completed v1 experiment: 20 passive/system dials.
    // "expanded" adds each kingdom's most-cast attack, 52 dimensions in total.
    // The schema version differs per scope, so a v1 checkpoint can never
    // silently resume a v2 run.
    scope: (get("scope") ?? "curated") as SearchScope,
    restart: argv.includes("--restart"),
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.scope !== "curated" && args.scope !== "expanded") {
  throw new Error(`--scope expects "curated" or "expanded", got "${args.scope}"`);
}
const schema = buildSchema({ scope: args.scope });
mkdirSync(args.out, { recursive: true });

const checkpointPath = join(args.out, "checkpoint.json");
const started = Date.now();
const stamp = () => `[${((Date.now() - started) / 60000).toFixed(1)}m]`;

const logLines: string[] = [];
function log(message: string): void {
  const line = `${stamp()} ${message}`;
  console.log(line);
  logLines.push(line);
  // Flushed every line: on a runner that can be killed without warning, a log
  // buffered until exit is a log that does not exist.
  try {
    writeFileSync(join(args.out, "progress.log"), logLines.join("\n") + "\n", "utf8");
  } catch {
    /* the log is a convenience; never let it end the run */
  }
}

log("=".repeat(70));
log("ELEMENTALS BALANCE SEARCH");
log("=".repeat(70));
log(`  host           ${cpus().length} logical cores`);
log(`  workers        ${args.workers}`);
log(`  generations    ${args.generations}`);
log(`  population     ${ACTIVE_POPULATION.version} (${ACTIVE_POPULATION.profiles.length} strategies)`);
{
  // Preflight. A worker that cannot load a model throws inside a batch, hours
  // into a session, after the coordinator has already handed out work. Checking
  // here turns that into a refusal at launch with a path in the message.
  const neat = ACTIVE_POPULATION.profiles.filter((p) => p.kind === "neat");
  if (neat.length > 0) {
    const levels = neat.map((p) => p.difficulty);
    const ready = neatModelsReady(levels);
    if (!ready.ok) {
      console.error(`REFUSING TO START - ${ready.detail}`);
      process.exit(1);
    }
    for (const line of describeNeatModels(levels)) log(`    ${line}`);
  }
}
log(`  population     ${args.population ?? "auto (CMA-ES default)"}`);
log(`  sigma          ${args.sigma}`);
log(`  seed           ${args.seed}`);
log(`  scope          ${args.scope} (schema ${schema.version}, ${searchable(schema).length} dimensions)`);
log(`  budget         ${args.hours !== undefined ? `${args.hours}h` : "none"}`);
log(`  output         ${args.out}`);
log(`  checkpoint     ${checkpointPath}${args.restart ? "  (RESTART — ignoring any existing)" : ""}`);
log("");

let result: SearchResult;
try {
  result = await runSearch({
    schema,
    seed: args.seed,
    generations: args.generations,
    populationSize: args.population,
    sigma: args.sigma,
    workers: args.workers,
    promote: args.promote,
    validate: args.validate,
    checkpointPath,
    restart: args.restart,
    budgetMs: args.hours !== undefined ? args.hours * 3600000 : undefined,
    fitness: { weights: WEIGHT_PRESETS.designerPriority, weightsName: "designerPriority" },
    onProgress: (event) => log(`  ${event.message}`),
  });
} catch (error) {
  // The checkpoint is the valuable thing. Say plainly that it survived, and
  // exit non-zero so the runner does not report a failed search as a success.
  log(`FATAL: ${(error as Error).message}`);
  log(`the checkpoint at ${checkpointPath} is intact — re-run the same command to resume`);
  process.exitCode = 1;
  throw error;
}

log("");
log("=".repeat(70));
log("RESULT");
log("=".repeat(70));
if (result.resumedFrom) {
  log(`  resumed from generation ${result.resumedFrom.generations} (${result.resumedFrom.cacheEntries} cached evaluations)`);
}
if (result.checkpointRejected) log(`  checkpoint not used: ${result.checkpointRejected}`);
if (result.stoppedEarly) {
  log(`  STOPPED EARLY at generation ${result.stoppedEarly.afterGeneration}/${result.stoppedEarly.of}`);
  log(`  ${result.stoppedEarly.reason}`);
  log("  re-run the identical command in a new session to continue");
}
log(`  baseline    objective ${fmt(result.baseline.full)}   verdict ${fmt(result.baselineVerdict.full)}`);
if (result.best) {
  log(`  best        objective ${fmt(result.best.full)}   verdict ${fmt(result.best.fullVerdict)}`);
  log(`  validated   objective ${fmt(result.best.validation)}   verdict ${fmt(result.best.validationVerdict)}`);
  log(`  candidate   ${result.best.candidate.id}  (hash ${result.best.candidate.hash})`);
}
log(`  totals      ${JSON.stringify(result.totals)}`);

/**
 * Promotion status.
 *
 * The interval-aware gate needs the evaluation behind a score, which a
 * FitnessResult does not carry, and it needs at least two independent seed
 * pools — which one run cannot provide however long it lasts. So this states
 * the position rather than performing a check it cannot perform. Step 9's elite
 * cleared a single pool and then failed on a second; a run that announced
 * "promotable" here would be repeating exactly that error.
 */
log("");
log("=".repeat(70));
log("PROMOTION STATUS — NOT PROMOTED");
log("=".repeat(70));
log("  This run provides one validation pool. Promotion requires at least two");
log("  independent pools, with every constraint interval clear of its threshold.");
log("  Run the gate over this candidate on a second pool before changing the game.");

// --- artifacts -------------------------------------------------------------
writeFileSync(join(args.out, "result.json"), JSON.stringify(result, null, 2), "utf8");

if (result.best) {
  // The candidate on its own, so a human reviewing it does not have to dig it
  // out of a megabyte of run history.
  writeFileSync(
    join(args.out, "candidate.json"),
    JSON.stringify(
      {
        id: result.best.candidate.id,
        hash: result.best.candidate.hash,
        parameters: result.best.candidate.parameters,
        scores: {
          full: result.best.full,
          fullVerdict: result.best.fullVerdict,
          validation: result.best.validation,
          validationVerdict: result.best.validationVerdict,
        },
        baseline: { full: result.baseline.full, verdict: result.baselineVerdict.full },
        promotion: "NOT PROMOTED — this file is a proposal for human review",
      },
      null,
      2,
    ),
    "utf8",
  );

  const report = fitnessOf(result, result.best.candidate.hash, "validation")
    ?? fitnessOf(result, result.best.candidate.hash, "full");
  if (report) writeFileSync(join(args.out, "fitness.txt"), fitnessText(report), "utf8");
}

log("");
log(`wrote result.json, candidate.json, fitness.txt and progress.log to ${args.out}`);
log("done");

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toFixed(4);
}
