import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// Uses a short reconnection grace so the removal path is observable quickly.

const PORT = "3202";
const GRACE_MS = 300;
let server: RunningServer;

before(async () => {
  server = await startServer({
    NODE_ENV: "development",
    PORT,
    RECONNECT_GRACE_MS: String(GRACE_MS),
  });
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

test("a disconnect marks the player offline, then removes them after grace", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });
    const joinerId = joined.data.playerId;

    // First the host should see the player marked disconnected (grace begins)...
    const disconnected = new Promise<{
      players: { id: string; connected: boolean }[];
      playerCount: number;
    }>((resolve) => {
      const handler = (payload: {
        match: {
          players: { id: string; connected: boolean }[];
          playerCount: number;
        };
      }) => {
        const p = payload.match.players.find((pl) => pl.id === joinerId);
        if (p && p.connected === false) {
          host.off("lobby:updated", handler);
          resolve(payload.match);
        }
      };
      host.on("lobby:updated", handler);
    });
    // ...then, after the grace period, be removed with reason "disconnected".
    const removed = new Promise<{ playerId: string; reason: string }>((resolve) =>
      host.on("lobby:playerLeft", resolve),
    );
    // Canonical state broadcast reflecting the removal (playerCount back to 1).
    const removedState = new Promise<{ playerCount: number }>((resolve) => {
      const handler = (payload: { match: { playerCount: number } }) => {
        if (payload.match.playerCount === 1) {
          host.off("lobby:updated", handler);
          resolve(payload.match);
        }
      };
      host.on("lobby:updated", handler);
    });

    joiner.close(); // unexpected disconnect

    const match = await disconnected;
    const bob = match.players.find((p) => p.id === joinerId);
    assert.equal(bob?.connected, false, "player should be marked disconnected");
    // Slot stays reserved during the grace window (still counted).
    assert.equal(match.playerCount, 2, "slot should remain reserved");

    const gone = await removed;
    assert.equal(gone.playerId, joinerId);
    assert.equal(gone.reason, "disconnected");
    assert.equal((await removedState).playerCount, 1);

    // Removal is permanent: reconnecting with that session now fails.
    const late = connect();
    try {
      await waitConnected(late);
      const res = await late.emitWithAck("room:reconnect", {
        sessionId: joinerId,
        roomCode,
      });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "SESSION_NOT_IN_ROOM");
    } finally {
      late.close();
    }
  } finally {
    host.close();
    joiner.close();
  }
});

test("reconnecting within the grace period keeps the seat", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });
    const joinerId = joined.data.playerId;

    // Watch for an erroneous removal.
    let removed = false;
    host.on("lobby:playerLeft", () => {
      removed = true;
    });

    joiner.close();

    // Reconnect quickly (well within the grace window).
    const reconnect = connect();
    try {
      await waitConnected(reconnect);
      const res = await reconnect.emitWithAck("room:reconnect", {
        sessionId: joinerId,
        roomCode,
      });
      assert.equal(res.ok, true);
      assert.equal(res.data.reconnected, true);

      // Wait past the original grace window; no removal should occur.
      await new Promise((r) => setTimeout(r, GRACE_MS + 200));
      assert.equal(removed, false);
      assert.equal(res.data.match.playerCount, 2);
    } finally {
      reconnect.close();
    }
  } finally {
    host.close();
    joiner.close();
  }
});
