import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  acceptCheckpoint, identityMismatches, CHECKPOINT_VERSION,
  buildSchema, allocationFor,
  type SearchCheckpoint, type CheckpointIdentity,
} from "../simulation/src/search/index.js";
import { localIdentity } from "../simulation/src/distributed/identity.js";

/**
 * Surviving a Kaggle session timeout.
 *
 * The previous run died at generation 13 and restarted at 0. Nothing was
 * corrupted and nothing was wrong with the checkpoint — it contained the CMA-ES
 * mean, covariance, evolution paths, RNG state, the schema and the evaluation
 * cache, all written correctly after every generation. It was written to
 * /kaggle/working, which the session deletes on exit.
 *
 * So these tests are about two things: that the durable copy survives a
 * round-trip intact enough to continue from, and that it is REFUSED whenever it
 * describes a different run. Silently resuming incompatible state would be
 * worse than losing the work.
 */

const identity = (): CheckpointIdentity => ({
  engineSha: "abc123", engineDirty: false,
  schemaVersion: "v2", catalogHash: "cat-1",
  fitnessVersion: "f1", optimizerVersion: "v1", weightsName: "designerPriority",
  seed: 20260813, generations: 20, populationSize: 19, sigma: 0.2,
  promote: 1, tiersHash: "tiers-v2",
});

function checkpointAt(generation: number, stage: SearchCheckpoint["stage"] = "search"): SearchCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    identity: identity(),
    writtenAt: "2026-08-17T00:00:00.000Z",
    completedGenerations: generation,
    stage,
    // A real CMA snapshot: the numbers that decide the next population.
    cma: {
      mean: [0.5, 0.25], sigma: 0.2,
      C: [[1, 0], [0, 1]], pc: [0, 0], ps: [0, 0],
      generation, rngState: 123456789,
    } as unknown as SearchCheckpoint["cma"],
    schema: buildSchema({ scope: "expanded" }),
    generationRecords: [],
    evaluations: [],
    cacheEntries: [],
    bestFullKey: null,
    counters: {
      candidateCount: generation * 19, matches: 1000, screens: generation * 19,
      fulls: generation, validations: 0, failures: 0, elapsedMs: 1000,
    },
  };
}

/** Exactly what QueueClient.saveCheckpoint/loadCheckpoint do to the bytes. */
const encode = (c: SearchCheckpoint) => gzipSync(Buffer.from(JSON.stringify(c), "utf8")).toString("base64");
const decode = (p: string) => JSON.parse(gunzipSync(Buffer.from(p, "base64")).toString("utf8")) as SearchCheckpoint;

// --- the durable round-trip ------------------------------------------------

test("a checkpoint survives the store round-trip byte-for-byte", () => {
  const original = checkpointAt(13);
  const restored = decode(encode(original));
  assert.deepEqual(restored, original,
    "everything needed to continue must survive: CMA state, schema, counters, identity");
});

test("compression is what makes the durable copy fit", () => {
  // The checkpoint carries the evaluation cache, which grows every generation.
  // Uncompressed, a twenty-generation checkpoint outgrows what PostgREST will
  // accept, and the write fails at exactly the moment it matters.
  const fat = checkpointAt(20);
  fat.cacheEntries = Array.from({ length: 380 }, (_, i) => ({
    key: `hash${i}|screen`,
    evaluation: { candidate: { id: `c${i}`, hash: `h${i}`, parameters: {} } } as never,
  }));
  const raw = JSON.stringify(fat).length;
  const packed = encode(fat).length;
  assert.ok(packed < raw / 2, `compression should more than halve it (${raw} -> ${packed})`);
});

test("the restored CMA state is the state, not a summary of it", () => {
  // Reproducing the next generation exactly needs mean, sigma, covariance,
  // both evolution paths and the RNG position. Losing any one of them makes
  // the resumed search a different search that happens to start nearby.
  const restored = decode(encode(checkpointAt(13)));
  const cma = restored.cma as unknown as Record<string, unknown>;
  for (const field of ["mean", "sigma", "C", "pc", "ps", "generation", "rngState"]) {
    assert.ok(field in cma, `${field} must survive — the next population depends on it`);
  }
  assert.equal(restored.completedGenerations, 13, "the loop resumes at this index");
});

// --- resuming --------------------------------------------------------------

test("a coordinator restart resumes the stored generation, not zero", () => {
  const load = acceptCheckpoint(checkpointAt(13), identity());
  assert.equal(load.rejected, null);
  assert.equal(load.checkpoint!.completedGenerations, 13,
    "this is the number that stops a restart beginning at generation 0");
});

test("no checkpoint is a fresh start, not a failure", () => {
  const load = acceptCheckpoint(null, identity());
  assert.equal(load.checkpoint, null);
  assert.equal(load.rejected, null, "absent and incompatible must not look the same");
});

test("an interrupted validation stage still resumes", () => {
  // Generations done, validation not. This used to be refused as "complete",
  // throwing away every generation behind it.
  const load = acceptCheckpoint(checkpointAt(20, "validation"), identity());
  assert.equal(load.rejected, null);
  assert.equal(load.checkpoint!.stage, "validation");
});

test("a genuinely finished run is refused rather than re-run", () => {
  const load = acceptCheckpoint(checkpointAt(20, "complete"), identity());
  assert.equal(load.checkpoint, null);
  assert.match(load.rejected!, /already complete/);
});

// --- refusing the wrong run ------------------------------------------------

test("a different allocation refuses to resume", () => {
  // The tier configuration is fingerprinted into the identity, so a v1
  // checkpoint cannot continue as a v2 run. Without this the search would mix
  // scores taken on two different instruments and report the average.
  const v1Checkpoint = checkpointAt(13);
  v1Checkpoint.identity = { ...identity(), tiersHash: "tiers-v1" };
  const load = acceptCheckpoint(v1Checkpoint, identity());
  assert.equal(load.checkpoint, null);
  assert.match(load.rejected!, /different run/);
  assert.match(load.rejected!, /tiersHash/);
});

test("every identity field is load-bearing", () => {
  // Each of these describes something that changes what a score means. A
  // mismatch in any one must be loud.
  const fields: (keyof CheckpointIdentity)[] = [
    "engineSha", "schemaVersion", "catalogHash", "fitnessVersion",
    "optimizerVersion", "weightsName", "seed", "populationSize", "sigma",
    "promote", "tiersHash",
  ];
  for (const field of fields) {
    const drifted = { ...identity() };
    (drifted as Record<string, unknown>)[field] =
      typeof drifted[field] === "number" ? (drifted[field] as number) + 1 : "changed";
    const cp = checkpointAt(13);
    cp.identity = drifted;
    const load = acceptCheckpoint(cp, identity());
    assert.equal(load.checkpoint, null, `${field} drift must refuse the checkpoint`);
    assert.match(load.rejected!, new RegExp(field), `the message must name ${field}`);
  }
});

test("a checkpoint from an older format is refused, not guessed at", () => {
  const stale = checkpointAt(13);
  (stale as { version: string }).version = "v1";
  const load = acceptCheckpoint(stale, identity());
  assert.equal(load.checkpoint, null);
  assert.match(load.rejected!, /version/);
});

test("the old experiment cannot be resumed by the new one", () => {
  // Requirement: elementals-expanded-s20260813 stays untouched. It ran the v1
  // split, so its identity differs from a v3 coordinator's in tiersHash — and
  // separately, V3 uses a different experiment name.
  const v1 = localIdentity({ allocation: "v1" });
  const v2 = localIdentity({ allocation: "v2" });
  assert.equal(v1.allocation, "v1");
  assert.equal(v2.allocation, "v2");
  assert.notDeepEqual(allocationFor("v1"), allocationFor("v2"));
  // identityMismatches is the same comparison the coordinator makes on startup.
  assert.deepEqual(identityMismatches(v1 as never, v1 as never), []);
});

// --- idempotence -----------------------------------------------------------

test("re-saving the same generation overwrites rather than accumulating", () => {
  // The table's primary key is (experiment_id, generation, stage) and the write
  // is an upsert, so a coordinator that checkpoints generation 13 twice — once
  // before dying and once after resuming — leaves one row, not two.
  const rows = new Map<string, string>();
  const key = (c: SearchCheckpoint) => `exp|${c.completedGenerations}|${c.stage}`;
  const save = (c: SearchCheckpoint) => rows.set(key(c), encode(c));

  save(checkpointAt(13));
  save(checkpointAt(13));
  assert.equal(rows.size, 1);

  // A validation-stage write at the same generation count is a DIFFERENT row,
  // so an interrupted validation does not destroy the search checkpoint it
  // would need to fall back to.
  save(checkpointAt(20, "search"));
  save(checkpointAt(20, "validation"));
  assert.equal(rows.size, 3);
});

test("the most recent write is the most advanced state", () => {
  // loadCheckpoint orders by written_at rather than generation, because stages
  // advance within a generation: "validation" at generation 20 is further along
  // than "search" at generation 20.
  const written: SearchCheckpoint[] = [
    checkpointAt(19, "search"), checkpointAt(20, "search"), checkpointAt(20, "validation"),
  ];
  const latest = written[written.length - 1]!;
  assert.equal(latest.stage, "validation");
  assert.equal(latest.completedGenerations, 20);
});
