import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Population, cloneGenome, type GenerationReport, type Genome } from "../neat/index.js";
import { MODEL_FORMAT_VERSION, type AiModel, type Difficulty } from "../ai/index.js";
import type { TrainingConfig } from "./config.js";
import { ELEMENTALS_SHAPE, evaluateGenome } from "./matchEvaluator.js";
import { buildSlate, buildValidationSlate, slateSize, type Slate } from "./slate.js";
import {
  HallOfFame,
  buildSelfPlayTables,
  collectResults,
  seatTables,
  tableCount,
} from "./selfPlay.js";
import { createRunner, defaultWorkerCount, type MatchRunner } from "./parallel/runner.js";
import type { TrainingResult } from "./fitness.js";
import { AI_FITNESS_VERSION } from "./fitness.js";
import { runBaselines } from "./baselines.js";
import { EvaluationCache, genomeKey, type CacheStats } from "./evaluationCache.js";
import {
  expressedConnections,
  geneticDiversity,
  genomeFingerprint,
} from "./populationStats.js";
import {
  TRAINING_CHECKPOINT_VERSION,
  localIdentity,
  readCheckpoint,
  writeCheckpoint,
  type TrainingCheckpoint,
} from "./checkpoint.js";

/**
 * The training loop.
 *
 * Deliberately thin: NEAT owns evolution, `matchEvaluator` owns the game, and
 * this coordinates them and writes down what happened. Everything expensive is
 * behind `evaluateGenome`, so a distributed version later replaces one call
 * rather than restructuring the loop — the same shape `search/run.ts` uses.
 */

export interface GenerationRecord extends GenerationReport {
  wins: number;
  losses: number;
  draws: number;
  timeouts: number;
  inactive: number;
  meanPlacement: number;
  matches: number;
  damageDealt: number;
  damageReceived: number;
  kills: number;
  casts: number;
  slateHash: string;
  /** Matches actually played this generation (self-play shares matches). */
  matchesPlayed: number;
  hallOfFame: number;
  /**
   * BEST validated fitness among this generation's candidates, when validation
   * ran. Null otherwise — never interpolated, because a made-up point on a
   * generalisation curve is worse than a gap in it.
   */
  validationFitness: number | null;
  /** MEAN validated fitness across the same candidates. */
  validationMean: number | null;
  validationWins: number | null;
  /** Win rate of the best validated candidate, over the frozen slate. */
  validationWinRate: number | null;
  /** Mean finishing position of that candidate (1 = first). */
  validationPlacement: number | null;
  /** Its casts per match — the check that a policy has not collapsed to waiting. */
  validationCastsPerMatch: number | null;
  /** Mean pairwise compatibility distance — 0 means one policy wearing hats. */
  diversity: number;
  /** Mean ENABLED connections; `meanConnections` counts disabled genes too. */
  meanExpressed: number;
  /**
   * Content hash of the generation's best genome.
   *
   * The answer to "did anything actually change" that an id cannot give: ids
   * increment whether or not a clone differs from its parent, whereas two equal
   * fingerprints are two networks that compute the same function.
   */
  bestFingerprint: string;
  /** The standing champion after this generation, and what it scored. */
  championId: string | null;
  championValidation: number | null;
  /**
   * Champion against the heuristic benchmarks, when one was run.
   *
   * EVALUATION ONLY. Nothing here feeds selection, reproduction or the Hall of
   * Fame — see the note on `hallOfFame` in the loop below for why that
   * separation is the point rather than a detail.
   */
  benchmark: BenchmarkRow[] | null;
  /** Matches this generation did NOT play because a memo already had them. */
  matchesSaved: number;
  durationMs: number;
}

export interface BenchmarkRow {
  name: string;
  kind: string;
  fitness: number;
  winRate: number;
}

export interface TrainingRunResult {
  generations: number;
  history: GenerationRecord[];
  best: Genome;
  bestFitness: number;
  /** Generation the champion was found in; survives a resume. */
  bestGeneration: number | null;
  /** The champion's frozen-slate score — what it was selected by. */
  bestValidation: number | null;
  /**
   * The champion's full per-scenario result.
   *
   * Null when the champion was restored from a checkpoint rather than found in
   * this session — the detail is too large to persist, and the genome is what a
   * model needs.
   */
  bestResult: TrainingResult | null;
  resumedFrom: number | null;
  checkpointRejected: string | null;
  /** Frozen-slate memo effectiveness over the whole run. */
  cache: CacheStats;
}

export interface TrainOptions {
  config: TrainingConfig;
  /** Where to write the checkpoint; omit for an in-memory run. */
  checkpointPath?: string;
  /** Resume from `checkpointPath` when one is present and compatible. */
  resume?: boolean;
  onGeneration?: (record: GenerationRecord) => void;
  /** Stop at the next generation boundary once this much wall clock is spent. */
  budgetMs?: number;
  /**
   * Match executor. Defaults to `config.workers`.
   *
   * Injectable so the equivalence test can drive the identical run through the
   * serial and parallel paths and diff the histories.
   */
  runner?: MatchRunner;
}

export async function train(options: TrainOptions): Promise<TrainingRunResult> {
  const { config } = options;
  const identity = localIdentity(config);

  let population: Population;
  let history: GenerationRecord[] = [];
  let restoredChampion: Genome | null = null;
  let restoredChampionGeneration: number | null = null;
  let restoredHall: { genome: Genome; generation: number }[] | null = null;
  let restoredLastAdmitted: string | null = null;
  let restoredChampionValidation: number | null = null;
  let startGeneration = 0;
  let resumedFrom: number | null = null;
  let checkpointRejected: string | null = null;

  if (options.resume && options.checkpointPath) {
    const load = readCheckpoint(options.checkpointPath, identity);
    checkpointRejected = load.rejected;
    if (load.checkpoint) {
      population = Population.restore(load.checkpoint.population, config.neat);
      history = load.checkpoint.history;
      startGeneration = load.checkpoint.completedGenerations;
      resumedFrom = startGeneration;
      restoredChampion = load.checkpoint.champion;
      restoredChampionGeneration = load.checkpoint.championGeneration;
      restoredHall = load.checkpoint.hallOfFame ?? null;
      restoredLastAdmitted = load.checkpoint.lastAdmitted ?? null;
      restoredChampionValidation = load.checkpoint.championValidation ?? null;
    } else {
      population = new Population(ELEMENTALS_SHAPE, config.neat, config.seed);
    }
  } else {
    population = new Population(ELEMENTALS_SHAPE, config.neat, config.seed);
  }

  // Owned here unless one was injected, so a caller that supplies a runner keeps
  // it alive across runs rather than having it terminated underneath them.
  const runner = options.runner ?? createRunner(config.workers);
  const ownsRunner = options.runner === undefined;

  const started = Date.now();
  // The champion is snapshotted at EVALUATION time, not read back from the
  // population afterwards. `tell()` replaces the population, and elites are
  // cloned complete with their parent's fitness, so asking the live population
  // for its best after a generation returns a genome whose recorded fitness was
  // measured on a different generation's slate.
  // Built once and reused: frozen is the whole point, and rebuilding it per
  // generation would invite it to drift.
  const validationSlate =
    config.validateEvery > 0
      ? buildValidationSlate(config.kingdoms, config.balanceConfigId, {
          maxTicks: config.slate.maxTicks,
          seedsPerScenario: config.validationSeeds,
        })
      : null;

  // The benchmark slate is built ONCE and never rotated.
  //
  // An earlier version rebuilt it per generation from `buildSlate(generation,
  // ...)`, which made the benchmark useless for the one job it has: the random
  // baseline scored 0.583 on generation 0's slate and 0.424 on generation 4's,
  // so a champion could appear to decline purely because the scenarios changed
  // underneath it. A yardstick that moves is not a yardstick.
  const benchmarkSlate =
    config.benchmarkEvery > 0
      ? buildSlate(
          0,
          { ...config.slate, opponents: config.benchmarkOpponents },
          config.kingdoms,
          config.seed,
          config.balanceConfigId,
        )
      : null;

  // One memo for every frozen-slate evaluation this run makes.
  //
  // Both slates above never change, and slate evaluation is deterministic, so a
  // genome scored once has been scored forever. The 50-generation run played
  // 12,600 matches and at least 4,176 of them recomputed a number it already
  // had — an unchanged champion re-benchmarked for nine consecutive checks, and
  // four heuristic baselines re-scored twenty-five times to the same four
  // decimals. Nothing here changes what is measured, only how often.
  const cache = new EvaluationCache();

  // Past champions kept as opposition. Under self-play the population can
  // otherwise cycle — A beats B beats C beats A — and call the churn progress.
  const hallOfFame = restoredHall
    ? HallOfFame.fromJSON(restoredHall)
    : new HallOfFame();
  let lastAdmitted: string | null = restoredLastAdmitted;

  let champion: Genome | null = restoredChampion;
  let championGeneration: number | null = restoredChampionGeneration;
  // The champion's score on the frozen slate — the metric it was chosen BY.
  // Training fitness cannot serve here: under self-play it is relative to
  // whoever a genome was drawn against, so "best ever" crowns a lucky draw and
  // then nothing can displace it, because the number was never comparable.
  let championValidation: number | null = restoredChampionValidation;
  // Only populated when the champion is found in THIS session: the per-scenario
  // detail is far too large to carry in a checkpoint, and the genome is what a
  // model actually needs.
  let championResult: TrainingResult | null = null;

  for (let generation = startGeneration; generation < config.generations; generation++) {
    const generationStarted = Date.now();
    const savedBefore = cache.stats.matchesSaved;
    // One slate per generation, shared by every genome: a fitness difference is
    // then a difference in play rather than in which matchups were drawn.
    const slate: Slate = buildSlate(
      generation,
      config.slate,
      config.kingdoms,
      config.seed,
      config.balanceConfigId,
    );
    const genomes = population.ask();

    let results: TrainingResult[];
    let matchesPlayed: number;
    if (config.mode === "selfPlay") {
      // Strongest-first by the fitness each genome carries out of the previous
      // generation. Read off the genomes rather than held in a local, so a
      // resumed run reconstructs the identical order from the restored
      // population instead of silently re-pairing everyone.
      const ranking = genomes
        .map((genome, index) => ({ fitness: genome.fitness, index }))
        .sort((a, b) => b.fitness - a.fitness || a.index - b.index)
        .map((entry) => entry.index);
      const tables = buildSelfPlayTables(
        generation,
        config.selfPlay,
        genomes.length,
        config.kingdoms,
        hallOfFame.size,
        ranking,
      );
      // Seating is settled on this thread, then the matches go wide. Results
      // come back in table order, so the aggregation below adds exactly the
      // numbers the serial path adds, in the same sequence.
      const seated = seatTables(tables, genomes, hallOfFame.genomes);
      await runner.setPopulation(genomes, hallOfFame.genomes);
      const rows = await runner.playTables(seated, config.fitness);
      results = collectResults(rows, genomes.length);
      matchesPlayed = tables.length;
    } else {
      results = [];
      for (const genome of genomes) {
        results.push(
          await runner.evaluate({ kind: "genome", genome, name: genome.id }, slate, config.fitness),
        );
      }
      matchesPlayed = results.reduce((sum, r) => sum + r.matches, 0);
    }

    // ── The Hall of Fame is seeded from SELF-PLAY, never from validation. ─────
    //
    // It used to take the validated champion, and that was an information leak
    // in the wrong direction twice over. Hall-of-Fame members occupy TRAINING
    // seats, so choosing them by the frozen slate meant (a) performance against
    // heuristic personalities decided part of the training opposition, putting
    // the heuristics back in the teacher's chair by the back door, and (b) the
    // held-out slate influenced reproduction, which is precisely what held-out
    // means it must not do.
    //
    // The generation's best self-play genome is the right anchor: it is the
    // strongest player the population produced, measured only against the
    // population. Validation still selects the champion that gets EXPORTED —
    // that is a report, not a parent.
    if (config.mode === "selfPlay" && results.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < results.length; i++) {
        if (results[i]!.fitness > results[bestIndex]!.fitness) bestIndex = i;
      }
      const anchor = genomes[bestIndex]!;
      if (anchor.id !== lastAdmitted) {
        hallOfFame.admit(cloneGenome(anchor), generation);
        lastAdmitted = anchor.id;
      }
    }

    const report = population.tell(results.map((r) => r.fitness));
    const sum = (pick: (r: TrainingResult) => number): number =>
      results.reduce((total, r) => total + pick(r), 0);

    // Validation both MEASURES and SELECTS.
    //
    // The generation's strongest few by training fitness go through the frozen
    // slate, and the best validated one becomes champion if it beats the
    // standing champion's own validated score. Training fitness cannot do this
    // job under self-play: it is relative to whoever a genome was drawn
    // against, so "best ever" crowned a lucky draw at generation 11 of a
    // 60-generation run and nothing could displace it, because the number was
    // never comparable to anything after it.
    //
    // Scheduled purely by generation INDEX, never by position within the run.
    // An earlier version also validated on the final generation, which made the
    // schedule depend on config.generations — so a run stopped at 2 and resumed
    // to 4 validated at different generations than one that ran straight
    // through, and the recorded history diverged. Caught by the resume-
    // equivalence test.
    let validationFitness: number | null = null;
    let validationMean: number | null = null;
    let validationWins: number | null = null;
    let validationWinRate: number | null = null;
    let validationPlacement: number | null = null;
    let validationCastsPerMatch: number | null = null;
    if (validationSlate && config.validateEvery > 0 && generation % config.validateEvery === 0) {
      const ranked = results
        .map((result, index) => ({ fitness: result.fitness, index }))
        .sort((a, b) => b.fitness - a.fitness || a.index - b.index)
        .slice(0, Math.max(1, config.validationCandidates));

      let bestGenome: Genome | null = null;
      let bestResult: TrainingResult | null = null;
      const scores: number[] = [];
      for (const { index } of ranked) {
        const candidate = genomes[index]!;
        // Elites are carried through reproduction unchanged, so the same genome
        // is routinely re-validated across consecutive checks. Keyed by content
        // rather than id: a clone under a new id must hit, and a mutated genome
        // that kept its id must not.
        const key = genomeKey("val", genomeFingerprint(candidate), validationSlate.hash);
        const validated =
          cache.peek(key) ??
          cache.put(
            key,
            await runner.evaluate(
              { kind: "genome", genome: candidate, name: candidate.id },
              validationSlate,
              config.fitness,
            ),
          );
        scores.push(validated.fitness);
        if (bestResult === null || validated.fitness > bestResult.fitness) {
          bestGenome = candidate;
          bestResult = validated;
        }
      }

      if (bestGenome !== null && bestResult !== null) {
        validationFitness = bestResult.fitness;
        validationMean = scores.reduce((sum, x) => sum + x, 0) / scores.length;
        validationWins = bestResult.wins;
        validationWinRate = bestResult.matches > 0 ? bestResult.wins / bestResult.matches : 0;
        validationPlacement = bestResult.meanPlacement;
        validationCastsPerMatch =
          bestResult.matches > 0 ? bestResult.totalCasts / bestResult.matches : 0;
        if (championValidation === null || bestResult.fitness > championValidation) {
          const snapshot = cloneGenome(bestGenome);
          snapshot.fitness = bestResult.fitness;
          champion = snapshot;
          championValidation = bestResult.fitness;
          championGeneration = generation;
          championResult = bestResult;
        }
      }
    }

    // Benchmarks: the champion against random, the heuristic personalities and
    // the Hall of Fame. Purely a readout — under self-play, fitness is relative
    // to whoever a genome was drawn against, so an absolute reference is the
    // only way to tell "the population improved" from "the field got weaker".
    // It is computed AFTER selection and consumed by nobody.
    let benchmark: BenchmarkRow[] | null = null;
    if (
      benchmarkSlate &&
      config.benchmarkEvery > 0 &&
      generation % config.benchmarkEvery === 0 &&
      champion !== null
    ) {
      const benchReport = await runBaselines(runner, {
        slate: benchmarkSlate,
        fitness: config.fitness,
        cache,
        fingerprint: genomeFingerprint,
        personalities: config.benchmarkOpponents,
        genomes: [
          { name: "champion", genome: champion },
          ...hallOfFame.genomes
            .slice(-1)
            .map((genome, i) => ({ name: `hof-${i}`, genome })),
        ],
        seed: config.seed,
      });
      benchmark = benchReport.entries.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        fitness: entry.result.fitness,
        winRate: entry.result.matches > 0 ? entry.result.wins / entry.result.matches : 0,
      }));
    }

    const record: GenerationRecord = {
      ...report,
      wins: sum((r) => r.wins),
      losses: sum((r) => r.losses),
      draws: sum((r) => r.draws),
      timeouts: sum((r) => r.timeouts),
      inactive: sum((r) => r.inactive),
      meanPlacement: sum((r) => r.meanPlacement) / results.length,
      matches: sum((r) => r.matches),
      damageDealt: sum((r) => r.totalDamageDealt),
      damageReceived: sum((r) => r.totalDamageReceived),
      kills: sum((r) => r.totalKills),
      casts: sum((r) => r.totalCasts),
      slateHash: slate.hash,
      matchesPlayed,
      hallOfFame: hallOfFame.size,
      validationFitness,
      validationMean,
      validationWins,
      validationWinRate,
      validationPlacement,
      validationCastsPerMatch,
      diversity: geneticDiversity(genomes, config.neat),
      meanExpressed:
        genomes.reduce((sum, genome) => sum + expressedConnections(genome), 0) /
        Math.max(1, genomes.length),
      // Fingerprinted from the genome the population NOMINATED this generation,
      // not from the exported champion: the question this answers is whether the
      // population is still moving, and a frozen champion would hide that.
      bestFingerprint: genomeFingerprint(
        genomes.find((genome) => genome.id === report.bestGenomeId) ?? genomes[0]!,
      ),
      championId: champion?.id ?? null,
      championValidation,
      benchmark,
      matchesSaved: cache.stats.matchesSaved - savedBefore,
      durationMs: Date.now() - generationStarted,
    };
    history.push(record);
    options.onGeneration?.(record);

    if (
      options.checkpointPath &&
      config.checkpointEvery > 0 &&
      (generation + 1) % config.checkpointEvery === 0
    ) {
      writeCheckpoint(options.checkpointPath, {
        version: TRAINING_CHECKPOINT_VERSION,
        identity,
        writtenAt: new Date().toISOString(),
        completedGenerations: generation + 1,
        population: population.snapshot(),
        history,
        champion,
        championGeneration,
        championValidation,
        hallOfFame: hallOfFame.toJSON(),
        lastAdmitted,
      } satisfies TrainingCheckpoint);
    }

    if (options.budgetMs !== undefined && Date.now() - started >= options.budgetMs) break;
  }

  if (ownsRunner) await runner.close();

  const best: Genome = champion ?? population.best();
  return {
    generations: history.length,
    history,
    best,
    bestFitness: best.fitness,
    bestGeneration: championGeneration,
    bestValidation: championValidation,
    bestResult: championResult,
    resumedFrom,
    checkpointRejected,
    cache: { ...cache.stats },
  };
}

/** Matches one training run will play, for budgeting. */
export function estimateMatches(config: TrainingConfig): number {
  return (
    config.neat.populationSize *
    slateSize(config.slate, config.kingdoms.length) *
    config.generations
  );
}

/**
 * Packages a trained genome as a loadable model.
 *
 * Difficulty is a property of the MODEL, not of the algorithm: the same NEAT
 * engine produces all three, and `ai/difficulty.ts` decides cadence and noise at
 * runtime. That is what keeps Easy/Medium/Hard one lineage rather than three
 * unrelated players.
 */
export function toModel(
  genome: Genome,
  config: TrainingConfig,
  difficulty: Difficulty,
  generation: number,
): AiModel {
  const identity = localIdentity(config);
  return {
    formatVersion: MODEL_FORMAT_VERSION,
    kind: "elementals.ai.model",
    difficulty,
    identity: {
      observationVersion: identity.observationVersion,
      actionVersion: identity.actionVersion,
      genomeVersion: identity.genomeVersion,
      engineSha: identity.engineSha,
      engineDirty: identity.engineDirty,
      balanceConfigHash: identity.balanceConfigHash,
      balanceBaselineHash: identity.balanceBaselineHash,
      kingdomCount: 16,
    },
    training: {
      seed: config.seed,
      generation,
      fitnessVersion: AI_FITNESS_VERSION,
      trainedAt: new Date().toISOString(),
    },
    genome,
  };
}

export function writeModel(path: string, model: AiModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2), "utf8");
}
