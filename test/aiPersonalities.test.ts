import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSimulation,
  personalityAI,
  PERSONALITIES,
  AGGRESSIVE,
  DEFENSIVE,
  ECONOMIC,
  OPPORTUNISTIC,
  BALANCED,
  RANDOM,
  mulberry32,
  type PersonalityProfile,
  type GameplayEvent,
  type SimulationObserver,
  type PlayerSpec,
} from "../simulation/src/index.js";
import { PersonalityAI } from "../simulation/src/personality.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { earn } from "../src/engine/money.js";
import { ALL_ABILITIES } from "../src/data/abilitiesRegistry.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { KingdomId } from "../src/data/kingdoms.js";

/**
 * Tickets #205/#206 — the AI decision framework and its personalities.
 *
 * Personalities are measured behaviorally, through the gameplay-event stream
 * (#204), in deterministic seeded matches — never by peeking at internals.
 */

interface SeatMetrics {
  attacks: number;
  ultimates: number;
  citizens: number;
  repairs: number;
  shields: number;
  upgrades: number;
  unlocks: number;
  firstShieldTick: number | null;
  /** Target HP fraction observed at each enemy-targeted ultimate cast. */
  ultimateTargetHpFractions: number[];
}

const emptyMetrics = (): SeatMetrics => ({
  attacks: 0,
  ultimates: 0,
  citizens: 0,
  repairs: 0,
  shields: 0,
  upgrades: 0,
  unlocks: 0,
  firstShieldTick: null,
  ultimateTargetHpFractions: [],
});

/** Runs one seeded match and aggregates per-seat behavior from events. */
function measure(
  seats: PlayerSpec[],
  seed: number | string,
  maxTicks?: number,
) {
  const metrics = new Map<string, SeatMetrics>();
  const at = (id: string) => {
    if (!metrics.has(id)) metrics.set(id, emptyMetrics());
    return metrics.get(id)!;
  };

  const observer: SimulationObserver = {
    onEvent: (e: GameplayEvent, match) => {
      if (e.type === "abilityCast") {
        const kind = ALL_ABILITIES[e.abilityId]?.kind;
        if (kind === "attack") at(e.casterId).attacks++;
        if (kind === "ultimate") {
          const m = at(e.casterId);
          m.ultimates++;
          // Enemy-targeted ultimates: capture the victim's HP fraction at
          // cast time (emission happens after spend, before effects land).
          const ability = ALL_ABILITIES[e.abilityId]!;
          if (ability.targeting.mode !== "self" && ability.targeting.mode !== "noTarget") {
            for (const targetId of e.targetIds) {
              const target = match.gameState!.getPlayer(targetId);
              if (target) {
                m.ultimateTargetHpFractions.push(
                  target.castle.hp / target.castle.maxHp,
                );
              }
            }
          }
        }
      } else if (e.type === "purchase") {
        const m = at(e.playerId);
        if (e.kind === "citizen") m.citizens++;
        if (e.kind === "repair") m.repairs++;
        if (e.kind === "shield") {
          m.shields++;
          m.firstShieldTick ??= e.tick;
        }
        if (e.kind === "upgrade") m.upgrades++;
        if (e.kind === "unlock") m.unlocks++;
      }
    },
  };

  const result = runSimulation({
    matches: 1,
    seed,
    players: seats,
    maxTicks,
    observers: [observer],
  });
  return { record: result.records[0]!, metrics };
}

/** Mirror-match seat pair: personality P vs balanced, same kingdom, so any
 *  behavioral difference comes from the profile alone. */
const versusBalanced = (p: PersonalityProfile, kingdom: KingdomId = "fire"): PlayerSpec[] => [
  { kingdomId: kingdom, ai: personalityAI(p) },
  { kingdomId: kingdom, ai: personalityAI(BALANCED) },
];

// ---------------------------------------------------------------------------
// #205: the framework completes matches through the public gameplay API.
// ---------------------------------------------------------------------------

test("every personality completes a full match against the balanced baseline", () => {
  for (const [name, profile] of Object.entries(PERSONALITIES)) {
    // 25 game-minutes: attrition styles (aggressive vs balanced fire mirror)
    // legitimately take just over the 20-minute default.
    const { record } = measure(versusBalanced(profile), `complete-${name}`, 30_000);
    assert.equal(record.timedOut, false, `${name} match timed out`);
    assert.ok(record.winnerId, `${name} match had no winner`);
  }
});

test("personalities are interchangeable per seat without simulator changes", () => {
  // Three different personalities in ONE match, assigned purely via data.
  const { record } = measure(
    [
      { kingdomId: "fire", ai: personalityAI(AGGRESSIVE) },
      { kingdomId: "water", ai: personalityAI(DEFENSIVE) },
      { kingdomId: "nature", ai: personalityAI(ECONOMIC) },
    ],
    "mixed-lobby",
  );
  assert.equal(record.players.length, 3);
  assert.equal(record.timedOut, false);
});

// ---------------------------------------------------------------------------
// #206: each personality demonstrates its intended behavior.
// ---------------------------------------------------------------------------

/** Equal 3000-tick observation windows for fair behavioral comparison. */
const WINDOW = 3000;

test("aggressive attacks far more than defensive in the same window", () => {
  const a = measure(versusBalanced(AGGRESSIVE), "sig-1", WINDOW);
  const d = measure(versusBalanced(DEFENSIVE), "sig-1", WINDOW);
  const aggressive = a.metrics.get("p0")!;
  const defensive = d.metrics.get("p0")!;
  assert.ok(
    aggressive.attacks > defensive.attacks * 1.5,
    `expected aggression: ${aggressive.attacks} vs ${defensive.attacks}`,
  );
});

test("economic out-invests aggressive in citizens", () => {
  const e = measure(versusBalanced(ECONOMIC), "sig-2", WINDOW);
  const a = measure(versusBalanced(AGGRESSIVE), "sig-2", WINDOW);
  const economic = e.metrics.get("p0")!;
  const aggressive = a.metrics.get("p0")!;
  assert.ok(
    economic.citizens > aggressive.citizens,
    `expected economy focus: ${economic.citizens} vs ${aggressive.citizens}`,
  );
});

test("defensive shields earlier and spends more on protection than aggressive", () => {
  // Shields cost 500g — give the economy room to reach the thresholds.
  const d = measure(versusBalanced(DEFENSIVE), "sig-3", 9000);
  const a = measure(versusBalanced(AGGRESSIVE), "sig-3", 9000);
  const defensive = d.metrics.get("p0")!;
  const aggressive = a.metrics.get("p0")!;

  assert.ok(defensive.shields > 0, "defensive never bought a shield");
  if (aggressive.firstShieldTick !== null) {
    assert.ok(
      defensive.firstShieldTick! < aggressive.firstShieldTick,
      `expected earlier shield: ${defensive.firstShieldTick} vs ${aggressive.firstShieldTick}`,
    );
  }
  assert.ok(
    defensive.shields + defensive.repairs >=
      aggressive.shields + aggressive.repairs,
    "expected more protection spending",
  );
});

test("saver personalities unlock their whole kit and buy upgrades", () => {
  // Balanced prioritizes kit progression before casting, reserving gold for
  // the next unlock/upgrade so attacks cannot starve it.
  const { metrics } = measure(versusBalanced(BALANCED), "sig-4", 15000);
  const balanced = metrics.get("p0")!;
  assert.equal(balanced.unlocks, 5); // the whole kit
  assert.ok(balanced.upgrades > 0, "expected upgrade purchases");
});

test("opportunistic holds enemy-targeted ultimates for the kill window", () => {
  // Ice's ultimate targets enemies (metadata, not names) — perfect for
  // observing the hold-until-weak gate.
  const o = measure(versusBalanced(OPPORTUNISTIC, "ice"), "sig-5");
  const opportunistic = o.metrics.get("p0")!;
  for (const frac of opportunistic.ultimateTargetHpFractions) {
    assert.ok(
      frac <= OPPORTUNISTIC.ultimate.targetHpFraction + 0.01,
      `ultimate fired outside the window (target at ${(frac * 100).toFixed(0)}%)`,
    );
  }
});

test("ultimate timing gates open and close with the target's HP (direct)", () => {
  // A crafted scenario: an ice kingdom with everything unlocked and a rich
  // treasury, judged twice — target at full HP (window closed) and target
  // nearly dead (window open).
  const build = () => {
    const match = new Match("ULTI", { rng: mulberry32(31) });
    match.addPlayer({ id: "a", socketId: null, name: "a", kingdomId: "ice", ready: true, connected: true } as MatchPlayer);
    match.addPlayer({ id: "b", socketId: null, name: "b", kingdomId: "fire", ready: true, connected: true } as MatchPlayer);
    match.hostId = "a";
    match.start(createMatchConfig(match));
    const a = match.gameState!.getPlayer("a")!;
    const b = match.gameState!.getPlayer("b")!;
    earn(a, 100_000);
    for (const ability of Object.keys(ALL_ABILITIES)) a.unlocked[ability] = true;
    const ai = new PersonalityAI(OPPORTUNISTIC, a);
    const events: GameplayEvent[] = [];
    match.gameState!.events.on((e) => events.push(e));
    const ultimates = () =>
      events.filter(
        (e) =>
          e.type === "abilityCast" &&
          ALL_ABILITIES[e.abilityId]?.kind === "ultimate",
      );
    return { match, a, b, ai, ultimates };
  };

  // Target at full HP: several decision rounds, never an ultimate.
  const closed = build();
  for (let round = 1; round <= 3; round++) {
    closed.a.cooldowns = {};
    closed.b.castle.hp = closed.b.castle.maxHp; // hold the target at full
    closed.ai.act({ match: closed.match, player: closed.a, tick: round * 5, rng: mulberry32(1) });
  }
  assert.equal(closed.ultimates().length, 0, "ultimate fired at a full-HP target");

  // Target nearly dead: the window opens on the next decision. A big shield
  // keeps the target alive through this round's damage so the ultimate actually
  // lands — otherwise the AI's (correctly prioritized) lethal attacks eliminate
  // the target first, ending the match before the CC ultimate's turn.
  const open = build();
  open.b.castle.hp = 2_000; // ~24% of Fire's 8500 HP — inside the 35% window
  open.b.castle.shield = 50_000;
  open.ai.act({ match: open.match, player: open.a, tick: 5, rng: mulberry32(1) });
  assert.ok(open.ultimates().length > 0, "ultimate withheld inside the window");
});

test("targeting strategies pick from live state, not names", () => {
  const build = (profile: PersonalityProfile) => {
    const match = new Match("TGT", { rng: mulberry32(9) });
    (["a", "b", "c"] as const).forEach((id, i) => {
      const kingdoms: KingdomId[] = ["fire", "water", "nature"];
      match.addPlayer({ id, socketId: null, name: id, kingdomId: kingdoms[i]!, ready: true, connected: true } as MatchPlayer);
    });
    match.hostId = "a";
    match.start(createMatchConfig(match));
    const state = match.gameState!;
    return { match, a: state.getPlayer("a")!, b: state.getPlayer("b")!, c: state.getPlayer("c")! };
  };

  // lowestHp hunts the damaged castle.
  const low = build(OPPORTUNISTIC);
  low.c.castle.hp = 3_000;
  new PersonalityAI(OPPORTUNISTIC, low.a).act({ match: low.match, player: low.a, tick: 5, rng: mulberry32(2) });
  assert.equal(low.a.target, "c");

  // highestIncome strangles the biggest economy.
  const rich = build(ECONOMIC);
  rich.b.economy.citizens = 30;
  rich.b.economy.incomePerTick = 1;
  new PersonalityAI(ECONOMIC, rich.a).act({ match: rich.match, player: rich.a, tick: 5, rng: mulberry32(2) });
  assert.equal(rich.a.target, "b");
});

// ---------------------------------------------------------------------------
// Value-based casting: the AI ranks casts by metadata-derived value ÷ gold,
// so it reaches for more of its kit than just the cheapest attack, and it
// recognizes setup/combo plays.
// ---------------------------------------------------------------------------

test("value-based casting uses more of the kit than only the cheapest attack", () => {
  // Nature's kit spans a cheap attack, stronger poison attacks, a setup
  // utility, and an ultimate. Ranking by value should reach several of them.
  const cast = new Set<string>();
  runSimulation({
    matches: 4,
    seed: "value-diversity",
    players: [
      { kingdomId: "nature", ai: personalityAI(BALANCED) },
      { kingdomId: "fire", ai: personalityAI(BALANCED) },
    ],
    observers: [
      { onEvent: (e) => { if (e.type === "abilityCast") cast.add(e.abilityId); } },
    ],
  });
  const natureKit = ["sludge", "acidRain", "gastroAcid", "poisonApple", "toxicGas"];
  const used = natureKit.filter((id) => cast.has(id));
  assert.ok(used.length >= 3, `expected value-driven variety, saw: ${used.join(", ")}`);
});

test("value-based casting credits setup/combo plays", () => {
  // Water's Waterfall applies Current, which its other attacks pay off through
  // lifesteal. Without setup value Waterfall is strictly less gold-efficient
  // than Water Ball and would never be cast; the combo credit keeps it in play.
  const water = new Map<string, number>();
  runSimulation({
    matches: 6,
    seed: "combo-setup",
    players: [
      { kingdomId: "water", ai: personalityAI(BALANCED) },
      { kingdomId: "fire", ai: personalityAI(BALANCED) },
    ],
    observers: [
      {
        onEvent: (e, m) => {
          if (e.type !== "abilityCast") return;
          const p = m.gameState!.getPlayer(e.casterId);
          if (p?.kingdomId === "water") water.set(e.abilityId, (water.get(e.abilityId) ?? 0) + 1);
        },
      },
    ],
  });
  assert.ok((water.get("waterfall") ?? 0) > 0, "Water never cast its setup attack Waterfall");
  assert.ok((water.get("waterBall") ?? 0) > 0, "Water never cast its payoff attack Water Ball");
});

test("opportunity cost: patience prioritizes high-impact plays over efficient spam", () => {
  // In a crowded brawl an AoE ultimate is the highest-IMPACT play but not the
  // most gold-EFFICIENT one, so pure-tempo casting (patience 0) lets cheap
  // attacks crowd it out. A patient AI casts its big play first and holds for a
  // near-affordable finisher, so it uses ultimates far more.
  const ultimates = (patience: number) => {
    let n = 0;
    runSimulation({
      matches: 12,
      seed: "impact",
      players: ["water", "nature", "earth", "fire", "air"].map((k) => ({
        kingdomId: k as KingdomId,
        ai: personalityAI({ ...BALANCED, patience }),
      })),
      observers: [
        {
          onEvent: (e) => {
            if (e.type === "abilityCast" && ALL_ABILITIES[e.abilityId]?.kind === "ultimate") n++;
          },
        },
      ],
    });
    return n;
  };
  const patient = ultimates(1);
  const tempo = ultimates(0);
  assert.ok(
    patient > tempo,
    `expected patience to raise ultimate usage: patient ${patient} vs tempo ${tempo}`,
  );
});

test("random personality is chaotic but reproducible", () => {
  const run = (seed: string) => {
    const { record, metrics } = measure(versusBalanced(RANDOM), seed, 9000);
    const m = metrics.get("p0")!;
    return {
      record,
      signature: [record.endedAtTick, m.attacks, m.citizens, m.unlocks],
    };
  };

  // Same seed: identical behavior (chaos flows through the seeded stream).
  assert.deepEqual(run("chaos-1"), run("chaos-1"));
  // Different seeds: the dice land differently.
  assert.notDeepEqual(run("chaos-1").signature, run("chaos-2").signature);
});
