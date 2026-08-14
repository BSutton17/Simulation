import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

// End-to-end lobby room events against a live server.

const PORT = "3201";

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

// Resolves with the match from the first `lobby:updated` that satisfies `pred`,
// ignoring earlier updates (robust to event ordering).
function waitForUpdate(
  socket: Socket,
  pred: (match: Match) => boolean,
): Promise<Match> {
  return new Promise((resolve) => {
    const handler = (payload: { match: Match }) => {
      if (pred(payload.match)) {
        socket.off("lobby:updated", handler);
        resolve(payload.match);
      }
    };
    socket.on("lobby:updated", handler);
  });
}

interface Match {
  roomCode: string;
  phase: string;
  hostId: string;
  playerCount: number;
  players: { id: string; name: string; ready: boolean; connected: boolean; kingdomId: string | null }[];
}

test("lobby:create hosts a new match and seats the caller as host", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const res = await socket.emitWithAck("lobby:create", { name: "Alice" });

    assert.equal(res.ok, true);
    assert.match(res.data.roomCode, /^\d{4}$/);
    assert.ok(typeof res.data.playerId === "string" && res.data.playerId.length > 0);

    const match = res.data.match;
    assert.equal(match.phase, "lobby");
    assert.equal(match.hostId, res.data.playerId);
    assert.equal(match.playerCount, 1);
    assert.equal(match.players[0].name, "Alice");
  } finally {
    socket.close();
  }
});

test("lobby:create rejects an invalid name", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const res = await socket.emitWithAck("lobby:create", { name: "   " });

    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  } finally {
    socket.close();
  }
});

test("lobby:join adds a player to an existing room and notifies members", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    // Host should be notified when someone joins.
    const joinedNotice = new Promise<{ player: { name: string } }>((resolve) => {
      host.on("lobby:playerJoined", resolve);
    });

    await waitConnected(joiner);
    const res = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    assert.equal(res.ok, true);
    assert.equal(res.data.roomCode, roomCode);
    assert.equal(res.data.match.playerCount, 2);
    assert.equal(res.data.match.hostId, created.data.playerId);
    assert.deepEqual(
      res.data.match.players.map((p: { name: string }) => p.name).sort(),
      ["Alice", "Bob"],
    );

    const notice = await joinedNotice;
    assert.equal(notice.player.name, "Bob");
  } finally {
    host.close();
    joiner.close();
  }
});

test("lobby:selectKingdom sets the player's kingdom and notifies the room", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    const settled = waitForUpdate(
      joiner,
      (m) => m.players.find((p) => p.name === "Alice")?.kingdomId === "fire",
    );

    const res = await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
    assert.equal(res.ok, true);
    assert.equal(res.data.kingdom, "fire");

    const match = await settled;
    assert.equal(match.players.find((p) => p.name === "Alice")?.kingdomId, "fire");
  } finally {
    host.close();
    joiner.close();
  }
});

test("kingdom selections are synchronized to everyone in the lobby", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });

    // The host observes the broadcast reflecting both players' selections.
    const settled = waitForUpdate(host, (m) =>
      m.players.every((p) => p.kingdomId !== null),
    );
    await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "water" });

    const match = await settled;
    const byId = Object.fromEntries(
      match.players.map((p) => [p.id, p.kingdomId]),
    );
    assert.equal(byId[created.data.playerId], "fire");
    assert.equal(byId[joined.data.playerId], "water");
  } finally {
    host.close();
    joiner.close();
  }
});

test("kingdoms are exclusive; taken and invalid kingdoms are rejected", async () => {
  const a = connect();
  const b = connect();
  try {
    await waitConnected(a);
    const created = await a.emitWithAck("lobby:create", { name: "A" });
    const roomCode = created.data.roomCode;
    await waitConnected(b);
    await b.emitWithAck("lobby:join", { name: "B", roomCode });

    // A takes "ice"; B may not take the same one.
    assert.equal((await a.emitWithAck("lobby:selectKingdom", { kingdom: "ice" })).ok, true);
    const taken = await b.emitWithAck("lobby:selectKingdom", { kingdom: "ice" });
    assert.equal(taken.ok, false);
    assert.equal(taken.error.code, "KINGDOM_TAKEN");

    // B may take a different one.
    assert.equal((await b.emitWithAck("lobby:selectKingdom", { kingdom: "fire" })).ok, true);

    // Unknown kingdom is rejected.
    const bad = await a.emitWithAck("lobby:selectKingdom", { kingdom: "shadow" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "INVALID_PAYLOAD");
  } finally {
    a.close();
    b.close();
  }
});

test("players change kingdoms freely until the match starts", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;
    await waitConnected(joiner);
    await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    // Host takes fire, then switches to water — fire is released.
    assert.equal((await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" })).ok, true);
    assert.equal((await host.emitWithAck("lobby:selectKingdom", { kingdom: "water" })).ok, true);
    // Joiner can now take the freed fire.
    assert.equal((await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "fire" })).ok, true);

    // Pick perks, ready up, and start.
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await joiner.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:ready", { ready: true });
    assert.equal((await host.emitWithAck("lobby:start", {})).ok, true);

    // After the match starts, kingdom changes are rejected.
    const afterStart = await host.emitWithAck("lobby:selectKingdom", { kingdom: "ice" });
    assert.equal(afterStart.ok, false);
    assert.equal(afterStart.error.code, "INVALID_PHASE");
  } finally {
    host.close();
    joiner.close();
  }
});

test("lobby:ready toggles ready state and notifies the room", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });
    // New players start not ready.
    assert.equal(joined.data.match.players[0].ready, false);

    // Readying up requires a settled loadout — a kingdom AND a full perk set.
    const noLoadout = await joiner.emitWithAck("lobby:ready", { ready: true });
    assert.equal(noLoadout.ok, false);
    assert.equal(noLoadout.error.code, "NOT_READY");
    await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "water" });
    const noPerks = await joiner.emitWithAck("lobby:ready", { ready: true });
    assert.equal(noPerks.ok, false);
    assert.equal(noPerks.error.code, "NOT_READY");
    await joiner.emitWithAck("lobby:selectPerks", { perks: PERKS });

    const settled = waitForUpdate(
      host,
      (m) => m.players.find((p) => p.name === "Bob")?.ready === true,
    );

    const res = await joiner.emitWithAck("lobby:ready", { ready: true });
    assert.equal(res.ok, true);
    assert.equal(res.data.ready, true);

    const match = await settled;
    assert.equal(match.players.find((p) => p.name === "Bob")?.ready, true);
  } finally {
    host.close();
    joiner.close();
  }
});

test("lobby:ready rejects a non-boolean and a caller not in a room", async () => {
  const solo = connect();
  try {
    await waitConnected(solo);
    // Not in a room yet.
    const notInRoom = await solo.emitWithAck("lobby:ready", { ready: true });
    assert.equal(notInRoom.ok, false);
    assert.equal(notInRoom.error.code, "INVALID_PHASE");

    await solo.emitWithAck("lobby:create", { name: "Solo" });
    const bad = await solo.emitWithAck("lobby:ready", { ready: "yes" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "INVALID_PAYLOAD");
  } finally {
    solo.close();
  }
});

test("lobby:start requires all connected players ready", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    // Not everyone ready yet → rejected.
    const early = await host.emitWithAck("lobby:start", {});
    assert.equal(early.ok, false);
    assert.equal(early.error.code, "NOT_READY");

    // Without a kingdom nobody can even ready up → still rejected.
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:ready", { ready: true });
    const noKingdom = await host.emitWithAck("lobby:start", {});
    assert.equal(noKingdom.ok, false);
    assert.equal(noKingdom.error.code, "NOT_READY");

    // Everyone picks a kingdom — but perks are still missing, so readying up
    // (and therefore starting) stays blocked.
    await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
    await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "water" });
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:ready", { ready: true });
    const noPerks = await host.emitWithAck("lobby:start", {});
    assert.equal(noPerks.ok, false);
    assert.equal(noPerks.error.code, "NOT_READY");

    // Everyone picks their perks and readies up for real.
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await joiner.emitWithAck("lobby:selectPerks", { perks: ["extraMedics", "deepPockets"] });
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:ready", { ready: true });

    // A non-host cannot start.
    const byJoiner = await joiner.emitWithAck("lobby:start", {});
    assert.equal(byJoiner.ok, false);
    assert.equal(byJoiner.error.code, "NOT_HOST");

    // Host starts once everyone is ready; the match goes active and everyone
    // receives match:started.
    const matchStarted = new Promise<{
      roomCode: string;
      config: { startingCastleHp: number; startingCitizens: number; tickRate: number };
      players: unknown[];
      tick: number;
    }>((resolve) => joiner.on("match:started", resolve));

    const res = await host.emitWithAck("lobby:start", {});
    assert.equal(res.ok, true);
    assert.equal(res.data.phase, "active");

    const ms = await matchStarted;
    assert.equal(ms.roomCode, roomCode);
    assert.equal(ms.config.startingCastleHp, 10_000);
    assert.equal(ms.config.startingCitizens, 10);
    assert.equal(ms.config.tickRate, 20);
    assert.equal(ms.players.length, 2);
    assert.equal(ms.tick, 0);
  } finally {
    host.close();
    joiner.close();
  }
});

test("the lobby is locked once the match starts", async () => {
  const host = connect();
  const joiner = connect();
  const latecomer = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    await host.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
    await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "water" });
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await joiner.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:ready", { ready: true });
    assert.equal((await host.emitWithAck("lobby:start", {})).ok, true);

    // A new player can no longer join the active match.
    await waitConnected(latecomer);
    const res = await latecomer.emitWithAck("lobby:join", {
      name: "Late",
      roomCode,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_PHASE");
  } finally {
    host.close();
    joiner.close();
    latecomer.close();
  }
});

test("joining with a session already seated is rejected, not crashed", async () => {
  // Simulates a second socket/tab sharing the same session id.
  const host = connect();
  const secondSocket = connect();
  try {
    await waitConnected(host);
    // Fix the host's session id so we can reuse it.
    await host.emitWithAck("conn:identify", { sessionId: "shared-session" });
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;
    assert.equal(created.data.playerId, "shared-session");

    await waitConnected(secondSocket);
    await secondSocket.emitWithAck("conn:identify", { sessionId: "shared-session" });
    const res = await secondSocket.emitWithAck("lobby:join", {
      name: "Alice2",
      roomCode,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "DUPLICATE_JOIN");
  } finally {
    host.close();
    secondSocket.close();
  }
});

test("lobby:join rejects an unknown room code", async () => {
  const socket = connect();
  try {
    await waitConnected(socket);
    const res = await socket.emitWithAck("lobby:join", {
      name: "Bob",
      roomCode: "1234",
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "ROOM_NOT_FOUND");
  } finally {
    socket.close();
  }
});

test("a socket already in a room cannot join again (repeated request)", async () => {
  const host = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    // The host is already seated; a join for the same room must be rejected.
    const res = await host.emitWithAck("lobby:join", {
      name: "Alice",
      roomCode: created.data.roomCode,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "ALREADY_IN_ROOM");
  } finally {
    host.close();
  }
});

test("claiming a player id that is still connected is rejected as duplicate", async () => {
  const host = connect();
  const joiner = connect();
  const impostor = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    await waitConnected(impostor);
    const res = await impostor.emitWithAck("room:reconnect", {
      sessionId: joined.data.playerId,
      roomCode,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "DUPLICATE_JOIN");
  } finally {
    host.close();
    joiner.close();
    impostor.close();
  }
});

test("room:reconnect reattaches an existing seat instead of duplicating", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });
    assert.equal(joined.data.match.playerCount, 2);

    // Simulate a dropped connection and wait for the server to mark it offline.
    joiner.close();
    await new Promise((r) => setTimeout(r, 400));

    // Reconnect with the same session id (default grace is long, so still seated).
    const reconnect = connect();
    try {
      await waitConnected(reconnect);
      const res = await reconnect.emitWithAck("room:reconnect", {
        sessionId: joined.data.playerId,
        roomCode,
      });
      assert.equal(res.ok, true);
      assert.equal(res.data.reconnected, true);
      assert.equal(res.data.playerId, joined.data.playerId);
      // Still only two players — no duplicate seat was created.
      assert.equal(res.data.match.playerCount, 2);
    } finally {
      reconnect.close();
    }
  } finally {
    host.close();
    joiner.close();
  }
});

test("room:reconnect restores full state via a state:full snapshot", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    joiner.close();
    await new Promise((r) => setTimeout(r, 400));

    const rc = connect();
    try {
      await waitConnected(rc);
      const snapshot = new Promise<{
        roomCode: string;
        phase: string;
        tick: number;
        serverTime: number;
        you: { id: string; name: string };
        players: unknown[];
        projectiles: unknown[];
      }>((resolve) => rc.on("state:full", resolve));

      const res = await rc.emitWithAck("room:reconnect", {
        sessionId: joined.data.playerId,
        roomCode,
      });
      assert.equal(res.ok, true);

      const snap = await snapshot;
      assert.equal(snap.roomCode, roomCode);
      assert.equal(snap.phase, "lobby");
      assert.equal(typeof snap.tick, "number");
      assert.equal(snap.you.id, joined.data.playerId);
      assert.equal(snap.you.name, "Bob");
      // Match-wide battlefield state: every player + timers + projectiles.
      assert.equal(snap.players.length, 2);
      assert.equal(typeof snap.serverTime, "number");
      assert.ok(Array.isArray(snap.projectiles));
    } finally {
      rc.close();
    }
  } finally {
    host.close();
    joiner.close();
  }
});

test("room:reconnect rejects a session that is not in the room", async () => {
  const host = connect();
  const other = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });

    await waitConnected(other);
    const res = await other.emitWithAck("room:reconnect", {
      sessionId: "not-a-member",
      roomCode: created.data.roomCode,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "SESSION_NOT_IN_ROOM");
  } finally {
    host.close();
    other.close();
  }
});

test("lobby:leave removes a player and notifies remaining members", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    const settled = waitForUpdate(host, (m) => m.playerCount === 1);

    const res = await joiner.emitWithAck("lobby:leave", {});
    assert.equal(res.ok, true);
    assert.equal(res.data.left, true);

    const match = await settled;
    assert.equal(match.playerCount, 1);
  } finally {
    host.close();
    joiner.close();
  }
});

test("host leaving reassigns the host to a remaining player", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    await waitConnected(joiner);
    const joined = await joiner.emitWithAck("lobby:join", { name: "Bob", roomCode });

    const settled = waitForUpdate(
      joiner,
      (m) => m.hostId === joined.data.playerId,
    );

    await host.emitWithAck("lobby:leave", {});

    const match = await settled;
    assert.equal(match.hostId, joined.data.playerId);
  } finally {
    host.close();
    joiner.close();
  }
});

test("host transfer prefers a connected player over one mid-reconnect", async () => {
  const host = connect();
  const p1 = connect();
  const p2 = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Host" });
    const roomCode = created.data.roomCode;

    await waitConnected(p1);
    const joined1 = await p1.emitWithAck("lobby:join", { name: "P1", roomCode });

    await waitConnected(p2);
    const joined2 = await p2.emitWithAck("lobby:join", { name: "P2", roomCode });

    // P1 (who joined first) drops and enters the reconnection grace window.
    p1.close();
    await new Promise((r) => setTimeout(r, 400));

    // Host leaves; the new host should be P2 (connected), not P1 (disconnected).
    const settled = waitForUpdate(
      p2,
      (m) => m.hostId === joined2.data.playerId,
    );
    await host.emitWithAck("lobby:leave", {});

    const match = await settled;
    assert.equal(match.hostId, joined2.data.playerId);
    assert.notEqual(match.hostId, joined1.data.playerId);
  } finally {
    host.close();
    p1.close();
    p2.close();
  }
});

test("the last player leaving closes the room", async () => {
  const host = connect();
  const later = connect();
  try {
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.roomCode;

    const res = await host.emitWithAck("lobby:leave", {});
    assert.equal(res.data.left, true);

    // The room no longer exists, so joining it fails.
    await waitConnected(later);
    const join = await later.emitWithAck("lobby:join", { name: "Bob", roomCode });
    assert.equal(join.ok, false);
    assert.equal(join.error.code, "ROOM_NOT_FOUND");
  } finally {
    host.close();
    later.close();
  }
});

test("a room cannot exceed the maximum of eight players", async () => {
  const sockets: Socket[] = [];
  try {
    // Host creates the room (player 1 of 8).
    const host = connect();
    sockets.push(host);
    await waitConnected(host);
    const created = await host.emitWithAck("lobby:create", { name: "Host" });
    const roomCode = created.data.roomCode;

    // Seven more join to reach the cap of 8.
    for (let i = 2; i <= 8; i++) {
      const s = connect();
      sockets.push(s);
      await waitConnected(s);
      const res = await s.emitWithAck("lobby:join", { name: `P${i}`, roomCode });
      assert.equal(res.ok, true, `player ${i} should join`);
      assert.equal(res.data.match.playerCount, i);
    }

    // The ninth is rejected with ROOM_FULL and does not change the roster.
    const ninth = connect();
    sockets.push(ninth);
    await waitConnected(ninth);
    const rejected = await ninth.emitWithAck("lobby:join", {
      name: "P9",
      roomCode,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "ROOM_FULL");
  } finally {
    for (const s of sockets) s.close();
  }
});

// --- Host-only room rules ----------------------------------------------------

test("the host can let eliminated players keep watching health bars", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await waitConnected(joiner);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.match.roomCode;
    await joiner.emitWithAck("lobby:join", { roomCode, name: "Bob" });

    // Off by default: knowing the whole board is opt-in.
    assert.equal(created.data.match.eliminatedSeeAllHealth, false);

    const broadcast = waitForUpdate(joiner, (m) => m.eliminatedSeeAllHealth === true);
    const res = await host.emitWithAck("lobby:setRules", {
      eliminatedSeeAllHealth: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.data.eliminatedSeeAllHealth, true);

    // Everyone in the room learns the rule, not just the host who set it.
    const seen = await broadcast;
    assert.equal(seen.eliminatedSeeAllHealth, true);
  } finally {
    host.close();
    joiner.close();
  }
});

test("only the host can change the rules, and only before the match starts", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await waitConnected(joiner);
    const created = await host.emitWithAck("lobby:create", { name: "Alice" });
    const roomCode = created.data.match.roomCode;
    await joiner.emitWithAck("lobby:join", { roomCode, name: "Bob" });

    const notHost = await joiner.emitWithAck("lobby:setRules", {
      eliminatedSeeAllHealth: true,
    });
    assert.equal(notHost.ok, false);
    assert.equal(notHost.error.code, "NOT_HOST");

    const badInput = await host.emitWithAck("lobby:setRules", {
      eliminatedSeeAllHealth: "yes",
    });
    assert.equal(badInput.ok, false);
    assert.equal(badInput.error.code, "INVALID_INPUT");

    // Once the match is running the rule is locked — changing what players can
    // see mid-game would move the goalposts under them.
    await host.emitWithAck("lobby:selectKingdom", { kingdom: "water" });
    await host.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await host.emitWithAck("lobby:ready", { ready: true });
    await joiner.emitWithAck("lobby:selectKingdom", { kingdom: "fire" });
    await joiner.emitWithAck("lobby:selectPerks", { perks: PERKS });
    await joiner.emitWithAck("lobby:ready", { ready: true });
    const started = await host.emitWithAck("lobby:start", {});
    assert.equal(started.ok, true);

    const tooLate = await host.emitWithAck("lobby:setRules", {
      eliminatedSeeAllHealth: true,
    });
    assert.equal(tooLate.ok, false);
    assert.equal(tooLate.error.code, "INVALID_PHASE");
  } finally {
    host.close();
    joiner.close();
  }
});

test("switching away from Kitsune gives back the perk its passive granted", async () => {
  const host = connect();
  try {
    await waitConnected(host);
    await host.emitWithAck("lobby:create", { name: "Alice" });

    // Kitsune's "Three tailed fox" allows a third perk.
    assert.equal(
      (await host.emitWithAck("lobby:selectKingdom", { kingdom: "kitsune" })).ok,
      true,
    );
    const three = [...PERKS, "extraRepairs"];
    assert.equal((await host.emitWithAck("lobby:selectPerks", { perks: three })).ok, true);
    assert.equal(
      (await host.emitWithAck("lobby:ready", { ready: true })).ok,
      true,
      "three perks is a full set for Kitsune",
    );

    // Switching to a kingdom without that passive has to give the extra perk
    // back. Keeping it would hand out a free bonus AND wedge the seat: the
    // ready gate wants the count to match the allowance exactly, so three perks
    // on a two-perk kingdom can never be readied.
    await host.emitWithAck("lobby:ready", { ready: false });
    const trimmed = waitForUpdate(
      host,
      (m) => (m.players.find((p) => p.name === "Alice")?.perks?.length ?? 0) === 2,
    );
    assert.equal((await host.emitWithAck("lobby:selectKingdom", { kingdom: "water" })).ok, true);
    const match = await trimmed;
    const alice = match.players.find((p) => p.name === "Alice");
    assert.deepEqual(alice?.perks, PERKS, "the earliest picks are the ones kept");
    // …and the seat is immediately readyable again on its new allowance.
    assert.equal((await host.emitWithAck("lobby:ready", { ready: true })).ok, true);

    // Going the other way does NOT hand out the third perk automatically — it
    // only raises the ceiling, so the seat has to pick it.
    await host.emitWithAck("lobby:ready", { ready: false });
    assert.equal(
      (await host.emitWithAck("lobby:selectKingdom", { kingdom: "kitsune" })).ok,
      true,
    );
    const backToThree = await host.emitWithAck("lobby:ready", { ready: true });
    assert.equal(backToThree.ok, false);
    assert.equal(backToThree.error.code, "NOT_READY");
  } finally {
    host.close();
  }
});
