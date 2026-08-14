import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { tickMatch } from "../src/engine/tick.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { selectTarget } from "../src/engine/targeting.js";
import { earn } from "../src/engine/money.js";
import { KINGDOM_IDS, KINGDOM_PASSIVES } from "../src/data/kingdoms.js";
import { KINGDOM_ABILITIES } from "../src/data/kingdomAbilities.js";
import { runSimulation } from "../simulation/src/index.js";
import { mulberry32 } from "../simulation/src/rng.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import type { AbilityDefinition } from "../src/engine/abilities.js";

/**
 * Simulator coverage for EVERY kingdom.
 *
 * The point of this file is to fail loudly when a kingdom is added to the game
 * but not properly supported by the simulation — the Balance AI's conclusions
 * are only valid if every kingdom genuinely plays. It deliberately verifies
 * BEHAVIOUR (can the kit actually be cast? does a match produce telemetry?)
 * rather than registry presence, because an id in an enum proves nothing.
 *
 * It drives the production engine through the simulation framework; it never
 * re-implements gameplay.
 */

/**
 * Cast rejections that mean "the engine correctly gated this", not "broken".
 * These abilities need match state that a synthetic setup cannot fabricate
 * (a charged meter, an unoccupied centrepiece). Each is a real engine rule.
 */
const RESOURCE_GATES = new Set([
  "NO_SUPERNOVA",      // Space — Supernova meter empty
  "NOT_ENRAGED",       // Dark — Unlimited Rage not charged
  "MEMORY_NOT_FULL",   // Kitsune — Ancient Memory not full
  "NO_CHARGES",        // charge-costed abilities
  "FIELD_OCCUPIED",    // centrepiece exclusivity
  "TARGET_LIMIT",      // concurrent-affected cap
  "BASIC_ATTACKS_ONLY",
  "ATTACKS_BLOCKED",
]);

function seat(id: string, kingdomId: KingdomId): MatchPlayer {
  return { id, socketId: null, name: id, kingdomId, ready: true, connected: true };
}

/** Three seats, so abilities needing a distinct second target can be cast. */
function startedMatch(kingdomId: KingdomId, seed = 4242) {
  const others = KINGDOM_IDS.filter((k) => k !== kingdomId);
  const match = new Match("KTEST", { rng: mulberry32(seed) });
  match.addPlayer(seat("subject", kingdomId));
  match.addPlayer(seat("foe1", others[0]!));
  match.addPlayer(seat("foe2", others[1]!));
  match.hostId = "subject";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  for (const p of state.getPlayers()) earn(p, 5_000_000);
  return { match, state, me: state.getPlayer("subject")! };
}

/** Unlock an ability, settle the world, then attempt one real cast. */
function attemptCast(kingdomId: KingdomId, ability: AbilityDefinition) {
  const { match, me } = startedMatch(kingdomId);
  const unlock = unlockOrUpgradeAbility(match, me, ability.id);
  assert.ok(unlock.ok, `${kingdomId}: could not unlock ${ability.id} (${unlock.error})`);

  // Let meters charge and charges regenerate before casting.
  for (let t = 1; t <= 900 && match.phase === "active"; t++) tickMatch(match, t);
  assert.equal(match.phase, "active", `${kingdomId}: match ended while settling before ${ability.id}`);

  selectTarget(match, me, "foe1");
  const options: Record<string, unknown> = { targetId: "foe1" };
  if (ability.targeting.secondTarget) options.targetIds = ["foe1", "foe2"];
  if (ability.targeting.choices?.length) options.choice = ability.targeting.choices[0];

  return activateAbility(match, me, ability, options as never);
}

test("every kingdom id has a kit and passives registered", () => {
  assert.equal(KINGDOM_IDS.length, 16, "expected 16 kingdoms — update this test when the roster changes");
  for (const id of KINGDOM_IDS) {
    const kit = KINGDOM_ABILITIES[id];
    assert.ok(kit && kit.length > 0, `${id}: no entry in KINGDOM_ABILITIES`);
    assert.ok(
      KINGDOM_PASSIVES[id] !== undefined,
      `${id}: no entry in KINGDOM_PASSIVES — the engine applies passives generically, so a missing entry silently means "no passives"`,
    );
    const activatable = kit.filter((a) => a.kind !== "passive");
    assert.ok(activatable.length > 0, `${id}: kit has no activatable abilities`);
    assert.ok(
      activatable.some((a) => a.kind === "attack"),
      `${id}: kit has no attack — it cannot win a match`,
    );
  }
});

test("every ability of every kingdom can be cast, or is gated by a known engine rule", () => {
  const gated: string[] = [];
  for (const id of KINGDOM_IDS) {
    for (const ability of KINGDOM_ABILITIES[id].filter((a) => a.kind !== "passive")) {
      const result = attemptCast(id, ability);
      if (result.ok) continue;
      const error = String(result.error ?? "UNKNOWN");
      assert.ok(
        RESOURCE_GATES.has(error),
        `${id}/${ability.id}: cast failed with ${error}. If this is a new legitimate ` +
          `resource gate, add it to RESOURCE_GATES; otherwise the simulator cannot play this kingdom.`,
      );
      gated.push(`${id}/${ability.id}:${error}`);
    }
  }
  // Documents which abilities need built-up match state — informational, not a failure.
  assert.ok(gated.length <= 6, `unexpectedly many resource-gated abilities: ${gated.join(", ")}`);
});

test("every kingdom completes a headless 1v1 and produces valid telemetry", () => {
  for (const id of KINGDOM_IDS) {
    const opponent = id === "water" ? "fire" : "water";
    const result = runSimulation({
      matches: 1,
      seed: `kingdom-coverage-${id}`,
      players: [{ kingdomId: id }, { kingdomId: opponent }],
      maxTicks: 4000,
      telemetry: true,
    });

    const record = result.records[0]!;
    assert.ok(record.telemetry, `${id}: no telemetry produced`);
    const seatTelemetry = record.telemetry.seats.find((s) => s.kingdomId === id);
    assert.ok(seatTelemetry, `${id}: kingdom missing from telemetry seats`);
    assert.equal(record.players.length, 2, `${id}: wrong seat count`);
    assert.ok(record.endedAtTick > 0, `${id}: match recorded zero ticks`);
    // Timeline is sampled from tick 0, so it always carries the opening sample.
    assert.ok(seatTelemetry.timeline.hp.length > 0, `${id}: no HP timeline recorded`);
  }
});

test("every kingdom participates in 4-player and 7-player free-for-alls", () => {
  // Rotating windows over the roster guarantee every kingdom appears in both
  // formats, including alongside the mechanically unusual kingdoms.
  for (let start = 0; start < KINGDOM_IDS.length; start++) {
    for (const size of [4, 7]) {
      const roster = Array.from(
        { length: size },
        (_, i) => KINGDOM_IDS[(start + i) % KINGDOM_IDS.length]!,
      );
      const result = runSimulation({
        matches: 1,
        seed: `ffa-${size}-${start}`,
        players: roster.map((kingdomId) => ({ kingdomId })),
        maxTicks: 3000,
        rotateSeats: true,
        telemetry: true,
      });
      const record = result.records[0]!;
      assert.equal(record.players.length, size, `${size}-FFA @${start}: wrong seat count`);
      assert.equal(
        record.telemetry!.seats.length,
        size,
        `${size}-FFA @${start}: telemetry seat count mismatch`,
      );
      for (const kingdomId of roster) {
        assert.ok(
          record.telemetry!.seats.some((s) => s.kingdomId === kingdomId),
          `${size}-FFA @${start}: ${kingdomId} missing from telemetry`,
        );
      }
    }
  }
});

test("the parameter catalog exposes tunables for every kingdom", async () => {
  const { listParameters } = await import("../src/engine/parameterCatalog.js");
  const ids = listParameters().map((p) => p.id);
  for (const kingdomId of KINGDOM_IDS) {
    const abilityIds = KINGDOM_ABILITIES[kingdomId].map((a) => a.id);
    const covered = abilityIds.some((abilityId) =>
      ids.some((id) => id.startsWith(`ability.${abilityId}.`)),
    );
    assert.ok(
      covered,
      `${kingdomId}: no ability parameters in the catalog — the Balance AI would be unable to tune it`,
    );
  }
});
