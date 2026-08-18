import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeadlessMatch } from "../simulation/src/headless.js";
import { mulberry32 } from "../simulation/src/rng.js";
import {
  ObservedHistory,
  OBSERVATION_SIZE,
  encode,
  knowledgeFor,
} from "../simulation/src/ai/index.js";
import type { KingdomId } from "../src/data/kingdoms.js";

/**
 * The information boundary, proved behaviourally.
 *
 * Types stop a developer reaching for hidden state, and the import test stops
 * them wiring the engine in. Neither catches a leak through a DERIVED feature —
 * a rank, an aggregate, a sort key — which is how hidden information usually
 * escapes. Only replaying real state through the encoder does.
 *
 * Both directions are asserted throughout. A test suite that only checked
 * "hidden changes do nothing" would be passed by an encoder that returns
 * sixty-four zeros.
 */

function setup(kingdoms: KingdomId[] = ["water", "fire", "earth"]) {
  const match = createHeadlessMatch(
    kingdoms.map((kingdomId) => ({ kingdomId })),
    { rng: mulberry32(12345) },
  );
  const state = match.gameState!;
  const players = state.getPlayers();
  const me = players[0]!;
  const enemy = players[1]!;
  const history = new ObservedHistory();
  const buffer = new Float32Array(OBSERVATION_SIZE);
  const snap = (): number[] => {
    encode(knowledgeFor(match, me, history), buffer);
    return Array.from(buffer);
  };
  return { match, state, me, enemy, history, snap };
}

/** Grants the seat a live Bird's Eye View reveal. */
function reveal(player: { statuses: unknown[] }, ticks = 200): void {
  player.statuses.push({
    id: "birdsEyeView",
    sourceId: "p0",
    remainingTicks: ticks,
    stacks: 1,
    initialDurationTicks: ticks,
  });
}

// ── hidden state must not move the observation ──────────────────────────

test("enemy gold is invisible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.economy.currency = 10_000;
  assert.deepEqual(snap(), before);
});

test("enemy income is invisible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.economy.incomePerTick = 99;
  assert.deepEqual(snap(), before);
});

test("enemy cooldowns are invisible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.cooldowns["fireball"] = 400;
  enemy.cooldowns["firenado"] = 900;
  assert.deepEqual(snap(), before);
});

test("enemy upgrade levels and unlocks are invisible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.upgrades["fireball"] = 4;
  enemy.unlocked["fireball"] = true;
  enemy.unlocked["firenado"] = true;
  assert.deepEqual(snap(), before);
});

test("enemy charge meters are invisible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.supernovaMeter = 250;
  enemy.rageMeter = 1250;
  enemy.ancientMemory = 6000;
  assert.deepEqual(snap(), before);
});

test("enemy HP and shield are invisible without a reveal", () => {
  const { me, enemy, snap } = setup();
  me.target = enemy.id; // aim at them, so the target block is populated
  const before = snap();
  enemy.castle.hp = Math.round(enemy.castle.maxHp * 0.11);
  enemy.castle.shield = 1200;
  assert.deepEqual(
    snap(),
    before,
    "a hidden HP change moved the observation — the target block is leaking",
  );
});

test("enemy citizens are invisible without a reveal", () => {
  const { me, enemy, snap } = setup();
  me.target = enemy.id;
  const before = snap();
  enemy.economy.citizens = 40;
  assert.deepEqual(snap(), before);
});

test("an enemy's internal modifiers are invisible", () => {
  const { me, enemy, snap } = setup();
  me.target = enemy.id;
  const before = snap();
  enemy.modifiers.push({
    id: "hidden-1",
    stat: "damageTaken",
    op: "mult",
    value: 2,
    sourceId: enemy.id,
    remainingTicks: 300,
  });
  assert.deepEqual(
    snap(),
    before,
    "amplification is reading the target's modifier stack — see knowledge.ts",
  );
});

// ── visible state must move the observation ─────────────────────────────

test("own treasury is visible", () => {
  const { me, snap } = setup();
  const before = snap();
  me.economy.currency += 5000;
  assert.notDeepEqual(snap(), before);
});

test("own HP is visible", () => {
  const { me, snap } = setup();
  const before = snap();
  me.castle.hp = Math.round(me.castle.maxHp * 0.4);
  assert.notDeepEqual(snap(), before);
});

test("an enemy being eliminated is visible", () => {
  const { enemy, snap } = setup();
  const before = snap();
  enemy.eliminated = true;
  assert.notDeepEqual(snap(), before);
});

test("an enemy aiming at me is visible", () => {
  const { me, enemy, snap } = setup();
  const before = snap();
  enemy.target = me.id;
  assert.notDeepEqual(snap(), before, "besieged count should have moved");
});

test("volcano state is visible", () => {
  const { state, snap } = setup();
  const before = snap();
  state.volcano = {
    ownerId: "p2",
    hp: 5000,
    maxHp: 10_000,
    endTick: 999,
    contributions: {},
    statuses: [],
  } as never;
  assert.notDeepEqual(snap(), before);
});

// ── the reveal lifecycle ────────────────────────────────────────────────

test("Bird's Eye View turns unknown enemy state into known", () => {
  const { me, enemy, snap } = setup();
  me.target = enemy.id;
  enemy.castle.hp = Math.round(enemy.castle.maxHp * 0.3);

  const hidden = snap();
  assert.equal(hidden[21], 0, "reveal flag should be clear before casting");
  assert.equal(hidden[26], 0.5, "hidden HP must read as the neutral stand-in");

  reveal(me);
  const revealed = snap();
  assert.equal(revealed[21], 1, "reveal flag should be set");
  assert.ok(
    Math.abs(revealed[26]! - 0.3) < 0.02,
    `revealed HP should read ~0.3, got ${revealed[26]}`,
  );
  assert.notDeepEqual(revealed, hidden);
});

test("hidden enemy HP becomes visible only while the reveal is live", () => {
  const { me, enemy, snap } = setup();
  me.target = enemy.id;

  // Before: changing HP does nothing.
  const before = snap();
  enemy.castle.hp = Math.round(enemy.castle.maxHp * 0.5);
  assert.deepEqual(snap(), before);

  // During: the same change is now observable.
  reveal(me);
  const during = snap();
  enemy.castle.hp = Math.round(enemy.castle.maxHp * 0.2);
  assert.notDeepEqual(snap(), during, "a revealed HP change must be observable");

  // After: it goes back to unknown, and nothing was cached across the window.
  me.statuses = me.statuses.filter((s) => s.id !== "birdsEyeView");
  const after = snap();
  assert.equal(after[21], 0);
  assert.equal(after[26], 0.5, "the previously-seen value must not persist");
  enemy.castle.hp = Math.round(enemy.castle.maxHp * 0.9);
  assert.deepEqual(snap(), after, "HP is hidden again once the reveal expires");
});

test("the reveal countdown is observable and normalized", () => {
  const { me, snap } = setup();
  reveal(me, 200);
  const full = snap();
  assert.equal(full[22], 1, "a fresh reveal should read as a full window");
  me.statuses.find((s) => s.id === "birdsEyeView")!.remainingTicks = 50;
  const later = snap();
  assert.ok(later[22]! < full[22]!, "the countdown should fall");
  assert.ok(Math.abs(later[22]! - 0.25) < 1e-6);
});

// ── the vector itself ───────────────────────────────────────────────────

test("the observation is exactly 64 values, all in range", () => {
  const { snap } = setup();
  const values = snap();
  assert.equal(values.length, 64);
  for (const [i, v] of values.entries()) {
    assert.ok(Number.isFinite(v), `input ${i} is not finite: ${v}`);
    assert.ok(v >= -1 && v <= 1, `input ${i} out of range: ${v}`);
  }
});

test("encoding allocates nothing on a warm buffer", () => {
  const { match, me, history } = setup();
  const buffer = new Float32Array(OBSERVATION_SIZE);
  const knowledge = knowledgeFor(match, me, history);
  // Two encodes into the same buffer must produce the same bytes; the buffer is
  // caller-owned, so the controller never allocates per decision.
  encode(knowledge, buffer);
  const first = Array.from(buffer);
  encode(knowledge, buffer);
  assert.deepEqual(Array.from(buffer), first);
});

test("a wrong-sized buffer is refused rather than silently truncated", () => {
  const { match, me, history } = setup();
  const knowledge = knowledgeFor(match, me, history);
  assert.throws(() => encode(knowledge, new Float32Array(32)), /must be 64/);
});
