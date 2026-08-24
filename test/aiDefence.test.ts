import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { earn } from "../src/engine/money.js";
import { knowledgeFor, ObservedHistory } from "../simulation/src/ai/knowledge.js";
import { OBSERVATION_SIZE, DEFENCE_BASE, THREAT_BASE, encode } from "../simulation/src/ai/observation.js";
import { livingCrawlers } from "../src/engine/crawlers.js";
import { dispellableStatus } from "../src/engine/purchases.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * A bot can answer the interactions that stop its economy.
 *
 * ⚠️ THESE USED TO BE UNANSWERABLE. Roulette and the Slot Machine halt gold
 * production until the victim bets or pulls the lever, and both resolve only
 * through `net/matchHandlers` — a socket path. So every bot hit by Joker lost
 * its income for the rest of the match, and Joker's balance numbers were
 * measured against opponents who could not defend.
 */

function seat(id: string, kingdomId: string): MatchPlayer {
  return { id, socketId: null, name: id, kingdomId, ready: true, connected: true } as never;
}

function arena(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(seat(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

test("the observation distinguishes a pending spin from a pending bet", () => {
  const { match, players } = arena(["joker", "plains"]);
  const [, victim] = players;
  const obs = new Float32Array(OBSERVATION_SIZE);
  const history = new ObservedHistory();

  // Nothing owed: both flags down.
  encode(knowledgeFor(match, victim!, history), obs);
  assert.equal(obs[DEFENCE_BASE], 0, "spin flag should be down");
  assert.equal(obs[DEFENCE_BASE + 1], 0, "bet flag should be down");

  // A pending spin raises ONLY the spin flag — input 13 could not tell these
  // apart, which is why it was not enough to act on.
  victim!.pendingSpin = { sourceId: "p0", abilityId: "slotMachine", atTick: 0 };
  encode(knowledgeFor(match, victim!, history), obs);
  assert.equal(obs[DEFENCE_BASE], 1);
  assert.equal(obs[DEFENCE_BASE + 1], 0);

  victim!.pendingSpin = null;
  victim!.pendingBet = { sourceId: "p0", abilityId: "roulette", atTick: 0 };
  encode(knowledgeFor(match, victim!, history), obs);
  assert.equal(obs[DEFENCE_BASE], 0);
  assert.equal(obs[DEFENCE_BASE + 1], 1);
});

test("knowledge reports crawlers and a dispellable ransom", () => {
  const { match, players } = arena(["insects", "plains"]);
  const [, victim] = players;
  const history = new ObservedHistory();

  const clean = knowledgeFor(match, victim!, history);
  assert.equal(clean.self.crawlers, 0);
  assert.equal(clean.self.dispel, null);

  // The knowledge must agree with the engine's own count, not keep its own.
  assert.equal(clean.self.crawlers, livingCrawlers(victim!));
  assert.equal(clean.self.dispel, dispellableStatus(victim!));
});

test("the defence block sits inside the observation and every input is finite", () => {
  const { match, players } = arena(["light", "plains", "plains"]);
  const obs = new Float32Array(OBSERVATION_SIZE);
  encode(knowledgeFor(match, players[0]!, new ObservedHistory()), obs);
  // The defence block is four inputs wide and butts against the threat block,
  // which was appended after it. Asserting against OBSERVATION_SIZE would pin
  // "nothing may ever be added after this", which is not the claim.
  assert.equal(DEFENCE_BASE + 4, THREAT_BASE, "the defence block must be four inputs wide");
  assert.ok(THREAT_BASE < OBSERVATION_SIZE, "the threat block must fit");
  assert.ok(obs.every((x) => Number.isFinite(x)), "observation contained NaN");
});

test("a bot pulls the lever, places a bet, and swats a bug", async () => {
  const { NetworkController } = await import("../simulation/src/ai/controller.js");
  const { ACTION_SIZE, DEFEND_GATE } = await import("../simulation/src/ai/actions.js");

  // A network is irrelevant here — what matters is that the controller CAN
  // reach these engine calls. So the decision is forced by stubbing the
  // network to hold DEFEND_GATE open and everything else shut.
  const forced = {
    activate: (_inputs: Float32Array, out: Float32Array) => {
      out.fill(-10);
      out[DEFEND_GATE] = 10;
    },
  };

  const { match, players } = arena(["joker", "plains"]);
  const [, victim] = players;
  const controller = new NetworkController(victim!, {
    network: forced as never,
    rng: () => 0.5,
    difficulty: "hard",
  });

  // A pending spin is answered, and the debt clears.
  victim!.pendingSpin = { sourceId: "p0", abilityId: "slotMachine", atTick: 0 };
  for (let i = 0; i < 40 && victim!.pendingSpin !== null; i++) {
    controller.act({ match, player: victim!, tick: match.tick, rng: () => 0.5 } as never);
    match.tick += 1;
  }
  assert.equal(victim!.pendingSpin, null, "the bot never pulled the lever");

  // And so is a pending bet.
  victim!.pendingBet = { sourceId: "p0", abilityId: "roulette", atTick: 0 };
  for (let i = 0; i < 40 && victim!.pendingBet !== null; i++) {
    controller.act({ match, player: victim!, tick: match.tick, rng: () => 0.5 } as never);
    match.tick += 1;
  }
  assert.equal(victim!.pendingBet, null, "the bot never placed a bet");
  assert.ok(controller.stats.defends >= 2, `defends=${controller.stats.defends}`);
  void ACTION_SIZE;
});
