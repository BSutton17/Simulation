import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

const PORT = "3203";
let server: RunningServer;

before(async () => {
  server = await startServer({ NODE_ENV: "development", PORT });
});

after(async () => {
  await server.stop();
});

function connect(): Socket {
  return io(`http://localhost:${PORT}`, { forceNew: true });
}

async function waitConnected(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

test("conn:identify assigns a session id when none is supplied", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const res = await socket.emitWithAck("conn:identify", {});
    assert.equal(res.ok, true);
    assert.ok(
      typeof res.data.sessionId === "string" && res.data.sessionId.length > 0,
    );
  } finally {
    socket.close();
  }
});

test("conn:identify restores a supplied session id", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const res = await socket.emitWithAck("conn:identify", {
      sessionId: "session-abc",
    });
    assert.equal(res.data.sessionId, "session-abc");
  } finally {
    socket.close();
  }
});

test("a player is identified by their session, not their socket", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    // Establish a known session, then host a match.
    await socket.emitWithAck("conn:identify", { sessionId: "session-xyz" });
    const created = await socket.emitWithAck("lobby:create", { name: "Alice" });

    // The player's id in the match is their session id.
    assert.equal(created.data.playerId, "session-xyz");
    assert.equal(created.data.match.players[0].id, "session-xyz");
  } finally {
    socket.close();
  }
});
