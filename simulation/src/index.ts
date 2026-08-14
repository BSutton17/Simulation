/**
 * Kingdoms simulation framework — public API (ticket #201).
 *
 * An internal balancing tool: runs complete headless matches through the
 * production gameplay engine (no networking, rendering, or timers), drives
 * players with metadata-driven AI controllers, and exposes observer hooks for
 * analytics, optimization, and reporting. See ../README.md for architecture.
 */

export { runSimulation } from "./runner.js";
export {
  createHeadlessMatch,
  runHeadlessMatch,
  DEFAULT_MAX_TICKS,
} from "./headless.js";
export { createBaselineAI } from "./ai.js";
// AI decision framework (ticket #205) + personalities (ticket #206).
export {
  PersonalityAI,
  personalityAI,
  type PersonalityProfile,
  type TargetingStrategy,
} from "./personality.js";
export {
  AGGRESSIVE,
  BALANCED,
  DEFENSIVE,
  ECONOMIC,
  OPPORTUNISTIC,
  PERSONALITIES,
  RANDOM,
  type PersonalityName,
} from "./personalities.js";
export { mulberry32, hashSeed, normalizeSeed, deriveSeed, type Rng } from "./rng.js";
// Balance parameters (ticket #202) — re-exported so simulation consumers
// (optimizers, reports) never import engine internals directly.
export {
  param,
  setActiveParameterSet,
  getActiveParameterSet,
  withParameterSet,
  type ParameterSet,
} from "../../src/engine/parameters.js";
export {
  listParameters,
  type ParameterDescriptor,
} from "../../src/engine/parameterCatalog.js";
// Gameplay events (ticket #204) — the engine publishes, consumers subscribe.
export {
  EventBus,
  type GameplayEvent,
  type GameplayEventListener,
} from "../../src/engine/events.js";
// Analytics framework (ticket #207).
export {
  AnalyticsCollector,
  usageByKind,
  type BatchAnalytics,
  type KingdomStats,
} from "./analytics.js";
// Telemetry Foundation (Part 1): full per-match "what happened?" recording.
export {
  TelemetryCollector,
  SAMPLE_INTERVAL_TICKS,
  type MatchTelemetry,
  type SeatTelemetry,
  type DamageTelemetry,
  type HealingTelemetry,
  type EconomyTelemetry,
  type AbilityUsageTelemetry,
  type CombatTelemetry,
  type PassiveContribution,
  type TimelineTelemetry,
  type StatusEffectivenessTelemetry,
} from "./telemetry.js";
// Analytics engine (Part 2): telemetry → balance insight.
export {
  abilityMetrics,
  kingdomMetrics,
  passiveMetrics,
  statusMetrics,
  matchTimelines,
  explainMatch,
  telemetryOf,
  type AbilityMetrics,
  type KingdomMetrics,
  type PassiveMetrics,
  type StatusMetrics,
  type MatchTimelines,
  type Share,
} from "./metrics.js";
// Intelligent Balance Assistant (Part 4): rule-based recommendations.
export {
  diagnose,
  diagnoseRecords,
  renderConcerns,
  type BalanceDiagnostics,
  type BalanceConcern,
  type ConcernCategory,
  type ConcernSeverity,
  type DiagnoseOptions,
} from "./diagnostics.js";
// Reporting suite + source locator (ticket #210).
export {
  buildReport,
  simulateAndReport,
  runMatchupMatrix,
  renderText,
  renderHtml,
  toJson,
  toCsv,
  saveRun,
  listRuns,
  type BalanceReport,
  type KingdomReportRow,
  type MatchupMatrix,
  type Recommendation,
} from "./report.js";
export {
  locateParameter,
  clearLocatorCache,
  type SourceLocation,
} from "./sourceLocator.js";
// Automated balance optimizer (tickets #208–#209).
export {
  optimize,
  balanceObjective,
  matchDurationObjective,
  matrixParityScore,
  type OptimizationAlgorithm,
  type OptimizationConstraints,
  type OptimizationObjective,
  type OptimizationResult,
  type OptimizerConfig,
  type OptimizerIteration,
  type IterationMetrics,
  type ParameterChange,
  type ParameterConstraint,
} from "./optimizer.js";
export { describeParameter } from "./paramLabels.js";
export type {
  AIContext,
  AIController,
  AIFactory,
  MatchRecord,
  PlayerOutcome,
  PlayerSpec,
  SimulationConfig,
  SimulationObserver,
  SimulationResult,
} from "./types.js";
