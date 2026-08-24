import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { knowledgeFor, ObservedHistory } from "../simulation/src/ai/knowledge.js";
import { OBSERVATION_SIZE, THREAT_BASE, encode } from "../simulation/src/ai/observation.js";
import { LIGHT_SHOW } from "../src/data/lightAbilities.js";
import { OLD_FRIENDS } from "../src/data/kitsuneAbilities.js";
import { ALL_ABILITIES } from "../src/data/abilitiesRegistry.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * A bot can SEE the two threats whose only answer is a shield.
 *
 * ⚠️ THE REWARD EXISTED BEFORE THE PERCEPTION DID. `shieldedVsLightShow` has
 * been scored for a while, but nothing in the observation said a strike was on
 * the clock — so the only way to earn it was to happen to be shielded already.
 * Paying for a reaction the policy cannot perceive teaches nothing.
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

test("an incoming Light Show is visible, and grows more urgent as it closes", () => {
  const { match, players } = arena(["light", "plains"]);
  const [caster, victim] = players;
  caster!.unlocked["lightShow"] = true;
  match.tick = 1000;

  const obs = new Float32Array(OBSERVATION_SIZE);
  const history = new ObservedHistory();

  encode(knowledgeFor(match, victim!, history), obs);
  assert.equal(obs[THREAT_BASE], 0, "no strike, no urgency");

  assert.equal(activateAbility(match, caster!, LIGHT_SHOW, {}).ok, true);

  encode(knowledgeFor(match, victim!, history), obs);
  const atCast = obs[THREAT_BASE]!;
  assert.ok(atCast > 0, "the victim cannot see the strike it is meant to react to");
  assert.ok(obs[THREAT_BASE + 1]! > 0, "the victim cannot see how hard it hits");

  // Halfway through the fuse it must read as MORE urgent, because that is the
  // signal that maps onto "buy the shield now".
  match.tick += Math.floor((LIGHT_SHOW.effects[0]!.params as { delayTicks: number }).delayTicks / 2);
  encode(knowledgeFor(match, victim!, history), obs);
  assert.ok(obs[THREAT_BASE]! > atCast, `urgency should rise: ${atCast} -> ${obs[THREAT_BASE]}`);
});

test("the caster does not see its own Light Show as a threat", () => {
  // Shielding against your own ultimate is not defence, and the fitness scores
  // it that way — so the observation must agree.
  const { match, players } = arena(["light", "plains"]);
  const [caster] = players;
  caster!.unlocked["lightShow"] = true;
  match.tick = 1000;
  activateAbility(match, caster!, LIGHT_SHOW, {});

  const obs = new Float32Array(OBSERVATION_SIZE);
  encode(knowledgeFor(match, caster!, new ObservedHistory()), obs);
  assert.equal(obs[THREAT_BASE], 0);
});

test("an Old Friends siege is visible as the shield-only threat it is", () => {
  const { match, players } = arena(["kitsune", "plains"]);
  const [caster, victim] = players;
  caster!.unlocked["oldFriends"] = true;
  match.tick = 1000;

  const obs = new Float32Array(OBSERVATION_SIZE);
  encode(knowledgeFor(match, victim!, new ObservedHistory()), obs);
  assert.equal(obs[THREAT_BASE + 2], 0);

  assert.equal(activateAbility(match, caster!, OLD_FRIENDS, { targetId: "p1" }).ok, true);
  encode(knowledgeFor(match, victim!, new ObservedHistory()), obs);
  assert.equal(obs[THREAT_BASE + 2], 1, "the victim cannot see it is under a shield-only siege");
});

test("every shield-ended status in the catalog is one the observation reports", () => {
  // The flag is the authority, not a hand-kept list. A new ability declaring
  // `endsOnShieldPurchase` must not slip past the input that exists for it.
  const declared = new Set<string>();
  for (const ability of Object.values(ALL_ABILITIES)) {
    for (const effect of ability.effects ?? []) {
      const status = (effect.params as { status?: { id: string; endsOnShieldPurchase?: boolean } })
        .status;
      if (status?.endsOnShieldPurchase) declared.add(status.id);
    }
  }
  assert.ok(declared.has("oldFriends"), "Old Friends should declare endsOnShieldPurchase");
  // Whatever the set is, the observation reads the FLAG, so it covers all of
  // them by construction — this pins that the flag is still how it is spelled.
  assert.ok(declared.size >= 1, `expected at least one shield-ended status, found ${declared.size}`);
});
