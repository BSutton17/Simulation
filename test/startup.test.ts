import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// End-to-end: boot the real server and drive it with a real Socket.IO client to
// validate startup and client-server communication together.

const PORT = "3199";
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT });
});

after(async () => {
  await server.stop();
});

test("server starts up and reports it is listening", () => {
  assert.match(server.output(), /Server listening/);
});

test("a client can connect and receive a socket id", async () => {
  const socket: Socket = io(`http://localhost:${PORT}`);
  try {
    const id = await new Promise<string>((resolve, reject) => {
      socket.on("connect", () => resolve(socket.id ?? ""));
      socket.on("connect_error", (err) => reject(err));
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
    assert.ok(id.length > 0, "client should receive a non-empty socket id");
  } finally {
    socket.close();
  }

  // Give the server a moment to log the connection lifecycle.
  await new Promise((r) => setTimeout(r, 300));
  assert.match(server.output(), /Client connected/);
});
