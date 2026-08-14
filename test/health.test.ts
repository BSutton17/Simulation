import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "./helpers/server.js";

// Health check endpoint (#14): confirms the server is online and accepting
// requests, and that unknown routes are rejected.

const PORT = "3200";
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT });
});

after(async () => {
  await server.stop();
});

test("GET /health returns 200 with an ok JSON status", async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = (await res.json()) as { status: string; uptime: number };
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptime, "number");
});

test("unknown routes return 404", async () => {
  const res = await fetch(`http://localhost:${PORT}/does-not-exist`);
  assert.equal(res.status, 404);
});
