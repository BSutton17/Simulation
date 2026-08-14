import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import { CASTLE, CITIZENS, MATCH } from "../src/data/balance.js";

const makePlayer = (id: string): MatchPlayer => ({
  id,
  socketId: `sock-${id}`,
  name: `Player ${id}`,
  kingdomId: null,
  ready: false,
  connected: true,
});

test("a new match starts empty in the lobby phase with defaults", () => {
  const match = new Match("1234");
  assert.equal(match.roomCode, "1234");
  assert.equal(match.phase, "lobby");
  assert.equal(match.hostId, null);
  assert.equal(match.winnerId, null);
  assert.equal(match.tick, 0);
  assert.equal(match.maxPlayers, MATCH.MAX_PLAYERS);
  assert.equal(match.playerCount, 0);
  assert.ok(match.isEmpty());
});

test("adds and looks up players", () => {
  const match = new Match("1234");
  match.addPlayer(makePlayer("a"));
  match.addPlayer(makePlayer("b"));

  assert.equal(match.playerCount, 2);
  assert.ok(match.hasPlayer("a"));
  assert.equal(match.getPlayer("b")?.name, "Player b");
  assert.deepEqual(
    match.getPlayers().map((p) => p.id),
    ["a", "b"],
  );
});

test("rejects duplicate players", () => {
  const match = new Match("1234");
  match.addPlayer(makePlayer("a"));
  assert.throws(() => match.addPlayer(makePlayer("a")), /already in match/);
});

test("removes players and reports emptiness", () => {
  const match = new Match("1234");
  match.addPlayer(makePlayer("a"));
  assert.equal(match.removePlayer("a"), true);
  assert.equal(match.removePlayer("a"), false);
  assert.ok(match.isEmpty());
});

test("enforces the maximum player count", () => {
  const match = new Match("1234", { maxPlayers: 2 });
  match.addPlayer(makePlayer("a"));
  match.addPlayer(makePlayer("b"));
  assert.ok(match.isFull());
  assert.throws(() => match.addPlayer(makePlayer("c")), /is full/);
});

test("tracks the host", () => {
  const match = new Match("1234");
  match.addPlayer(makePlayer("a"));
  match.hostId = "a";
  assert.ok(match.isHost("a"));
  assert.equal(match.isHost("b"), false);
});

test("starting a match creates game state for each player", () => {
  const match = new Match("1234");
  const alice = makePlayer("a");
  alice.kingdomId = "plains";
  const bob = makePlayer("b");
  bob.kingdomId = "water";
  match.addPlayer(alice);
  match.addPlayer(bob);
  match.hostId = "a";

  match.start(createMatchConfig(match));

  assert.equal(match.phase, "active");
  assert.ok(match.gameState, "game state should be created on start");
  assert.equal(match.gameState?.playerCount, 2);
  const aState = match.gameState?.getPlayer("a");
  assert.equal(aState?.castle.hp, CASTLE.STARTING_HP);
  assert.equal(aState?.economy.citizens, CITIZENS.STARTING_COUNT);
  assert.equal(aState?.eliminated, false);
});

test("serializes to a plain client-facing view", () => {
  const match = new Match("4321");
  match.addPlayer(makePlayer("a"));
  match.hostId = "a";

  const snap = match.serialize();
  assert.deepEqual(snap, {
    roomCode: "4321",
    phase: "lobby",
    hostId: "a",
    players: [
      {
        id: "a",
        socketId: "sock-a",
        name: "Player a",
        kingdomId: null,
        ready: false,
        connected: true,
      },
    ],
    playerCount: 1,
    maxPlayers: MATCH.MAX_PLAYERS,
    maxActivePlayers: MATCH.MAX_ACTIVE_PLAYERS,
    // Host rule, off until the host turns it on.
    eliminatedSeeAllHealth: false,
    tick: 0,
    winnerId: null,
    config: null,
    startedAt: null,
  });
});

test("spectators don't gate canStart, don't count as active players, and get no PlayerState", () => {
  const match = new Match("1234");
  const play = (id: string, kingdomId: string) => {
    const p = makePlayer(id);
    p.kingdomId = kingdomId as MatchPlayer["kingdomId"];
    p.perks = ["sharperSwords", "extraGuards"];
    p.ready = true;
    match.addPlayer(p);
    return p;
  };
  play("a", "fire");
  play("b", "water");
  // A spectator: no kingdom, not ready — must NOT block the start.
  const spec = makePlayer("s");
  spec.spectator = true;
  match.addPlayer(spec);

  assert.equal(match.activePlayerCount, 2); // spectator excluded
  assert.equal(match.canStart(), true);

  match.start(createMatchConfig(match));
  // Only the two real players get a gameplay PlayerState; the spectator doesn't.
  assert.ok(match.gameState!.getPlayer("a"));
  assert.ok(match.gameState!.getPlayer("b"));
  assert.equal(match.gameState!.getPlayer("s"), undefined);
});

test("a lone real player plus a spectator cannot start (min players not met)", () => {
  const match = new Match("1234");
  const a = makePlayer("a");
  a.kingdomId = "fire" as MatchPlayer["kingdomId"];
  a.ready = true;
  match.addPlayer(a);
  const spec = makePlayer("s");
  spec.spectator = true;
  match.addPlayer(spec);
  assert.equal(match.canStart(), false); // only 1 active player < MIN
});
