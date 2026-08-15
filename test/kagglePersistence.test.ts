import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Cross-session checkpoint persistence, run as part of the suite.
 *
 * The persistence layer is Python, because it drives the Kaggle CLI and runs
 * inside a Kaggle notebook. Its own integration test lives beside it and is
 * invoked here so `npm test` covers it too — a test that only runs when someone
 * remembers to run it is not a guard.
 *
 * That test drives the real store against an emulated Kaggle CLI: same
 * subcommands, same flags, same zip-on-upload and unzip-on-download. It
 * reproduces the failure that cost a production run — a session completing
 * generations and then being replaced — and checks the work comes back intact.
 *
 * It does NOT prove Kaggle's servers behave as emulated. Authentication,
 * quotas, dataset visibility and version propagation can only be verified on
 * Kaggle itself; README carries those manual steps.
 */

function python(): string | null {
  for (const candidate of ["python", "python3", "py"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test("checkpoints survive losing the Kaggle session", () => {
  assert.ok(existsSync("kaggle/test_checkpoint_store.py"), "the persistence test is missing");

  const interpreter = python();
  assert.ok(
    interpreter,
    "no Python interpreter found. The persistence layer is Python because it runs " +
      "inside a Kaggle notebook; without an interpreter this cannot be verified. " +
      "Install Python rather than skipping — the untested path is the one that " +
      "already lost a run.",
  );

  const result = spawnSync(interpreter, ["kaggle/test_checkpoint_store.py"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(
    result.status,
    0,
    `cross-session persistence failed:\n${output.split("\n").slice(-30).join("\n")}`,
  );

  // Assert on what it verified, not merely that it exited zero: a test file
  // that silently stopped running its scenarios would still exit zero.
  assert.match(output, /checkpoint recovered in a new session/);
  assert.match(output, /recovered byte-for-byte/);
  assert.match(output, /CMA-ES state preserved/);
  assert.match(output, /identity preserved: promote/);
  assert.match(output, /a stale checkpoint cannot overwrite newer work/);
  assert.match(output, /0 failed/);
});

test("no Kaggle credential is committed to the repository", () => {
  // The token belongs in Kaggle's secret store. A kaggle.json in the tree would
  // be published to GitHub the moment anyone pushed.
  assert.ok(!existsSync("kaggle.json"), "kaggle.json is in the repository root");
  assert.ok(!existsSync("kaggle/kaggle.json"), "kaggle.json is in the kaggle directory");

  const store = readFileSync("kaggle/checkpoint_store.py", "utf8");
  assert.ok(
    !/["'][0-9a-f]{32}["']/.test(store),
    "something that looks like an API key is hard-coded in the persistence layer",
  );
  assert.match(store, /kaggle_secrets|UserSecretsClient/, "credentials should come from Kaggle Secrets");
});
