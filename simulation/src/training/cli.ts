import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runXor, withConfig, XOR_CONFIG } from "../neat/index.js";
import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { trainingConfig, type TrainingConfig } from "./config.js";
import { buildSlate, buildValidationSlate, slateSize, slateSeatCost, type MatchFormat } from "./slate.js";
import { estimateMatches, toModel, train, writeModel } from "./trainer.js";
import { tableCount, type OpponentSelection, type SelfPlayConfig } from "./selfPlay.js";
import { formatBaselines, runBaselines } from "./baselines.js";
import { migrateSeeds } from "./warmStart.js";
import { createRunner, defaultWorkerCount } from "./parallel/runner.js";
import {
  behaviourDiversity,
  fitnessReliability,
  heritability,
  validationDiscrimination,
} from "./diagnostics.js";
import { Population } from "../neat/index.js";
import { ELEMENTALS_SHAPE } from "./matchEvaluator.js";

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

/** "3m42s" / "1h04m" — short enough to sit inside a generation line. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function opponentSelection(value: string): OpponentSelection {
  if (value === "banded" || value === "random" || value === "shuffle") return value;
  throw new Error(`--pairing must be shuffle, banded or random; got "${value}"`);
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
    mode: has("heuristic") ? "heuristic" : "selfPlay",
    selfPlay: {
      formats: formats.length > 0 ? formats : ["duel", "ffa4", "ffa7"],
      roundsPerFormat: flag("rounds-per-format", 2),
      hallOfFameShare: flag("hof-share", 0.15),
      maxTicks: flag("max-ticks", 8_000),
      opponentSelection: opponentSelection(text("pairing", "shuffle")),
    } satisfies SelfPlayConfig,
    validateEvery: flag("validate-every", 5),
    validationCandidates: flag("validation-candidates", 3),
    benchmarkEvery: flag("benchmark-every", 0),
    workers: flag("workers", defaultWorkerCount()),
    validationSeeds: flag("validation-seeds", 1),
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
      seedsPerScenario: flag("seeds", 1),
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

async function trainCommand(): Promise<void> {
  const config = configFromFlags({ generations: 5, population: 30 });
  const checkpointPath = text("checkpoint", "runs/neat/checkpoint.json");
  const perGenome = slateSize(config.slate, config.kingdoms.length);

  if (config.mode === "selfPlay") {
    const perGeneration = tableCount(config.selfPlay, config.neat.populationSize);
    console.log(
      `NEAT training (SELF-PLAY) — population ${config.neat.populationSize}, ` +
        `${config.generations} generations, ${perGeneration} matches/generation, ` +
        `${(perGeneration * config.generations).toLocaleString()} matches total`,
    );
    console.log(
      `  formats ${config.selfPlay.formats.join(",")}  ` +
        `${config.selfPlay.roundsPerFormat} rounds/format  ` +
        `hall-of-fame share ${config.selfPlay.hallOfFameShare}  ` +
        `pairing ${config.selfPlay.opponentSelection}  ` +
        `workers ${config.workers}  ` +
        `balance ${config.balanceConfigId}`,
    );
  } else {
    console.log(
      `NEAT training (heuristic) — population ${config.neat.populationSize}, ` +
        `${config.generations} generations, ${perGenome} matches/genome, ` +
        `${estimateMatches(config).toLocaleString()} matches total`,
    );
    console.log(
      `  formats ${config.slate.formats.join(",")}  ` +
        `opponents ${config.slate.opponents.join(",")}  ` +
        `balance ${config.balanceConfigId}`,
    );
  }
  // Must mirror the trainer's own construction exactly, seeds included, or the
  // header advertises a slate the run does not use.
  const validation = buildValidationSlate(config.kingdoms, config.balanceConfigId, {
    maxTicks: config.slate.maxTicks,
    seedsPerScenario: config.validationSeeds,
  });
  console.log(
    `  validation: ${validation.scenarios.length} frozen scenarios ` +
      `(${slateSeatCost(validation)} seats), top ${config.validationCandidates} genomes ` +
      `every ${config.validateEvery} generations (${config.validationSeeds} seed(s)) ` +
      `— the champion is SELECTED by this`,
  );
  console.log(`  checkpoint: ${checkpointPath}${has("resume") ? " (resuming)" : ""}\n`);

  const warmFrom = text("warm-from", "");
  if (warmFrom) {
    console.log(`  WARM START from ${warmFrom} — migrated onto the current observation
`);
  }

  const started = Date.now();
  // A one-line progress file beside the checkpoint.
  //
  // A long run's ETA is otherwise buried in scrollback, and answering "how much
  // time is left" means parsing a log. One file, overwritten each generation, is
  // a single `cat` away — which is the whole point.
  const progressPath = text("progress", `${dirname(checkpointPath)}/progress.txt`);
  let completed = 0;

  const result = await train({
    config,
    checkpointPath,
    resume: has("resume"),
    warmSeeds: warmFrom ? migrateSeeds(warmFrom) : undefined,
    budgetMs: has("hours") ? flag("hours", 1) * 3_600_000 : undefined,
    onChampion: (genome, generation, validation) => {
      // One file per champion, so the whole lineage survives the run and a
      // difficulty ladder can be chosen from measured snapshots afterwards.
      const dir = `${dirname(checkpointPath)}/champions`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          `${dir}/gen${String(generation).padStart(4, "0")}-${genome.id}.json`,
          JSON.stringify({ generation, validation, genome }),
          "utf8",
        );
      } catch {
        // Snapshotting must never be able to kill a training run.
      }
    },
    onGeneration: (record) => {
      completed += 1;
      const elapsed = Date.now() - started;
      const perGeneration = elapsed / completed;
      const remaining = Math.max(0, config.generations - (record.generation + 1));
      const eta = remaining * perGeneration;
      const line =
        `gen ${record.generation + 1}/${config.generations}  ` +
        `elapsed ${duration(elapsed)}  per-gen ${(perGeneration / 1000).toFixed(1)}s  ` +
        `${remaining} left  ETA ${duration(eta)}  ` +
        `finishes ${new Date(Date.now() + eta).toLocaleTimeString()}  ` +
        (record.matchesSaved > 0 ? `saved ${record.matchesSaved} matches  ` : "") +
        `| train best ${record.best.toFixed(4)}  ` +
        `validation ${record.validationFitness?.toFixed(4) ?? "—"}  ` +
        `champion ${record.championId ?? "—"} @ ${record.championValidation?.toFixed(4) ?? "—"}`;
      try {
        mkdirSync(dirname(progressPath), { recursive: true });
        writeFileSync(progressPath, `${line}\n`, "utf8");
      } catch {
        // Progress reporting must never be able to kill a training run.
      }
      console.log(`  ${line.split(" |")[0]}`);

      console.log(
        `  gen ${String(record.generation).padStart(3)}  ` +
          `train best ${record.best.toFixed(4)} mean ${record.mean.toFixed(4)}  ` +
          `species ${String(record.species).padStart(2)}  ` +
          `div ${record.diversity.toFixed(3)}  ` +
          `nodes ${record.meanNodes.toFixed(1)}  ` +
          `conns ${record.meanConnections.toFixed(0)}/${record.meanExpressed.toFixed(0)}  ` +
          `fp ${record.bestFingerprint}  ` +
          `W/L/D ${record.wins}/${record.losses}/${record.draws}  ` +
          `hof ${String(record.hallOfFame).padStart(2)}  ` +
          `${(record.durationMs / 1000).toFixed(1)}s`,
      );
      if (record.validationFitness !== null) {
        console.log(
          `           VALIDATION  best ${record.validationFitness.toFixed(4)}  ` +
            `mean ${(record.validationMean ?? 0).toFixed(4)}  ` +
            `win% ${(100 * (record.validationWinRate ?? 0)).toFixed(1)}  ` +
            `place ${(record.validationPlacement ?? 0).toFixed(2)}  ` +
            `casts/match ${(record.validationCastsPerMatch ?? 0).toFixed(1)}  ` +
            `KIT ${(record.validationDistinctAbilities ?? 0).toFixed(1)}/${record.validationKitSize ?? 0}  ` +
            `champion ${record.championId ?? "—"} ` +
            `@ ${(record.championValidation ?? 0).toFixed(4)}`,
        );
      }
      if (record.benchmark) {
        const rows = [...record.benchmark].sort((a, b) => b.fitness - a.fitness);
        console.log(
          `           BENCHMARK   ` +
            rows
              .map((r) => `${r.name} ${r.fitness.toFixed(3)} (${(100 * r.winRate).toFixed(0)}%)`)
              .join("  "),
        );
      }
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
    console.log(
      `  diversity ${first.diversity.toFixed(3)} -> ${last.diversity.toFixed(3)}   ` +
        `species ${first.species} -> ${last.species}`,
    );

    // The question a fitness curve cannot answer: is this a different network,
    // or the same one being re-measured against a field that moved?
    const fingerprints = new Set(result.history.map((r) => r.bestFingerprint));
    console.log(
      `  best genome  gen ${first.generation} ${first.bestGenomeId} [${first.bestFingerprint}]  ` +
        `-> gen ${last.generation} ${last.bestGenomeId} [${last.bestFingerprint}]`,
    );
    console.log(
      `  -> the population's best ${
        first.bestFingerprint === last.bestFingerprint
          ? "COMPUTES THE SAME FUNCTION it did at the start — nothing evolved"
          : "is a different network from the one it started with"
      } (${fingerprints.size} distinct across ${result.history.length} generations)`,
    );

    const validated = result.history.filter((r) => r.validationFitness !== null);
    if (validated.length >= 2) {
      const firstVal = validated[0]!.validationFitness!;
      const lastVal = validated[validated.length - 1]!.validationFitness!;
      console.log(
        `  validation  ${firstVal.toFixed(4)} (gen ${validated[0]!.generation}) -> ` +
          `${lastVal.toFixed(4)} (gen ${validated[validated.length - 1]!.generation})   ` +
          `${lastVal > firstVal ? "improved" : lastVal < firstVal ? "regressed" : "flat"}`,
      );
    }
  }

  const saved = result.cache;
  if (saved.hits + saved.misses > 0) {
    console.log(
      `  memo      ${saved.hits} hits / ${saved.hits + saved.misses} lookups  ` +
        `— ${saved.matchesSaved.toLocaleString()} matches not replayed`,
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
    const runner = createRunner(config.workers);
    const report = await runBaselines(runner, {
      slate,
      fitness: config.fitness,
      genomes: [{ name: "neat-champion", genome: result.best }],
      seed: config.seed,
    });
    await runner.close();
    console.log(formatBaselines(report));
  }
}

async function baselineCommand(): Promise<void> {
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
  const runner = createRunner(config.workers);
  const report = await runBaselines(runner, { slate, fitness: config.fitness, seed: config.seed });
  await runner.close();
  console.log(formatBaselines(report));
  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function diagnoseCommand(): void {
  const config = configFromFlags({ generations: 1, population: flag("population", 16) });
  const size = config.neat.populationSize;
  const genomes = new Population(ELEMENTALS_SHAPE, config.neat, flag("seed", 20260817)).ask();

  console.log(
    `Diagnosing a flat validation curve — population ${size}, ` +
      `${config.kingdoms.length} kingdoms, maxTicks ${config.slate.maxTicks}
`,
  );

  console.log("1. IS SELECTION READING SIGNAL OR NOISE?");
  const reliability = fitnessReliability(genomes, config);
  console.log(`   matches per genome        ${reliability.matchesPerGenome}`);
  console.log(`   spread between genomes    ${reliability.acrossGenomes.toFixed(4)}`);
  console.log(`   spread of one genome      ${reliability.withinGenome.toFixed(4)}  (same genome, different draw)`);
  console.log(`   signal-to-noise           ${reliability.signalToNoise.toFixed(2)}`);
  console.log(`   draw-to-draw correlation  ${reliability.correlation.toFixed(3)}`);
  console.log(
    `   -> ${reliability.correlation < 0.3
      ? "SELECTION IS SORTING NOISE. More generations cannot help; more matches per genome can."
      : "fitness is repeatable enough to select on."}
`,
  );

  console.log("2. CAN VALIDATION TELL GENOMES APART?");
  const discrimination = validationDiscrimination(genomes.slice(0, 8), config);
  console.log(`   scenarios                 ${discrimination.scenarios}`);
  console.log(`   min / median / max        ${discrimination.min.toFixed(4)} / ${discrimination.median.toFixed(4)} / ${discrimination.max.toFixed(4)}`);
  console.log(`   spread / stdev            ${discrimination.spread.toFixed(4)} / ${discrimination.stdev.toFixed(4)}`);
  console.log(
    `   -> ${discrimination.spread < 0.05
      ? "VALIDATION CANNOT DISCRIMINATE. The champion is close to arbitrary."
      : "validation separates genomes."}
`,
  );

  console.log("3. DOES A CHILD INHERIT ITS PARENT'S SKILL?");
  const inherit = heritability(genomes[0]!, config, flag("children", 6));
  console.log(`   parent                    ${inherit.parent.toFixed(4)}`);
  console.log(`   children mean             ${inherit.meanChild.toFixed(4)}`);
  console.log(`   mean drift per mutation   ${inherit.meanDrift.toFixed(4)}`);
  console.log(`   children within 5%        ${(100 * inherit.nearParent).toFixed(0)}%`);
  console.log(
    `   -> ${inherit.meanDrift > discrimination.spread
      ? "ONE MUTATION MOVES SKILL MORE THAN THE POPULATION SPANS. Nothing accumulates."
      : "mutation steps are small enough to refine rather than re-roll."}
`,
  );

  console.log("4. DO GENOMES ACTUALLY PLAY DIFFERENTLY?");
  const behaviour = behaviourDiversity(genomes.slice(0, 6), config);
  console.log(`   mean decisions            ${behaviour.meanDecisions.toFixed(0)}`);
  console.log(`   behaviour diversity       ${behaviour.diversity.toFixed(4)}  (0 = identical policies)`);
  for (const [i, p] of behaviour.profiles.entries()) {
    console.log(
      `     genome ${i}  cast ${(100 * p.casts).toFixed(1)}%  invest ${(100 * p.invests).toFixed(1)}%  ` +
        `economy ${(100 * p.economy).toFixed(1)}%  wait ${(100 * p.waits).toFixed(1)}%  ` +
        `(forced ${(100 * p.forcedShare).toFixed(1)}%)  ` +
        `switch ${(100 * p.switchRate).toFixed(1)}%  distinct ${p.distinctActions}/14  ` +
        `legal/dec ${p.legalPerDecision.toFixed(1)}`,
    );
  }
  console.log(
    `   -> ${behaviour.diversity < 0.02
      ? "THE POPULATION IS ONE POLICY. There is nothing to select between."
      : "policies differ."}`,
  );
}

switch (command) {
  case "diagnose":
    diagnoseCommand();
    break;
  case "xor":
    xor();
    break;
  case "train":
    await trainCommand();
    break;
  case "baseline":
    await baselineCommand();
    break;
  default:
    console.log(
      [
        "NEAT for Elementals",
        "",
        "  npm run neat:xor                        prove the algorithm on XOR",
        "  npm run neat:baseline                   compare controllers on one slate",
        "  npm run neat:diagnose                   why is the validation curve flat?",
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
        "  --validate-every N     run the frozen validation slate every N generations (default 5)",
        "  --validation-candidates N  genomes validated per check; the champion is picked from them (default 3)",
        "  --seeds N              repeats per scenario on different seeds",
        "  --hours N              stop cleanly at a generation boundary after N hours",
        "  --heuristic            train against fixed personalities instead of self-play",
        "  --rounds-per-format N  self-play matches per genome per format (default 2)",
        "  --hof-share F          fraction of seats given to past champions (default 0.15)",
        "  --pairing MODE         self-play pairing: shuffle, banded or random (default shuffle)",
        "  --workers N            match worker threads; 1 runs in-process (default: two thirds of cores)",
        "  --validation-seeds N   repeats of each validation scenario on independent seeds (default 1)",
        "  --benchmark-every N    benchmark the champion against the heuristics every N generations (0 = never)",
        "  --warm-from PATH       continue from a trained model instead of starting fresh",
        "  --seed N               run seed",
      ].join("\n"),
    );
}
