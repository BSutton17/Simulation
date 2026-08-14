import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture } from "./helpers/run.js";

const FIXTURE = "test/fixtures/printConfig.ts";

// Configuration loading is validated in isolated child processes because the
// config module resolves environment variables once, at import time.

test("loads development defaults when nothing is configured", async () => {
  const { code, stdout } = await runFixture(FIXTURE, {
    NODE_ENV: "development",
    PORT: undefined,
    HOST: undefined,
    CLIENT_ORIGIN: undefined,
    LOG_LEVEL: undefined,
  });

  assert.equal(code, 0);
  const cfg = JSON.parse(stdout);
  assert.equal(cfg.environment, "development");
  assert.equal(cfg.isDevelopment, true);
  assert.equal(cfg.isProduction, false);
  assert.equal(cfg.server.port, 3001);
  // Development defaults to the local Vite dev server origin (config/index.ts).
  assert.deepEqual(cfg.cors.origins, ["http://localhost:5173"]);
  assert.equal(cfg.logging.level, "debug");
  assert.equal(cfg.reconnect.graceMs, 60_000); // default 60s
});

test("reconnection grace is configurable via RECONNECT_GRACE_MS", async () => {
  const { code, stdout } = await runFixture(FIXTURE, {
    NODE_ENV: "development",
    RECONNECT_GRACE_MS: "5000",
  });
  assert.equal(code, 0);
  const cfg = JSON.parse(stdout);
  assert.equal(cfg.reconnect.graceMs, 5000);
});

test("production allows the deployed client origin by default when CLIENT_ORIGIN is unset", async () => {
  const { code, stdout, stderr } = await runFixture(FIXTURE, {
    NODE_ENV: "production",
    PORT: "8080",
    CLIENT_ORIGIN: undefined,
    LOG_LEVEL: undefined,
  });

  assert.equal(code, 0);
  const cfg = JSON.parse(stdout);
  assert.equal(cfg.environment, "production");
  assert.equal(cfg.isProduction, true);
  assert.equal(cfg.server.port, 8080);
  assert.deepEqual(cfg.cors.origins, ["https://elementals-game.netlify.app"]);
  assert.equal(cfg.logging.level, "info");
  assert.doesNotMatch(stdout + stderr, /No CLIENT_ORIGIN configured/);
});

test("honors explicit environment variables (port, origins, log level)", async () => {
  const { code, stdout } = await runFixture(FIXTURE, {
    NODE_ENV: "production",
    PORT: "9000",
    CLIENT_ORIGIN: "https://play.kingdoms.gg, https://beta.kingdoms.gg",
    LOG_LEVEL: "warn",
  });

  assert.equal(code, 0);
  const cfg = JSON.parse(stdout);
  assert.equal(cfg.server.port, 9000);
  assert.deepEqual(cfg.cors.origins, [
    "https://play.kingdoms.gg",
    "https://beta.kingdoms.gg",
  ]);
  assert.equal(cfg.logging.level, "warn");
});
