import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSchema, searchable, baseVector, vectorToParameters, candidateHash,
} from "../simulation/src/search/index.js";
import { listParameters } from "../src/engine/parameterCatalog.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * The expanded (v2) search space.
 *
 * v1 searched 20 passive and system dials and no ability parameters at all.
 * v2 searches abilities only: damage, cooldown and cost for attacks; duration,
 * cost and cooldown for utilities; cooldown and cost for ultimates. 180
 * dimensions — 181 until balance v4 dropped Poison Apple's permanent-duration
 * sentinel, a dial whose every value means the same thing. v1's twenty passive and system dials are held still, so anything
 * the search finds is attributable to the abilities.
 */

const v1 = buildSchema({ scope: "curated" });
const v2 = buildSchema({ scope: "expanded" });

test("v1 is preserved exactly, so the completed experiment stays reproducible", () => {
  assert.equal(v1.version, "v1");
  assert.equal(searchable(v1).length, 20);
  const ids = searchable(v1).map((x) => x.id);
  assert.ok(ids.includes("castle.repairCost") && ids.includes("shield.cost"));
  assert.equal(ids.filter((id) => id.startsWith("passive.")).length, 16);
});

test("v2 searches abilities and nothing else", () => {
  // v1's passives and global levers are held still here, so anything the search
  // finds is attributable to the abilities rather than to a passive moving
  // underneath them. Those twenty are a separate experiment for later.
  const nonAbility = searchable(v2).filter((x) => !x.id.startsWith("ability."));
  assert.deepEqual(nonAbility.map((x) => x.id), [], "v2 should contain only ability dials");

  // Named explicitly so an accidental re-addition fails loudly rather than
  // quietly changing what the experiment measures.
  for (const id of ["castle.repairCost", "castle.repairAmount", "shield.cost",
                    "combat.baseCritChance", "passive.nature.0.pct", "passive.dark.0.chance"]) {
    assert.ok(!searchable(v2).some((x) => x.id === id), `${id} should not be searched in v2`);
  }
});

test("the two scopes cannot be confused for one another", () => {
  // The schema version is part of the checkpoint identity and the candidate
  // hash, so a v1 checkpoint can never silently resume a v2 run.
  assert.equal(v2.version, "v2");
  assert.notEqual(v1.version, v2.version);
  assert.notEqual(candidateHash(v1, { "shield.cost": 400 }), candidateHash(v2, { "shield.cost": 400 }));
});

test("each ability kind contributes exactly the dials it was asked for", () => {
  const dials = searchable(v2).filter((x) => x.id.startsWith("ability."));
  const by = (c: string) => dials.filter((x) => x.category === c);
  assert.equal(by("abilityAttack").length, 126, "attack: damage, cooldown, cost");
  // 30, not 31: Poison Apple is a utility, and its permanent-duration sentinel
  // was the dial balance v4 removed.
  assert.equal(by("abilityUtility").length, 30, "utility: duration, cost, cooldown");
  assert.equal(by("abilityUltimate").length, 24, "ultimate: cooldown, cost");
  assert.equal(dials.length, 180);
  assert.equal(searchable(v2).length, 180, "v2 is ability dials only");

  // Ultimates are priced and paced but their payload is left alone.
  for (const dial of by("abilityUltimate")) {
    assert.ok(
      dial.id.endsWith(".cooldownTicks") || dial.id.endsWith(".cost"),
      `${dial.id} is not a cooldown or a cost`,
    );
  }
  // Every kingdom is represented.
  const kingdoms = new Set(dials.map((x) => x.description.split(":")[0]));
  assert.equal(kingdoms.size, KINGDOM_IDS.length, "a kingdom has no searchable ability");
});

test("no dimension is dead on arrival", () => {
  // A zero base has no multiplicative room, so a percentage bound around it
  // cannot move. Electricity's lightningBarrage is the live example — damage 0,
  // cooldown 0 — and it must have been skipped in favour of a usable ability.
  for (const p of searchable(v2)) {
    assert.ok(p.max > p.min, `${p.id} has an empty interval`);
    if (p.id.startsWith("ability.")) {
      assert.notEqual(p.base, 0, `${p.id} has a zero base and cannot be searched`);
    }
  }
  // lightningBarrage has damage 0 and cooldown 0, so those two dials must have
  // been skipped. Its cost is non-zero and may legitimately appear.
  for (const id of ["ability.lightningBarrage.effects.0.amount", "ability.lightningBarrage.cooldownTicks"]) {
    assert.ok(!searchable(v2).some((x) => x.id === id), `${id} has a zero base and cannot move`);
  }
});

test("abilities the AI never casts are not given dimensions", () => {
  // Measured at 68/80 coverage. Tuning an ability nobody uses spends
  // evaluations discovering that its own axis is flat.
  const neverCast = [
    "birdsEyeView", "neverEndingNightmare", "unlimitedRage", "yinAndYang",
    "blazingDetermination", "creepyCrawlers", "flashBang", "bffs", "empathy",
    "loveGalore", "orionsBeltAbility", "backToTheFuture",
  ];
  for (const id of neverCast) {
    assert.ok(
      !searchable(v2).some((p) => p.id.startsWith(`ability.${id}.`)),
      `${id} is never cast but was given a search dimension`,
    );
  }
});

test("every searched parameter is one the engine actually exposes", () => {
  const catalog = new Map(listParameters().map((p) => [p.id, p.base]));
  for (const p of searchable(v2)) {
    assert.ok(catalog.has(p.id), `${p.id} is not in the engine catalog`);
    assert.equal(p.base, catalog.get(p.id), `${p.id} base drifted from the catalog`);
  }
});

test("decoding always produces a legal game configuration", () => {
  const params = searchable(v2);
  // Sweep the whole unit cube, including both corners, rather than one sample.
  for (const unit of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
    const decoded = vectorToParameters(v2, new Array(params.length).fill(unit));
    for (const p of params) {
      const value = decoded[p.id]!;
      assert.ok(value >= p.min - 1e-9 && value <= p.max + 1e-9, `${p.id}=${value} escaped its bounds`);
      if (p.type === "integer") assert.ok(Number.isInteger(value), `${p.id}=${value} is not an integer`);
      // A zero or negative cooldown would let an ability fire every tick.
      if (p.id.endsWith("cooldownTicks")) assert.ok(value >= 1, `${p.id} reached ${value}`);
      // Damage must stay positive; a negative amount would heal the target.
      if (p.id.endsWith("effects.0.amount")) assert.ok(value > 0, `${p.id} reached ${value}`);
    }
  }
});

test("changing an ability parameter changes the candidate identity", () => {
  // If it did not, the cache would serve one candidate's score for another's.
  const dial = searchable(v2).find((p) => p.id.startsWith("ability."))!;
  const a = vectorToParameters(v2, baseVector(v2));
  const b = { ...a, [dial.id]: a[dial.id]! * 1.1 };
  assert.notEqual(candidateHash(v2, a), candidateHash(v2, b));
});

test("the dimension count is pinned, because compute scales with it", () => {
  // Not a ceiling — the designer chose this set deliberately. It is pinned so
  // the schema cannot grow by accident, since every added dimension raises the
  // number of generations needed to make use of it.
  //
  // At Kaggle's measured 5.41 match/s: lambda 19, 1.91 h per generation, and
  // roughly 10 evaluations per dimension needs ~104 generations, about 198
  // hours. That is a deliberate cost, not an oversight.
  const dims = searchable(v2).length;
  assert.equal(dims, 180, "the expanded schema changed size");
  assert.equal(4 + Math.floor(3 * Math.log(dims)), 19, "population no longer scales as expected");
});
