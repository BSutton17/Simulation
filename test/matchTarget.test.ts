import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// End-to-end target selection (tickets #61–#63): a player selects another active
// kingdom over the socket, invalid targets are rejected, and the updated target
// is synchronized to the room via state:sync.

const PORT = "3207";

/** A valid full perk selection — readying up requires one (see data/perks.ts). */
const PERKS = ["sharperSwords", "extraGuards"];

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

/** Starts an active two-player match, returning the room and both player ids. */
async function startActiveMatch(
  host: Socket,
  joiner: Socket,
): Promise<{ roomCode: string; hostId: string; joinerId: string }> {
  const created = await host.emitWithAck("lobby:create", { name: "Alice" });
  const roomCode = created.data.roomCode;
  const hostId = created.data.playerId;
  await waitConnected(joiner);
  const joined = await joiner.emitWithAck("lobby:join", {
    name: "Bob",
    roomCode,
  });
  const joinerId = joined.data.playerId;
  await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
  await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "water" });
  await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
  await joiner.emitWithAck("lobby:selectPerks", { perks: PERKS });
  await host.emitWithAck("lobby:ready", { ready: true });
  await joiner.emitWithAck("lobby:ready", { ready: true });
  await host.emitWithAck("lobby:start", {});
  return { roomCode, hostId, joinerId };
}

test("match:target sets and clears the current target and syncs it to the room", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const { hostId, joinerId } = await startActiveMatch(host, joiner);

    // The next state:sync after the selection should carry the host's target.
    const targetSync = new Promise<{
      players: { id: string; target: string | null }[];
    }>((resolve, reject) => {
      const handler = (payload: {
        players: { id: string; target: string | null }[];
      }) => {
        const me = payload.players.find((p) => p.id === hostId);
        if (me && me.target === joinerId) {
          joiner.off("state:sync", handler);
          resolve(payload);
        }
      };
      joiner.on("state:sync", handler);
      setTimeout(() => reject(new Error("no target in state:sync")), 3000);
    });

    const res = await host.emitWithAck("match:target", { targetId: joinerId });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.targetId, joinerId);

    // #63: the target propagated to the room.
    await targetSync;

    // Clearing the target succeeds too.
    const cleared = await host.emitWithAck("match:target", { targetId: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.data.targetId, null);
  } finally {
    host.close();
    joiner.close();
  }
});

test("match:target rejects self-targeting and unknown kingdoms", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const { hostId } = await startActiveMatch(host, joiner);

    const self = await host.emitWithAck("match:target", { targetId: hostId });
    assert.equal(self.ok, false);
    assert.equal(self.error.code, "INVALID_TARGET");

    const unknown = await host.emitWithAck("match:target", { targetId: "nope" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "INVALID_TARGET");
  } finally {
    host.close();
    joiner.close();
  }
});

test("match:target rejects a malformed payload", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await startActiveMatch(host, joiner);

    const res = await host.emitWithAck("match:target", { targetId: 42 });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  } finally {
    host.close();
    joiner.close();
  }
});
