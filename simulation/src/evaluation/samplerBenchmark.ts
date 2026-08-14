import type { KingdomId } from "../../../src/data/kingdoms.js";
import { evaluate, type EvaluationResult } from "./evaluator.js";
import { SAMPLERS, coverageQuality, type CoverageQuality } from "./samplers.js";
import { uncertainty } from "./stats.js";
import type { SeedPoolName } from "./seeds.js";

/**
 * Sampler benchmark.
 *
 * Answers the Step 6 question: given a finite budget, which FFA compositions
 * should we evaluate to get the most trustworthy picture of balance?
 *
 * The metric that matters is NOT how much of the composition space a sampler
 * touches. C(16,7) is 11,440 and any affordable sample covers a rounding error
 * of it; a sampler that covered twice as much while leaving one kingdom
 * under-observed would be worse. What matters is how much uncertainty is
 * removed per minute, and whether two disjoint seed pools agree.
 *
 * This is a diagnostic comparison of measuring instruments. It is not the
 * Balance AI's fitness function and must not become one.
 */

export interface SamplerTrial {
  sampler: string;
  samplerVersion: number;
  seats: number;
  compositions: number;
  matches: number;
  runtimeMs: number;
  matchesPerSecond: number;
  coverage: CoverageQuality;
  /** Mean 95% interval width on per-kingdom first-place rate. */
  firstPlaceCi: number;
  /** Mean 95% interval width on per-kingdom last-place rate. */
  lastPlaceCi: number;
  /** Largest per-kingdom disagreement in mean placement between two disjoint
   *  seed pools — the honest test of whether a reading is repeatable. */
  poolDisagreement: number;
  /** Largest per-kingdom disagreement in first-place rate, in points. */
  poolDisagreementFirstPp: number;
  /** Worst-case seat imbalance: max spread in mean placement across seats,
   *  averaged over kingdoms. Rotation should drive this toward zero. */
  seatBias: number;
  /** Uncertainty removed per minute of compute — the headline comparison. */
  informationPerMinute: number;
}

export interface SamplerBenchmarkOptions {
  seats: number;
  /** Composition budgets to test. */
  budgets: number[];
  samplers?: string[];
  seedsPerPairing?: number;
  workers?: number;
  /** Restrict duels off — this benchmark is about FFA. */
  onTrial?: (trial: SamplerTrial) => void;
}

/** Mean of a list, or 0. */
const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

function ffaOf(result: EvaluationResult, seats: number) {
  return seats === 4 ? result.ffa4! : result.ffa7!;
}

/** Runs one sampler at one budget on one seed pool. */
async function runOne(
  sampler: string,
  seats: number,
  budget: number,
  pool: SeedPoolName,
  options: SamplerBenchmarkOptions,
): Promise<EvaluationResult> {
  const format = { enabled: true, seedsPerPairing: options.seedsPerPairing ?? 1, compositions: budget, sampler };
  return evaluate({
    balanceConfigId: `sampler-${sampler}-${seats}-${budget}`,
    pool,
    workers: options.workers,
    duel: { enabled: false },
    ffa4: seats === 4 ? format : { enabled: false },
    ffa7: seats === 7 ? format : { enabled: false },
  });
}

/**
 * Benchmarks every sampler at every budget.
 *
 * Each trial is run on two disjoint seed pools so stability can be measured
 * rather than assumed — a sampler that produces a tight interval but a
 * different answer each pool is worse than a slightly looser one that repeats.
 */
export async function benchmarkSamplers(
  options: SamplerBenchmarkOptions,
): Promise<SamplerTrial[]> {
  const names = options.samplers ?? ["random", "coverage", "stratified"];
  const trials: SamplerTrial[] = [];

  for (const sampler of names) {
    if (!SAMPLERS[sampler]) throw new Error(`unknown sampler "${sampler}"`);
    for (const budget of options.budgets) {
      const started = performance.now();
      const a = await runOne(sampler, options.seats, budget, "validation", options);
      const b = await runOne(sampler, options.seats, budget, "final", options);
      const runtimeMs = performance.now() - started;

      const fa = ffaOf(a, options.seats);
      const fb = ffaOf(b, options.seats);

      // Interval widths, averaged over kingdoms.
      const firstPlaceCi = mean(
        Object.values(fa.kingdoms).map((k) => uncertainty(k.placement.first)),
      );
      const lastPlaceCi = mean(
        Object.values(fa.kingdoms).map((k) => uncertainty(k.placement.last)),
      );

      // Pool-to-pool disagreement — the honest repeatability test.
      let poolDisagreement = 0;
      let poolDisagreementFirstPp = 0;
      for (const [id, ka] of Object.entries(fa.kingdoms)) {
        const kb = fb.kingdoms[id];
        if (!kb) continue;
        poolDisagreement = Math.max(
          poolDisagreement,
          Math.abs(ka.placement.average - kb.placement.average),
        );
        poolDisagreementFirstPp = Math.max(
          poolDisagreementFirstPp,
          Math.abs(ka.placement.first.rate - kb.placement.first.rate) * 100,
        );
      }

      // Seat bias: if rotation is working, a kingdom's mean placement should
      // not depend on which seat it occupied.
      const seatBias = mean(
        Object.values(fa.seats_).map((s) => {
          const occupied = s.meanPlacement.filter((_, i) => (s.appearances[i] ?? 0) > 0);
          return occupied.length > 1 ? Math.max(...occupied) - Math.min(...occupied) : 0;
        }),
      );

      const minutes = runtimeMs / 60_000;
      const trial: SamplerTrial = {
        sampler,
        samplerVersion: SAMPLERS[sampler]!.version,
        seats: options.seats,
        compositions: budget,
        matches: fa.matches + fb.matches,
        runtimeMs,
        matchesPerSecond: (fa.matches + fb.matches) / (runtimeMs / 1000),
        coverage: coverageQuality(fa.compositions as KingdomId[][], options.seats),
        firstPlaceCi: firstPlaceCi * 100,
        lastPlaceCi: lastPlaceCi * 100,
        poolDisagreement,
        poolDisagreementFirstPp,
        seatBias,
        // "Information" = precision achieved, discounted by disagreement between
        // pools, per minute spent. A tight interval that does not reproduce is
        // not information.
        informationPerMinute:
          minutes > 0
            ? 1 / ((firstPlaceCi * 100 + poolDisagreementFirstPp) * minutes)
            : 0,
      };
      trials.push(trial);
      options.onTrial?.(trial);
    }
  }
  return trials;
}

/** Renders the benchmark as a designer-readable table. */
export function benchmarkText(trials: SamplerTrial[]): string {
  const L: string[] = [];
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const num = (s: string | number, n: number) => String(s).padStart(n);

  L.push("=".repeat(104));
  L.push("FFA SAMPLER BENCHMARK");
  L.push("=".repeat(104));
  L.push(
    "  Judged on uncertainty removed per minute and on whether two disjoint seed pools agree —",
  );
  L.push("  not on how much of the composition space was touched.");
  L.push("");
  L.push(
    `  ${pad("sampler", 12)}${num("seats", 6)}${num("comps", 7)}${num("space%", 8)}` +
      `${num("appear", 8)}${num("pairs", 7)}${num("matches", 9)}${num("time", 8)}` +
      `${num("1stCI", 8)}${num("poolΔ", 8)}${num("seatΔ", 7)}${num("info/min", 10)}`,
  );
  L.push("  " + "-".repeat(100));
  for (const t of trials) {
    L.push(
      `  ${pad(t.sampler, 12)}${num(t.seats, 6)}${num(t.compositions, 7)}` +
        `${num((t.coverage.spaceFraction * 100).toFixed(1), 8)}` +
        `${num(`${t.coverage.min}-${t.coverage.max}`, 8)}` +
        `${num(`${t.coverage.pairsSeen}/${t.coverage.pairsPossible}`, 7)}` +
        `${num(t.matches, 9)}${num(`${(t.runtimeMs / 1000).toFixed(0)}s`, 8)}` +
        `${num(`${t.firstPlaceCi.toFixed(1)}pp`, 8)}` +
        `${num(`${t.poolDisagreementFirstPp.toFixed(1)}pp`, 8)}` +
        `${num(t.seatBias.toFixed(2), 7)}` +
        `${num(t.informationPerMinute.toFixed(4), 10)}`,
    );
  }
  L.push("");
  L.push("  space%  fraction of C(16,seats) touched      appear  min-max kingdom appearances");
  L.push("  pairs   distinct co-occurring kingdom pairs  1stCI   mean 95% CI width, first-place rate");
  L.push("  poolΔ   worst kingdom disagreement between disjoint seed pools");
  L.push("  seatΔ   mean spread in placement across seats (rotation should drive this to ~0)");
  L.push("  info/min  1 / ((1stCI + poolΔ) × minutes) — higher is better");
  return L.join("\n");
}
