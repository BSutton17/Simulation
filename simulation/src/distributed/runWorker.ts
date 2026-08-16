import { QueueClient } from "./client.js";
import { runWorker, assertWorkerMatches } from "./worker.js";
import { localIdentity } from "./identity.js";

/**
 * Worker entry point.
 *
 *   node dist/simulation/src/distributed/runWorker.js \
 *     --experiment <uuid> [--workers 2] [--hours 10.5]
 *
 * Claims candidates, evaluates them, submits results, repeats. Knows nothing
 * about CMA-ES and does not need to.
 */

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};

const experimentId = arg("experiment");
if (!experimentId) {
  console.error("--experiment <uuid> is required (the coordinator prints it on startup)");
  process.exit(1);
}

const workers = Number(arg("workers", "2"));
const hours = Number(arg("hours", "10.5"));

const started = Date.now();
const stamp = () => `[${((Date.now() - started) / 60000).toFixed(1)}m]`;
const log = (line: string) => console.log(`${stamp()} ${line}`);

const client = new QueueClient({ role: "worker" });

// Refuse before doing any work rather than after. An out-of-date worker
// produces plausible numbers for a slightly different game, and the search
// would absorb them without complaint.
await assertWorkerMatches(client, experimentId, localIdentity());
log("build matches the experiment");

const summary = await runWorker({
  client,
  experimentId,
  workers,
  budgetMs: hours * 3_600_000,
  onLog: log,
});

log(
  `done — ${summary.completed} completed, ${summary.failed} failed, ` +
    `${summary.duplicates} discarded as duplicates, ` +
    `${(summary.elapsedMs / 3_600_000).toFixed(1)}h`,
);
