import { test } from "node:test";
import assert from "node:assert/strict";
import { CombatObserver } from "../simulation/src/training/matchObserver.js";

/**
 * Answering a frozen-income debt is worth something, and worth MORE the sooner
 * it happens.
 *
 * ⚠️ THE CAPABILITY SHIPPED WITH NOTHING PAYING FOR IT. The defensive heads
 * were added and then went completely unused across a 287-generation run —
 * zero promotions — because firing one spends a decision immediately while the
 * payoff, an income that keeps running, is indirect and arrives later. With no
 * term for it the gradient pointed away from defending at every moment. What
 * was missing was this reward, not more generations.
 */

function observe(events: Array<Record<string, unknown>>) {
  const o = new CombatObserver();
  for (const e of events) (o as unknown as { onEvent: (e: never) => void }).onEvent(e as never);
  return (o as unknown as {
    seats: Map<string, { debtsCleared: number; debtPromptness: number }>;
  }).seats;
}

const opened = (tick: number) => ({
  type: "slotMachineOpened", tick, playerId: "p0", sourceId: "p1", abilityId: "slotMachine",
});
const spun = (tick: number) => ({
  type: "slotSpun", tick, playerId: "p0", symbols: [], result: "", revealTick: tick,
});

test("promptness decays with the length of the freeze", () => {
  // The freeze IS the damage the ability does, so paying per answer would score
  // clearing a debt instantly and sitting on it half the match identically.
  const at = (wait: number) => observe([opened(1000), spun(1000 + wait)]).get("p0")!;

  assert.equal(at(0).debtPromptness, 1, "answering at once should pay in full");
  assert.ok(at(40).debtPromptness < at(0).debtPromptness);
  assert.ok(at(100).debtPromptness < at(40).debtPromptness);
  // Past the patience window it is worth nothing — but the debt is still
  // recorded as cleared, because it was.
  assert.equal(at(300).debtPromptness, 0);
  assert.equal(at(300).debtsCleared, 1);
});

test("a debt never answered earns nothing at all", () => {
  const seat = observe([opened(1000)]).get("p0");
  assert.equal(seat?.debtsCleared ?? 0, 0);
  assert.equal(seat?.debtPromptness ?? 0, 0);
});

test("roulette counts the same as the slot machine", () => {
  // Both freeze gold production until answered; nothing about the wheel makes
  // calling a colour a different kind of act from pulling a lever.
  const seats = observe([
    { type: "rouletteOpened", tick: 500, playerId: "p0", sourceId: "p1", abilityId: "roulette" },
    { type: "rouletteSettled", tick: 500, playerId: "p0", pocket: 7, color: "red", bet: "red", result: "", revealTick: 500 },
  ]);
  assert.equal(seats.get("p0")?.debtsCleared, 1);
  assert.equal(seats.get("p0")?.debtPromptness, 1);
});

test("only a crawler that actually dies counts", () => {
  // The swarm keeps draining until a bug is finished off, so a click that
  // merely lands has not stopped anything.
  const killed = observe([{ type: "crawlerSquashed", tick: 1, playerId: "p0", index: 0, killed: true }]);
  const grazed = observe([{ type: "crawlerSquashed", tick: 1, playerId: "p0", index: 0, killed: false }]);
  assert.equal(killed.get("p0")?.debtsCleared, 1);
  assert.equal(grazed.get("p0")?.debtsCleared ?? 0, 0);
});
