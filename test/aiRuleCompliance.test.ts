import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { selectTarget } from "../src/engine/targeting.js";
import { earn, spend } from "../src/engine/money.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import { abilitiesForKingdom } from "../src/data/kingdomAbilities.js";
import { TARGETING } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * The AI cannot act faster, or richer, than a player.
 *
 * ⚠️ THESE ARE ENGINE GATES, and that is the whole point: a bot casts through
 * `activateAbility` and retargets through `selectTarget`, the same two doors a
 * human uses. There is no bot-only path, so an "AI is cheating" report is
 * really a report about one of these gates — or about a mechanic that is
 * SUPPOSED to bypass them.
 *
 * A wall-clock audit of 4,532 casts appeared to show 145 cooldown breaches and
 * 55 illegal retargets. Every one was legitimate:
 *
 *   Light's `cooldownReductionOnCast` shaves 1.5 s off other cooldowns per cast
 *   Kitsune Rush runs cooldowns at RUSH_COOLDOWN_RATE (0.5 — twice as fast)
 *   Don't Blink cuts attack cooldowns 30%
 *   Caprice scrambles targets, and elimination frees a lock on a dead player
 *
 * Comparing elapsed ticks against the DECLARED cooldown cannot tell those from
 * cheating, because it assumes cooldowns always tick at 1x. So these tests
 * assert the gates themselves instead.
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
  for (const p of players) earn(p, 1_000_000);
  return { match, players };
}

test("no ability in the game can be cast twice without its cooldown elapsing", () => {
  let checked = 0;
  let onCooldown = 0;
  for (const kingdom of KINGDOM_IDS) {
    const kit = abilitiesForKingdom(kingdom).filter((a) => a.kind !== "passive");
    for (const ability of kit) {
      // A fresh arena per ability: a previous cast's statuses must not decide
      // this one's answer.
      const { match, players } = arena([kingdom, "plains", "plains"]);
      const [a] = players;
      for (const x of kit) a!.unlocked[x.id] = true;
      match.tick = 1000;
      selectTarget(match, a!, "p1");

      const first = activateAbility(match, a!, ability, { targetId: "p1", choice: ability.targeting.choices?.[0] });
      if (!first.ok) continue; // gated on something else (meter, charges, centrepiece)
      // Cooldown-free abilities are a deliberate design, not a violation.
      if ((a!.cooldowns[ability.id] ?? 0) === 0) continue;

      const second = activateAbility(match, a!, ability, { targetId: "p1", choice: ability.targeting.choices?.[0] });
      // REFUSAL is the invariant, not the reason. Several gates sit in front of
      // the cooldown check and one of them can answer first — Black Hole comes
      // back FIELD_OCCUPIED because it is already holding the centrepiece, which
      // is a stricter refusal, not a weaker one.
      assert.equal(
        second.ok,
        false,
        `${kingdom}/${ability.id} was castable twice with ${a!.cooldowns[ability.id]} ticks still on its cooldown`,
      );
      if (second.error === "ON_COOLDOWN") onCooldown += 1;
      checked += 1;
    }
  }
  assert.ok(checked > 50, `expected to exercise most of the catalog, only reached ${checked}`);
  // And the cooldown itself is doing the work for the overwhelming majority,
  // rather than the whole result resting on other gates.
  assert.ok(
    onCooldown > checked * 0.9,
    `only ${onCooldown} of ${checked} were refused specifically for ON_COOLDOWN`,
  );
});

test("no ability can be cast with gold the seat does not have", () => {
  const { match, players } = arena(["fire", "plains"]);
  const [a] = players;
  const ability = abilitiesForKingdom("fire").filter((x) => x.kind !== "passive")[0]!;
  a!.unlocked[ability.id] = true;
  match.tick = 1000;
  selectTarget(match, a!, "p1");

  // Leave the seat one gold short of its own price.
  spend(a!, a!.economy.currency - (ability.cost - 1));
  assert.equal(a!.economy.currency, ability.cost - 1);

  const result = activateAbility(match, a!, ability, { targetId: "p1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a!.economy.currency, ability.cost - 1, "a refused cast must not bill the seat");
});

test("a target cannot be switched again inside the switch cooldown", () => {
  const { match, players } = arena(["fire", "plains", "plains"]);
  const [a] = players;
  match.tick = 1000;

  assert.equal(selectTarget(match, a!, "p1").ok, true);
  // Immediately switching to a DIFFERENT seat is the spam the timer exists for.
  const tooSoon = selectTarget(match, a!, "p2");
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.error, "TARGET_ON_COOLDOWN");
  assert.equal(a!.target, "p1", "a refused switch must not move the target");

  // Re-selecting the CURRENT target is a no-op and stays legal.
  assert.equal(selectTarget(match, a!, "p1").ok, true);

  // And once the timer expires the switch goes through.
  match.tick = 1000 + TARGETING.SWITCH_COOLDOWN_TICKS;
  assert.equal(selectTarget(match, a!, "p2").ok, true);
  assert.equal(a!.target, "p2");
});
