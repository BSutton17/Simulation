import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import { startServer, type RunningServer } from "./helpers/server.js";
import { SHIELD } from "../src/data/balance.js";

// End-to-end: once a match is active, the server broadcasts periodic game-state
// syncs to everyone in the room (ticket #49).

const PORT = "3205";

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

test("an active match broadcasts periodic state:sync to players", async () => {
  const host = connect();
  const joiner = connect();
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

    const sync = new Promise<{
      tick: number;
      serverTime: number;
      players: {
        id: string;
        economy: {
          currency: number;
          incomePerTick: number;
          citizens: number;
          nextCitizenCost: number;
        };
        castle: { shield: number; nextRepairCost: number; nextShieldCost: number };
        abilityPrices: Record<string, { cast: number; unlock: number | null; upgrade: number | null }>;
      }[];
    }>((resolve, reject) => {
      joiner.on("state:sync", resolve);
      setTimeout(() => reject(new Error("no state:sync received")), 3000);
    });

    await host.emitWithAck("lobby:start", {});

    const s = await sync;
    assert.equal(typeof s.tick, "number");
    assert.ok(s.tick >= 1);
    assert.equal(typeof s.serverTime, "number");
    assert.equal(s.players.length, 2);
    // Full economy is synchronized (money, income, citizens, shield, costs).
    for (const p of s.players) {
      assert.ok(p.economy.currency >= 0);
      assert.equal(p.economy.citizens, 10);
      assert.equal(typeof p.economy.incomePerTick, "number");
      assert.equal(p.economy.nextCitizenCost, 25); // base cost, none purchased
      assert.equal(p.castle.shield, 0);
      assert.equal(typeof p.castle.nextRepairCost, "number");
      assert.equal(p.castle.nextShieldCost, SHIELD.COST); // base, none bought
      // The full price table rides along — every ability of the kingdom, all
      // locked at match start, so each carries an unlock price and no upgrade.
      const prices = Object.values(p.abilityPrices);
      assert.equal(prices.length, 5);
      for (const price of prices) {
        assert.ok(price.cast > 0);
        assert.ok(price.unlock !== null && price.unlock > 0);
        assert.equal(price.upgrade, null);
      }
    }
  } finally {
    host.close();
    joiner.close();
  }
});
