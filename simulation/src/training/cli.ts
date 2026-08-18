import { runXor, withConfig, XOR_CONFIG } from "../neat/index.js";
import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { trainingConfig, type TrainingConfig } from "./config.js";
import { buildSlate, slateSize, type MatchFormat } from "./slate.js";
import { estimateMatches, toModel, train, writeModel } from "./trainer.js";
import { formatBaselines, runBaselines } from "./baselines.js";

/**
 * The NEAT command line.
 *
 *   npm run neat:xor                          prove the algorithm on XOR
 *   npm run neat:train -- --generations 5     evolve against real matches
 *   npm run neat:baseline                     compare controllers on one slate
 *
 * Kept small on purpose: everything interesting belongs in the modules this
 * calls, so the CLI is argument parsing and printing and nothing else.
 */

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function flag(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

function text(name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
}

/** Shared config assembly, so train and baseline evaluate the same design. */
function configFromFlags(defaults: { generations: number; population: number }): TrainingConfig {
  const kingdomFilter = text("kingdoms", "");
  const kingdoms: readonly KingdomId[] = kingdomFilter
    ? (kingdomFilter
        .split(",")
        .filter((k) => (KINGDOM_IDS as readonly string[]).includes(k)) as KingdomId[])
    : KINGDOM_IDS;
  const formats = text("formats", "duel")
    .split(",")
    .filter((f): f is MatchFormat => f === "duel" || f === "ffa4" || f === "ffa7");

  const base = trainingConfig();
  return trainingConfig({
    generations: flag("generations", defaults.generations),
    seed: flag("seed", 20260817),
    kingdoms,
    balanceConfigId: text("balance", "baseline"),
    neat: { ...base.neat, populationSize: flag("population", defaults.population) },
    slate: {
      ...base.slate,
      formats: formats.length > 0 ? formats : ["duel"],
      kingdomsPerGenome: flag("kingdoms-per-genome", 2),
      opponents: text("opponents", "balanced,aggressive").split(","),
      seatRotations: flag("rotations", 1),
      maxTicks: flag("max-ticks", 8_000),
    },
  });
}

function xor(): void {
  const runs = flag("runs", 5);
  const maxGenerations = flag("generations", 200);
  const population = flag("population", XOR_CONFIG.populationSize);
  const config = withConfig({ ...XOR_CONFIG, populationSize: population });

  console.log(`XOR — ${runs} run(s), population ${population}, up to ${maxGenerations} generations\n`);
  let solved = 0;
  const generations: number[] = [];
  for (let i = 0; i < runs; i++) {
    const seed = flag("seed", 1) + i;
    const started = Date.now();
    const result = runXor(seed, maxGenerations, config);
    if (result.solved) {
      solved += 1;
      generations.push(result.generations);
    }
    console.log(
      `  seed ${String(seed).padStart(6)}  ${result.solved ? "SOLVED " : "failed "}` +
        `gen ${String(result.generations).padStart(4)}  ` +
        `fitness ${result.bestFitness.toFixed(3).padStart(7)}  ` +
        `hidden ${result.hiddenNodes}  ` +
        `[${result.outputs.map((o) => o.toFixed(2)).join(" ")}]  ` +
        `${Date.now() - started}ms`,
    );
  }
  generations.sort((a, b) => a - b);
  const median = generations.length ? generations[Math.floor(generations.length / 2)] : "—";
  console.log(`\n  ${solved}/${runs} solved; median ${median} generations`);
  if (solved < runs) process.exitCode = 1;
}

function trainCommand(): void {
  const config = configFromFlags({ generations: 5, population: 30 });
  const checkpointPath = text("checkpoint", "runs/neat/checkpoint.json");
  const perGenome = slateSize(config.slate, config.kingdoms.length);

  console.log(
    `NEAT training — population ${config.neat.populationSize}, ` +
      `${config.generations} generations, ${perGenome} matches/genome, ` +
      `${estimateMatches(config).toLocaleString()} matches total`,
  );
  console.log(
    `  formats ${config.slate.formats.join(",")}  ` +
      `opponents ${config.slate.opponents.join(",")}  ` +
      `balance ${config.balanceConfigId}`,
  );
  console.log(`  checkpoint: ${checkpointPath}${has("resume") ? " (resuming)" : ""}\n`);

  const started = Date.now();
  const result = train({
    config,
    checkpointPath,
    resume: has("resume"),
    budgetMs: has("hours") ? flag("hours", 1) * 3_600_000 : undefined,
    onGeneration: (record) => {
      console.log(
        `  gen ${String(record.generation).padStart(3)}  ` +
          `best ${record.best.toFixed(4)}  mean ${record.mean.toFixed(4)}  ` +
          `species ${String(record.species).padStart(2)}  ` +
          `W/L/D ${record.wins}/${record.losses}/${record.draws}  ` +
          `timeouts ${String(record.timeouts).padStart(3)}  ` +
          `nodes ${record.meanNodes.toFixed(1)}  conns ${record.meanConnections.toFixed(0)}  ` +
          `${(record.durationMs / 1000).toFixed(1)}s`,
      );
    },
  });

  if (result.checkpointRejected) console.log(`\n  checkpoint not used: ${result.checkpointRejected}`);
  if (result.resumedFrom !== null) console.log(`\n  resumed from generation ${result.resumedFrom}`);

  const first = result.history[0];
  const last = result.history[result.history.length - 1];
  if (first && last) {
    console.log(
      `\n  topology  nodes ${first.meanNodes.toFixed(1)} -> ${last.meanNodes.toFixed(1)}   ` +
        `connections ${first.meanConnections.toFixed(1)} -> ${last.meanConnections.toFixed(1)}`,
    );
    console.log(
      `  fitness   best ${first.best.toFixed(4)} -> ${last.best.toFixed(4)}   ` +
        `mean ${first.mean.toFixed(4)} -> ${last.mean.toFixed(4)}`,
    );
  }

  const modelPath = text("model", "runs/neat/hard.json");
  writeModel(modelPath, toModel(result.best, config, "hard", result.bestGeneration ?? result.generations));
  console.log(
    `\n  champion ${result.best.id} fitness ${result.bestFitness.toFixed(4)}` +
      `${result.bestGeneration !== null ? ` (generation ${result.bestGeneration})` : ""}\n` +
      `  model written to ${modelPath}\n` +
      `  ${((Date.now() - started) / 60000).toFixed(1)} minutes`,
  );

  if (has("baseline")) {
    console.log("\n--- baselines on the final generation's slate ---\n");
    const slate = buildSlate(
      Math.max(0, result.generations - 1),
      config.slate,
      config.kingdoms,
      config.seed,
      config.balanceConfigId,
    );
    const report = runBaselines({
      slate,
      fitness: config.fitness,
      genomes: [{ name: "neat-champion", genome: result.best }],
      seed: config.seed,
    });
    console.log(formatBaselines(report));
  }
}

function baselineCommand(): void {
  const config = configFromFlags({ generations: 1, population: 1 });
  const slate = buildSlate(
    flag("generation", 0),
    config.slate,
    config.kingdoms,
    config.seed,
    config.balanceConfigId,
  );
  console.log(
    `Baselines — ${slate.scenarios.length} scenarios ` +
      `(formats ${config.slate.formats.join(",")}, balance ${config.balanceConfigId})\n`,
  );
  const started = Date.now();
  const report = runBaselines({ slate, fitness: config.fitness, seed: config.seed });
  console.log(formatBaselines(report));
  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

switch (command) {
  case "xor":
    xor();
    break;
  case "train":
    trainCommand();
    break;
  case "baseline":
    baselineCommand();
    break;
  default:
    console.log(
      [
        "NEAT for Elementals",
        "",
        "  npm run neat:xor                        prove the algorithm on XOR",
        "  npm run neat:baseline                   compare controllers on one slate",
        "  npm run neat:train -- --generations 5   evolve against real matches",
        "",
        "train / baseline flags:",
        "  --generations N        generations to run",
        "  --population N         genomes per generation",
        "  --formats a,b          duel, ffa4, ffa7 (default duel)",
        "  --kingdoms-per-genome  kingdoms each genome plays (default 2)",
        "  --opponents a,b        heuristic profiles faced",
        "  --rotations N          seat rotations per pairing (default 1)",
        "  --max-ticks N          per-match tick cap (default 8000)",
        "  --kingdoms a,b,c       restrict the roster",
        "  --balance ID           balance configuration identity (default baseline)",
        "  --checkpoint PATH      where to write/resume",
        "  --resume               resume from the checkpoint if compatible",
        "  --model PATH           where to write the trained model",
        "  --baseline             compare the champion against baselines afterwards",
        "  --seed N               run seed",
      ].join("\n"),
    );
}
