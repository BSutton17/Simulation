import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";

const PORT = "3206";

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

async function startActiveMatch(host: Socket, joiner: Socket): Promise<string> {
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
  await host.emitWithAck("lobby:start", {});
  return roomCode;
}

test("match:buy rejects an unaffordable citizen at match start", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await startActiveMatch(host, joiner);

    // Players start with $0, so a citizen is unaffordable.
    const res = await host.emitWithAck("match:buy", { purchaseId: "citizen" });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INSUFFICIENT_FUNDS");
  } finally {
    host.close();
    joiner.close();
  }
});

test("match:buy rejects an unknown purchase", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await startActiveMatch(host, joiner);

    const res = await host.emitWithAck("match:buy", { purchaseId: "dragon" });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_TRANSACTION");
  } finally {
    host.close();
    joiner.close();
  }
});

test("match:buy succeeds once income has accrued, broadcasting the update", async () => {
  const host = connect();
  const joiner = connect();
  try {
    await waitConnected(host);
    await startActiveMatch(host, joiner);

    // Income is $0.05/tick (10 citizens × $0.005); wait for enough to afford one.
    // A citizen costs 10, so need 200 ticks at 20 ticks/sec = 10 seconds (or more with server latency).
    await new Promise((r) => setTimeout(r, 10500));

    const res = await host.emitWithAck("match:buy", { purchaseId: "citizen" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.citizens, 11);
  } finally {
    host.close();
    joiner.close();
  }
});
