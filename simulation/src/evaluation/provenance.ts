import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KINGDOM_IDS } from "../../../src/data/kingdoms.js";
import { listParameters } from "../../../src/engine/parameterCatalog.js";
import type { ParameterSet } from "../../../src/engine/parameters.js";
import { hashSeed } from "../rng.js";

/**
 * Provenance for a balance reading.
 *
 * A balance result is only valid for the engine that produced it. If an ability
 * changes while a search is in flight, the resulting configuration describes a
 * game that no longer exists — so every reading records the exact engine it was
 * taken against, and comparisons refuse to run across a mismatch rather than
 * silently averaging two different games.
 */

/** Bump when the evaluator's own output shape or method changes. */
export const EVALUATION_FORMAT_VERSION = 1;

export interface Provenance {
  formatVersion: number;
  /** Commit SHA of the engine this reading was taken against. */
  engineSha: string;
  /** True when the working tree had uncommitted changes — the SHA alone does
   *  not then identify the code that ran. */
  engineDirty: boolean;
  /** Fingerprint of the whole tunable space (id + base value), so a balance
   *  edit that never reached a commit is still detected. */
  balanceBaselineHash: string;
  /** Caller-supplied name for the configuration under test. */
  balanceConfigId: string;
  /** Fingerprint of the overrides themselves ("baseline" when there are none). */
  balanceConfigHash: string;
  strategyPopulationVersion: string;
  kingdomCount: number;
  createdAt: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // not a repo, or git unavailable — recorded as "unknown"
  }
}

/**
 * Engine identity for a VENDORED copy of the engine.
 *
 * When the simulator is exported into a standalone repository — for cloud
 * training, say — `git rev-parse HEAD` reports that repository's commit, which
 * is not the engine the reading was actually taken against. Left alone, every
 * cloud result would carry a different `engineSha` from the equivalent local
 * one, and `comparabilityProblem` would refuse to compare them: two readings of
 * the identical game, declared incomparable by their own provenance.
 *
 * The export records the upstream commit in `engine-source.json`, and that
 * value wins here. `ELEMENTALS_ENGINE_SHA` overrides both, for CI that builds
 * from a tarball with no git metadata at all.
 */
interface VendoredEngine {
  engineSha: string;
  engineDirty: boolean;
}

function vendoredEngine(): VendoredEngine | null {
  const fromEnv = process.env.ELEMENTALS_ENGINE_SHA?.trim();
  if (fromEnv) {
    return { engineSha: fromEnv, engineDirty: process.env.ELEMENTALS_ENGINE_DIRTY === "1" };
  }
  try {
    const file = fileURLToPath(new URL("../../engine-source.json", import.meta.url));
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<VendoredEngine>;
    if (typeof parsed.engineSha !== "string" || parsed.engineSha.length === 0) return null;
    return { engineSha: parsed.engineSha, engineDirty: parsed.engineDirty === true };
  } catch {
    // A malformed marker must not be treated as an identity — fall through to
    // git, and let the reading be stamped with whatever this repo really is.
    return null;
  }
}

/** Stable hash of a parameter set (order-independent). */
export function hashParameterSet(set: ParameterSet | null | undefined): string {
  if (!set) return "baseline";
  const entries = Object.entries(set).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "baseline";
  const text = entries.map(([k, v]) => `${k}=${v}`).join(";");
  return hashSeed(text).toString(16).padStart(8, "0");
}

/** Fingerprint of every tunable's production base value. */
export function hashBaseline(): string {
  const text = listParameters()
    .map((p) => `${p.id}=${p.base}`)
    .sort()
    .join(";");
  return hashSeed(text).toString(16).padStart(8, "0");
}

export function captureProvenance(options: {
  balanceConfigId: string;
  balance?: ParameterSet | null;
  strategyPopulationVersion: string;
  now?: () => string;
}): Provenance {
  const vendored = vendoredEngine();
  const sha = vendored ? vendored.engineSha : git(["rev-parse", "HEAD"]);
  const status = vendored ? null : git(["status", "--porcelain"]);
  return {
    formatVersion: EVALUATION_FORMAT_VERSION,
    engineSha: sha ?? "unknown",
    engineDirty: vendored ? vendored.engineDirty : status === null ? false : status.length > 0,
    balanceBaselineHash: hashBaseline(),
    balanceConfigId: options.balanceConfigId,
    balanceConfigHash: hashParameterSet(options.balance),
    strategyPopulationVersion: options.strategyPopulationVersion,
    kingdomCount: KINGDOM_IDS.length,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

/** Fields that must agree before two readings may be compared. `createdAt` and
 *  the config identity are deliberately excluded. */
export function comparabilityKey(p: Provenance): string {
  return [
    p.formatVersion,
    p.engineSha,
    p.balanceBaselineHash,
    p.strategyPopulationVersion,
    p.kingdomCount,
  ].join("|");
}

/** Why two readings cannot be compared, or null when they can. */
export function comparabilityProblem(
  baseline: Provenance,
  candidate: Provenance,
): string | null {
  if (comparabilityKey(baseline) === comparabilityKey(candidate)) return null;
  const diffs: string[] = [];
  if (baseline.formatVersion !== candidate.formatVersion) {
    diffs.push(`format ${baseline.formatVersion} vs ${candidate.formatVersion}`);
  }
  if (baseline.engineSha !== candidate.engineSha) {
    diffs.push(`engine ${short(baseline.engineSha)} vs ${short(candidate.engineSha)}`);
  }
  if (baseline.balanceBaselineHash !== candidate.balanceBaselineHash) {
    diffs.push("production balance data differs");
  }
  if (baseline.strategyPopulationVersion !== candidate.strategyPopulationVersion) {
    diffs.push(
      `population ${baseline.strategyPopulationVersion} vs ${candidate.strategyPopulationVersion}`,
    );
  }
  if (baseline.kingdomCount !== candidate.kingdomCount) {
    diffs.push(`${baseline.kingdomCount} vs ${candidate.kingdomCount} kingdoms`);
  }
  return diffs.join("; ");
}

const short = (sha: string) => (sha === "unknown" ? sha : sha.slice(0, 8));
