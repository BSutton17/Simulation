import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findByExtension } from "../scripts/lib/findFiles.mjs";

/**
 * The training layer must not become an information side channel.
 *
 * The boundary constrains what a PLAYER may know while deciding. A trainer
 * measuring a finished match is not cheating — a coach reviewing a replay is
 * not cheating either — but a trainer that reached into live match state and
 * fed it to the network would be, and the damage would be invisible: fitness
 * would keep climbing while the policy learned to exploit information no human
 * can see, and only a human playing the shipped bot would ever notice.
 *
 * `neatBoundary.test.ts` guards the layering (neat/ imports nothing). This
 * guards the direction of information flow across it.
 */

function sources(dir: string): { name: string; text: string }[] {
  return findByExtension(dir, ".ts").map((path: string) => ({
    name: path.replace(/\\/g, "/").split("/").pop()!,
    text: readFileSync(path, "utf8"),
  }));
}

function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"));
}

function importLines(text: string): string[] {
  return text.split("\n").filter((line) => /^\s*(import|export)\s.*\sfrom\s+"/.test(line));
}

test("training never builds an observation itself", () => {
  // `encode` and `knowledgeFor` are the observation path, and they belong to the
  // controller. Training hands over a Network and stays out of it; calling
  // either here would mean the trainer had decided what the network sees.
  const offenders: string[] = [];
  for (const file of sources("simulation/src/training")) {
    for (const line of codeLines(file.text)) {
      if (/\b(encode|knowledgeFor)\s*\(/.test(line)) offenders.push(`${file.name}: ${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "training constructed an observation — that is the controller's job",
  );
});

test("training never reads hidden player state", () => {
  // The fields the visibility rule calls "never": an enemy's treasury, their
  // cooldowns, their castle internals. Training reads MatchRecord outcomes and
  // the event stream, both of which describe what happened rather than what a
  // seat could see mid-decision.
  const forbidden = /\.economy\.currency|\.cooldowns\[|\.supernovaMeter|\.rageMeter|\.ancientMemory|\.unlocked\[/;
  const offenders: string[] = [];
  for (const file of sources("simulation/src/training")) {
    for (const line of codeLines(file.text)) {
      if (forbidden.test(line)) offenders.push(`${file.name}: ${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("training does not import the knowledge or observation modules", () => {
  const offenders: string[] = [];
  for (const file of sources("simulation/src/training")) {
    for (const line of importLines(file.text)) {
      if (/ai\/(knowledge|observation|visibility)\.js/.test(line)) {
        offenders.push(`${file.name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "training reached for the observation layer directly",
  );
});

test("the AI runtime never imports the training layer", () => {
  // The runtime has to stay usable with any network — a fixture, a random draw,
  // a loaded model — so it cannot depend on the thing that trains one.
  const offenders: string[] = [];
  for (const file of sources("simulation/src/ai")) {
    for (const line of importLines(file.text)) {
      if (/training\//.test(line)) offenders.push(`${file.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the combat observer reads events, not player objects", () => {
  // It exists to measure damage dealt and received, which telemetry cannot
  // report per victim. That is a legitimate training-side measurement — but it
  // must stay on the event stream rather than inspecting seats.
  const file = sources("simulation/src/training").find((f) => f.name === "matchObserver.ts");
  assert.ok(file, "matchObserver.ts is missing");
  for (const line of codeLines(file.text)) {
    assert.ok(
      !/getPlayers\(\)|gameState|PlayerState/.test(line),
      `matchObserver reached into match state: ${line}`,
    );
  }
});
