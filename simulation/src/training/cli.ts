import { runXor, XOR_CONFIG, withConfig } from "../neat/index.js";
import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { estimateMatches, toModel, train, writeModel } from "./trainer.js";
import { trainingConfig } from "./config.js";
import { slateSize } from "./slate.js";

/**
 * The NEAT command line.
 *
 *   npm run neat:xor                       prove the algorithm on XOR
 *   npm run neat:train -- --generations 5  evolve against real matches
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
  const kingdomFilter = text("kingdoms", "");
  const kingdoms: readonly KingdomId[] = kingdomFilter
    ? (kingdomFilter.split(",").filter((k) => (KINGDOM_IDS as readonly string[]).includes(k)) as KingdomId[])
    : KINGDOM_IDS;

  const config = trainingConfig({
    generations: flag("generations", 5),
    seed: flag("seed", 20260817),
    kingdoms,
    neat: { ...trainingConfig().neat, populationSize: flag("population", 30) },
    slate: {
      ...trainingConfig().slate,
      kingdomsPerGenome: flag("kingdoms-per-genome", 2),
      seatRotations: flag("rotations", 1),
      maxTicks: flag("max-ticks", 8_000),
    },
  });

  const checkpointPath = text("checkpoint", "runs/neat/checkpoint.json");
  const matchesPerGenome = slateSize(config.slate, config.kingdoms.length);
  console.log(
    `NEAT training — population ${config.neat.populationSize}, ` +
      `${config.generations} generations, ${matchesPerGenome} matches/genome, ` +
      `${estimateMatches(config).toLocaleString()} matches total`,
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
          `wins ${String(record.wins).padStart(4)}  ` +
          `timeouts ${String(record.timeouts).padStart(4)}  ` +
          `nodes ${record.meanNodes.toFixed(1)}  conns ${record.meanConnections.toFixed(0)}  ` +
          `${(record.durationMs / 1000).toFixed(1)}s`,
      );
    },
  });

  if (result.checkpointRejected) console.log(`\n  checkpoint not used: ${result.checkpointRejected}`);
  if (result.resumedFrom !== null) console.log(`\n  resumed from generation ${result.resumedFrom}`);

  const modelPath = text("model", "runs/neat/hard.json");
  writeModel(modelPath, toModel(result.best, config, "hard", result.generations));
  console.log(
    `\n  best fitness ${result.bestFitness.toFixed(4)} (${result.best.id})\n` +
      `  model written to ${modelPath}\n` +
      `  ${((Date.now() - started) / 60000).toFixed(1)} minutes`,
  );
}

switch (command) {
  case "xor":
    xor();
    break;
  case "train":
    trainCommand();
    break;
  default:
    console.log(
      [
        "NEAT for Elementals",
        "",
        "  npm run neat:xor                        prove the algorithm on XOR",
        "  npm run neat:xor -- --runs 10           more seeds",
        "  npm run neat:train -- --generations 5   evolve against real matches",
        "",
        "train flags:",
        "  --generations N        generations to run (default 5)",
        "  --population N         genomes per generation (default 30)",
        "  --kingdoms-per-genome  kingdoms each genome plays (default 2)",
        "  --rotations N          seat rotations per pairing (default 1)",
        "  --max-ticks N          per-match tick cap (default 8000)",
        "  --kingdoms a,b,c       restrict the roster",
        "  --checkpoint PATH      where to write/resume (default runs/neat/checkpoint.json)",
        "  --resume               resume from the checkpoint if compatible",
        "  --model PATH           where to write the trained model",
        "  --seed N               run seed",
      ].join("\n"),
    );
}
