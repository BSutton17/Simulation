import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture } from "./helpers/run.js";

// The global error handlers must keep the process alive after both an unhandled
// rejection and an uncaught exception, logging each instead of crashing.

test("server survives unhandled rejection and uncaught exception", async () => {
  const { code, stdout, stderr } = await runFixture("test/fixtures/triggerErrors.ts", {
    LOG_LEVEL: "error",
  });

  assert.equal(code, 0, "process should stay alive and exit cleanly (code 0)");
  assert.match(stdout, /STILL_ALIVE/);

  const combined = stdout + stderr;
  assert.match(combined, /Unhandled promise rejection/);
  assert.match(combined, /Uncaught exception/);
});
