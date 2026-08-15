import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The two Kaggle launchers, held to their stated purpose.
 *
 * `kaggle_notebook.py` starts an eight-hour training run; `kaggle_smoke.py`
 * proves the pipeline executes and nothing more. Keeping them as separate files
 * rather than one file with a mode flag means neither can be started by
 * accident — but it also means the production configuration can be edited while
 * every other check stays green, and a wrong number there costs eight hours and
 * a result nobody can compare to anything.
 *
 * These are cheap string assertions over the two scripts. They are not a
 * substitute for reading them; they are a tripwire for the specific values that
 * must not drift.
 */

const production = readFileSync("kaggle/kaggle_notebook.py", "utf8");
const smoke = readFileSync("kaggle/kaggle_smoke.py", "utf8");

/** Reads a `NAME = value` assignment from a Python source file. */
function setting(source: string, name: string): string {
  const m = new RegExp(`^${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, "m").exec(source);
  assert.ok(m, `could not find ${name} in the runner`);
  return m[1]!.trim();
}

test("the production launcher keeps its real training configuration", () => {
  // The first production experiment, settled by the planning analysis and
  // approved 2026-08-14. If a change here is deliberate, update this test in
  // the same commit and say why.
  //
  // 20 generations rather than 40: double the ten that produced a rising mean
  // previously, and a run that finishes rather than one that runs out of
  // sessions. promote 1 rather than 3: cma.tell runs on the whole population's
  // screening scores before anything is promoted, so promote does not steer
  // the search — proven in test/promoteTrajectory.test.ts — and 3 spent 57% of
  // each generation on bookkeeping.
  assert.equal(setting(production, "GENERATIONS"), "20");
  assert.equal(setting(production, "POPULATION"), "8");
  assert.equal(setting(production, "SIGMA"), "0.2");
  assert.equal(setting(production, "SEED"), "20260813");
  assert.equal(setting(production, "PROMOTE"), "1");
  assert.equal(setting(production, "VALIDATE"), "1");
  // The budget is checked only BETWEEN generations, so a generation starting
  // just under it overruns. 7.0 leaves room for that on a 9-hour session.
  assert.equal(setting(production, "HOURS"), "7.0");
  // Measured on the Kaggle machine: 2 workers beat 3 and 4, outcomes identical.
  assert.equal(setting(production, "WORKERS"), "2");
});

test("the production launcher can run unattended in a batch session", () => {
  // "Save & Run All" executes the notebook on Kaggle's servers with no browser
  // attached and no stdin. Anything that waits for a human hangs until the
  // session times out, having produced nothing.
  assert.ok(
    !/\binput\s*\(/.test(production),
    "the launcher prompts for input, which would hang a batch session forever",
  );
  assert.ok(!/getpass|sys\.stdin/.test(production), "the launcher reads from stdin");

  // An unattended run without persistence is the worst case: hours of compute,
  // nobody watching, nothing recoverable. It must refuse to start.
  assert.match(production, /REQUIRE_PERSISTENCE/, "no guard against running unprotected");

  // The username must be settable, because a batch session has nobody to ask.
  assert.match(production, /^USERNAME\s*=/m, "the username cannot be set explicitly");

  // The final push happens in a finally block, so it runs even if the search
  // raises — otherwise a crash would discard the generations before it.
  const finallyAt = production.indexOf("finally:");
  const stopAt = production.indexOf("mirror.stop()");
  assert.ok(finallyAt > 0 && stopAt > finallyAt, "the final push is not in a finally block");
});

test("the production launcher mirrors its checkpoint off the session", () => {
  // The failure this exists to prevent: /kaggle/working belongs to a session,
  // and a completed generation was lost when the session was replaced.
  assert.match(production, /import checkpoint_store/, "the launcher does not use the checkpoint store");
  assert.match(production, /pull_latest/, "the launcher never restores a stored checkpoint");
  assert.match(production, /push_if_newer/, "the launcher never publishes its checkpoint");

  // Pushing only at the end would protect against nothing, because the end is
  // what a lost session never reaches.
  assert.match(production, /threading\.Thread/, "the checkpoint is not mirrored while the search runs");

  // A failed push must not end the run.
  assert.match(production, /push failed/, "a push failure is not handled");
});

test("the smoke test stays small enough to be worth running", () => {
  const generations = Number(setting(smoke, "GENERATIONS"));
  const population = Number(setting(smoke, "POPULATION"));
  assert.ok(generations <= 2, `smoke generations crept up to ${generations}`);
  assert.ok(population <= 4, `smoke population crept up to ${population}`);

  // Validation is 21,816 matches per evaluation and runs for both the baseline
  // and the elite. Enabling it would turn a 30-minute check into a multi-hour
  // one while proving nothing the rest of the path has not already proven.
  assert.equal(setting(smoke, "VALIDATE"), "0", "the smoke test must not run the validation tier");

  // candidate.json is only written when something reached a full evaluation.
  assert.ok(Number(setting(smoke, "PROMOTE")) >= 1, "promote 0 would produce no candidate at all");
});

test("the smoke test searches the same way, just less of it", () => {
  // A smoke test on a different sigma or seed would exercise a different search
  // and tell us less than it appears to.
  assert.equal(setting(smoke, "SIGMA"), setting(production, "SIGMA"));
  assert.equal(setting(smoke, "SEED"), setting(production, "SEED"));
});

test("both launchers drive the one CLI, not a second optimizer", () => {
  for (const [name, source] of [["production", production], ["smoke", smoke]] as const) {
    // The compiled entry point, not the TypeScript source: running through tsx
    // measured 1.45x slower for byte-identical outcomes, because tsx injects a
    // __name helper per transpiled function that profiled at 13% of runtime.
    assert.match(
      source,
      /dist\/simulation\/src\/kaggleSearch\.js/,
      `${name} does not call the compiled search CLI`,
    );
    assert.ok(
      !/optimize|hillClimb|annealing|genetic/.test(source),
      `${name} appears to reach for a second optimizer`,
    );
  }
});

test("both launchers compile the TypeScript before running it", () => {
  // Running the compiled entry without compiling first fails with a missing
  // module, an hour into a queued session.
  //
  // Only the presence of the build step is asserted, not its position. The
  // smoke launcher defines its search() helper above main(), so textual order
  // says nothing about execution order — an ordering assertion here failed on a
  // file that was in fact correct. Verifying real call order needs to parse
  // Python, which is a worse trade than checking the step exists at all.
  for (const [name, source] of [["production", production], ["smoke", smoke]] as const) {
    assert.match(source, /"npm", "run", "build"/, `${name} never builds the TypeScript`);
  }
});

test("the smoke test writes somewhere the real run does not", () => {
  // Sharing an output directory would let a smoke checkpoint be resumed by the
  // real run, or the reverse — and the identity guard would reject it loudly at
  // best, or silently waste a session at worst.
  assert.notEqual(setting(smoke, "OUT"), setting(production, "OUT"));
});

test("neither launcher claims the project needs an API it no longer uses", () => {
  // fs.globSync was removed for Node 20 compatibility. A stale error message
  // naming it would send the next reader looking for a dependency that is gone.
  for (const [name, source] of [["production", production], ["smoke", smoke]] as const) {
    assert.ok(!source.includes("globSync"), `${name} still mentions fs.globSync`);
  }
});

test("both launchers refuse a Node older than the deployment target", () => {
  for (const [name, source] of [["production", production], ["smoke", smoke]] as const) {
    assert.match(source, /major\s*<\s*20/, `${name} does not check the Node version`);
  }
});
