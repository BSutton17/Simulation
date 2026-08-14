import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// Stress / robustness tests: many concurrent clients, rapid churn, reconnects,
// duplicate requests, and invalid input. The server must stay consistent and
// never crash.

const PORT = "3204";
let server: RunningServer;

before(async () => {
  // Short grace so reconnect churn is observable without long waits.
  server = await startServer({
    NODE_ENV: "development",
    PORT,
    RECONNECT_GRACE_MS: "500",
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

/** Waits until the given player is reported disconnected in the host's view. */
function waitDisconnected(
  host: Socket,
  playerId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const handler = (payload: {
      match: { players: { id: string; connected: boolean }[] };
    }) => {
      const p = payload.match.players.find((pl) => pl.id === playerId);
      if (p && !p.connected) {
        host.off("lobby:updated", handler);
        resolve()
      }
    };
    host.on("lobby:updated", handler);
  });
}

test("maximum lobby size holds under a burst of concurrent joins", async () => {
  const host = connect();
  const extras: Socket[] = [];
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Host" });
    const roomCode = created.data.roomCode;

    // 15 clients all try to join at once; only 7 more seats exist (cap 8).
    const results = await Promise.all(
      Array.from({ length: 15 }, async (_, i) => {
        const s = connect();
        extras.push(s);
        await waitConnected(s);
        return s.emitWithAck("lobby:join", { name: `P${i}`, roomCode });
      }),
    );

    const ok = results.filter((r) => r.ok).length;
    const full = results.filter((r) => !r.ok && r.error.code === "ROOM_FULL").length;
    assert.equal(ok, 7, "exactly seven additional players should be seated");
    assert.equal(full, 8, "the rest should be rejected as ROOM_FULL");
  } finally {
    host.close();
    extras.forEach((s) => s.close());
  }
});

test("rapid joins and leaves leave the room consistent", async () => {
  const host = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Host" });
    const roomCode = created.data.roomCode;

    // Many clients join then immediately leave.
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const s = connect();
        try {
          await waitConnected(s);
          await s.emitWithAck("lobby:join", { name: `Churn${i}`, roomCode });
          await s.emitWithAck("lobby:leave", {});
        } finally {
          s.close();
        }
      }),
    );

    // Only the host should remain; a fresh join sees exactly two players.
    const checker = connect();
    try {
      await waitConnected(checker);
      const res = await checker.emitWithAck("lobby:join", { name: "Checker", roomCode });
      assert.equal(res.ok, true);
      assert.equal(res.data.match.playerCount, 2);
    } finally {
      checker.close();
    }
  } finally {
    host.close();
  }
});

test("repeated disconnect/reconnect keeps the player's seat", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Host" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });
    const sessionId = joined.data.playerId;

    let socket = joiner;
    for (let cycle = 0; cycle < 3; cycle++) {
      const disconnected = waitDisconnected(host, sessionId);
      socket.close();
      await disconnected; // ensure the server marked them offline

      socket = connect();
      await waitConnected(socket);
      const res = await socket.emitWithAck("room:reconnect", { sessionId, roomCode });
      assert.equal(res.ok, true, `reconnect cycle ${cycle} should succeed`);
      assert.equal(res.data.match.playerCount, 2);
    }
    socket.close();
  } finally {
    host.close();
    joiner.close();
  }
});

test("duplicate create/join requests are rejected, not double-applied", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const created = await socket.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    // Fire several duplicate create + join requests on the same socket.
    const dupes = await Promise.all([
      socket.emitWithAck("lobby:create", { name: "Alice" }),
      socket.emitWithAck("lobby:create", { name: "Alice" }),
      socket.emitWithAck("lobby:join", { name: "Alice", roomCode }),
      socket.emitWithAck("lobby:join", { name: "Alice", roomCode }),
    ]);
    for (const d of dupes) {
      assert.equal(d.ok, false);
      assert.equal(d.error.code, "ALREADY_IN_ROOM");
    }
  } finally {
    socket.close();
  }
});

test("invalid and unknown room codes are handled gracefully", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);

    // Unknown but well-formed codes.
    for (const code of ["0000", "9999", "1357"]) {
      const res = await socket.emitWithAck("lobby:join", { name: "Bob", roomCode: code });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "ROOM_NOT_FOUND");
    }

    // Malformed payloads.
    for (const bad of [{ name: "Bob" }, { name: "Bob", roomCode: "" }, { name: "Bob", roomCode: 12 }]) {
      const res = await socket.emitWithAck("lobby:join", bad);
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "INVALID_PAYLOAD");
    }

    // The socket is still healthy afterwards.
    const created = await socket.emitWithAck("lobby:create", { name: "Bob" });
    assert.equal(created.ok, true);
  } finally {
    socket.close();
  }
});
