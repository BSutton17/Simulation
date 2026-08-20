import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_VERSION,
  CandidateCache,
  buildSchema,
  cacheKeyOf,
  identityMismatches,
  makeCandidate,
  readCheckpoint,
  writeCheckpoint,
  baseVector,
  type CheckpointIdentity,
  type CandidateEvaluation,
  type SearchCheckpoint,
} from "../simulation/src/search/index.js";
import { Cmaes } from "../simulation/src/search/index.js";
import { FITNESS_VERSION } from "../simulation/src/fitness/index.js";

/**
 * Checkpointing exists so that an interruption costs one generation instead of
 * an entire multi-hour run. The properties worth testing are therefore about
 * REFUSAL as much as about round-tripping: a checkpoint that resumes when it
 * should not is worse than one that fails to resume at all, because the damage
 * is silent.
 */

const IDENTITY: CheckpointIdentity = {
  engineSha: "abc123",
  engineDirty: false,
  schemaVersion: "v1",
  catalogHash: "deadbeef",
  fitnessVersion: FITNESS_VERSION,
  optimizerVersion: "v1",
  weightsName: "designerPriority",
  seed: 42,
  generations: 10,
  populationSize: 8,
  sigma: 0.2,
  promote: 3,
  tiersHash: "cafe0000",
};

function sampleCheckpoint(overrides: Partial<SearchCheckpoint> = {}): SearchCheckpoint {
  const schema = buildSchema();
  const cma = new Cmaes({
    dimension: baseVector(schema).length,
    mean: baseVector(schema),
    sigma: 0.2,
    populationSize: 8,
    seed: 42,
  });
  cma.tell(cma.ask(), Array.from({ length: 8 }, (_, i) => i / 8));
  return {
    version: CHECKPOINT_VERSION,
    identity: IDENTITY,
    writtenAt: "2026-08-13T00:00:00.000Z",
    completedGenerations: 3,
    stage: "search",
    cma: cma.snapshot(),
    schema,
    generationRecords: [],
    evaluations: [],
    cacheEntries: [],
    bestFullKey: null,
    counters: {
      candidateCount: 24, matches: 1000, screens: 24, fulls: 3,
      validations: 0, failures: 0, elapsedMs: 12345,
    },
    ...overrides,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a checkpoint round-trips and resumes at the right generation", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const written = sampleCheckpoint();
    writeCheckpoint(path, written);

    const { checkpoint, rejected } = readCheckpoint(path, IDENTITY);
    assert.equal(rejected, null);
    assert.ok(checkpoint);
    assert.equal(checkpoint.completedGenerations, 3);
    assert.deepEqual(checkpoint.cma.mean, written.cma.mean);
    assert.equal(checkpoint.cma.generation, written.cma.generation);
    assert.equal(checkpoint.counters.matches, 1000);
  });
});

test("a missing checkpoint is not an error and not a rejection", () => {
  withTempDir((dir) => {
    const { checkpoint, rejected } = readCheckpoint(join(dir, "absent.json"), IDENTITY);
    assert.equal(checkpoint, null);
    assert.equal(rejected, null, "an absent checkpoint is a normal fresh start");
  });
});

test("a corrupt checkpoint is reported, never silently ignored", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeFileSync(path, "{ this is not json", "utf8");
    const { checkpoint, rejected } = readCheckpoint(path, IDENTITY);
    assert.equal(checkpoint, null);
    assert.match(rejected ?? "", /unreadable/);
  });
});

test("resume is refused across every identity field that could change a score", () => {
  const changes: [keyof CheckpointIdentity, unknown][] = [
    ["engineSha", "other999"],
    ["engineDirty", true],
    ["catalogHash", "11112222"],
    // Sentinel values rather than "v2": the real versions move, and pinning a
    // plausible next value made this a no-op the moment FITNESS_VERSION became
    // v2 — the mutation matched the identity and nothing was refused, which
    // looked exactly like a broken guard.
    ["fitnessVersion", "changed-fitness"],
    ["schemaVersion", "changed-schema"],
    ["optimizerVersion", "changed-optimizer"],
    ["weightsName", "equal"],
    ["seed", 43],
    ["populationSize", 12],
    ["sigma", 0.3],
    ["promote", 1],
    ["tiersHash", "99998888"],
  ];
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeCheckpoint(path, sampleCheckpoint());
    for (const [field, value] of changes) {
      const mutated = { ...IDENTITY, [field]: value } as CheckpointIdentity;
      const { checkpoint, rejected } = readCheckpoint(path, mutated);
      assert.equal(checkpoint, null, `resumed despite a changed ${field}`);
      assert.match(rejected ?? "", new RegExp(field), `rejection did not name ${field}`);
    }
  });
});

test("a longer run may resume a shorter checkpoint", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeCheckpoint(path, sampleCheckpoint());
    // Extending a run is legitimate: the completed generations are still valid.
    const { checkpoint, rejected } = readCheckpoint(path, { ...IDENTITY, generations: 20 });
    assert.equal(rejected, null);
    assert.ok(checkpoint);
  });
});

test("a finished checkpoint does not resume into a no-op run", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage: "complete" }));
    const { checkpoint, rejected } = readCheckpoint(path, IDENTITY);
    assert.equal(checkpoint, null);
    assert.match(rejected ?? "", /already complete/);
  });
});

/**
 * `promote` in the identity.
 *
 * It provably does not steer the search — `cma.tell` runs on the whole
 * population's screening scores before anything is promoted, proven in
 * test/promoteTrajectory.test.ts. It is fingerprinted for a different reason:
 * it decides how many candidates are ever measured at full depth. Changing it
 * mid-run leaves some generations with three fully-evaluated candidates and
 * others with one, the elite is drawn from uneven coverage, and nothing in the
 * run's own record would show it happened.
 */
test("a checkpoint will not resume under a different promote", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeCheckpoint(path, sampleCheckpoint()); // promote 3

    for (const promote of [1, 2, 5]) {
      const { checkpoint, rejected } = readCheckpoint(path, { ...IDENTITY, promote });
      assert.equal(checkpoint, null, `resumed a promote-3 checkpoint under promote ${promote}`);
      assert.match(rejected ?? "", /promote/, "the rejection should name promote");
    }

    // The same value still resumes.
    assert.ok(readCheckpoint(path, IDENTITY).checkpoint, "an unchanged promote must still resume");
  });
});

/**
 * Finishing the last generation is not finishing the run.
 *
 * Validation costs 43,632 matches — one to two hours. Before this, a session
 * killed inside that stage left a checkpoint refused as "already complete" on
 * the next attempt: the generations were intact on disk and unreachable, and
 * the only way forward was to run the whole search again.
 */
test("search complete with validation pending is resumable", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    // Every generation done, validation not finished.
    writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage: "validation" }));

    const { checkpoint, rejected } = readCheckpoint(path, IDENTITY);
    assert.equal(rejected, null, "an unvalidated run must not be refused");
    assert.ok(checkpoint, "the checkpoint should load so validation can be retried");
    assert.equal(checkpoint.completedGenerations, 10);
    assert.equal(checkpoint.stage, "validation");
  });
});

test("a run is complete only once validation has produced its results", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");

    // Same generation count, but validation finished: nothing left to do.
    writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage: "complete" }));
    const done = readCheckpoint(path, IDENTITY);
    assert.equal(done.checkpoint, null);
    assert.match(done.rejected ?? "", /already complete \(search and validation\)/);

    // The distinction is the stage alone — identical generation counts.
    writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage: "validation" }));
    assert.ok(readCheckpoint(path, IDENTITY).checkpoint, "stage is what separates done from pending");
  });
});

test("a completed run still resumes when more generations are asked for", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage: "complete" }));

    // Extending a finished search is legitimate — the work behind it is valid,
    // and refusing would force a rerun of everything to add one generation.
    const { checkpoint, rejected } = readCheckpoint(path, { ...IDENTITY, generations: 15 });
    assert.equal(rejected, null);
    assert.ok(checkpoint);
    assert.equal(checkpoint.completedGenerations, 10);
  });
});

test("the three stages are distinguishable and only one ends the run", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const resumable: Record<string, boolean> = {};
    for (const stage of ["search", "validation", "complete"] as const) {
      writeCheckpoint(path, sampleCheckpoint({ completedGenerations: 10, stage }));
      resumable[stage] = readCheckpoint(path, IDENTITY).checkpoint !== null;
    }
    assert.deepEqual(resumable, { search: true, validation: true, complete: false });
  });
});

test("checkpoint writes are atomic — no temp file survives", () => {
  withTempDir((dir) => {
    const path = join(dir, "nested", "deep", "run.json");
    writeCheckpoint(path, sampleCheckpoint());
    // mkdir -p behaviour, and the temp file must have been renamed away.
    assert.ok(readFileSync(path, "utf8").length > 0);
    assert.throws(() => readFileSync(`${path}.tmp`, "utf8"));
  });
});

test("identityMismatches names each differing field", () => {
  const diffs = identityMismatches({ ...IDENTITY, seed: 1, sigma: 0.5 }, IDENTITY);
  assert.equal(diffs.length, 2);
  assert.ok(diffs.some((d) => d.startsWith("seed")));
  assert.ok(diffs.some((d) => d.startsWith("sigma")));
});

test("a restored cache serves hits under the current context only", () => {
  const schema = buildSchema();
  const context = {
    engineSha: "abc123",
    fitnessVersion: FITNESS_VERSION,
    schemaVersion: schema.version,
    seedPool: "training",
    samplerVersions: "coverage/stratified",
  };
  const candidate = makeCandidate({
    schema,
    vector: baseVector(schema),
    parameters: { "shield.cost": 300 },
    generation: 0,
    index: 0,
    optimizer: "cmaes",
  });
  const evaluation: CandidateEvaluation = {
    candidate,
    tier: "screen",
    fitness: null,
    failure: null,
    durationMs: 1,
    cached: false,
  };

  const source = new CandidateCache(context);
  source.set(evaluation);
  const dumped = source.dump();
  assert.equal(dumped.length, 1);

  // Same context: the entry is reusable.
  const same = new CandidateCache(context);
  assert.equal(same.load(dumped), 1);
  assert.ok(same.get(candidate.hash, "screen"), "a valid cached score should be reused");

  // Different engine: the SAME dump must not produce a hit, because keys are
  // rebuilt from the live context rather than trusted from the checkpoint.
  const other = new CandidateCache({ ...context, engineSha: "different" });
  other.load(dumped);
  assert.equal(
    other.get(candidate.hash, "screen"),
    undefined,
    "a score from another engine must never be served from a restored cache",
  );
});

test("cacheKeyOf is stable and tier-specific", () => {
  assert.equal(cacheKeyOf("abcd1234", "screen"), "abcd1234|screen");
  assert.notEqual(cacheKeyOf("abcd1234", "screen"), cacheKeyOf("abcd1234", "full"));
});
