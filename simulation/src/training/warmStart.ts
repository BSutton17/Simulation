import { readFileSync } from "node:fs";
import { NeatRng, cloneGenome, mutate, type Genome, type NeatConfig } from "../neat/index.js";
import { InnovationRegistry } from "../neat/index.js";
import { OBSERVATION_SIZE } from "../ai/index.js";
import type { AiModel } from "../ai/index.js";

/**
 * Continuing a run rather than restarting one.
 *
 * A fresh population throws away every generation already paid for. The V1
 * champion took 1,140 rounds to find and beats each shipped heuristic roughly
 * threefold; starting from scratch would spend hours rediscovering that before
 * making any new progress at all.
 *
 * ⚠️ THE OBSERVATION GREW, and this is what makes the warm start possible
 * anyway. A genome's inputs are just nodes; adding more with NO connections
 * leaves the network computing exactly what it computed before, because an
 * unconnected input contributes to nothing. Verified over 200 random probes
 * with noise in the new slots: 200 identical outputs, 0 differed.
 *
 * So the champion arrives intact and simply GAINS the capacity to condition on
 * which kingdom it is playing. Evolution wires the new inputs in when they earn
 * their place, which is precisely what complexification is for.
 */

/** Adds input nodes up to `OBSERVATION_SIZE`, wiring none of them. */
export function growInputs(genome: Genome): Genome {
  const inputs = genome.nodes.filter((n) => n.type === "input");
  const missing = OBSERVATION_SIZE - inputs.length;
  if (missing < 0) {
    throw new Error(
      `genome ${genome.id} has ${inputs.length} inputs but the observation is ` +
        `${OBSERVATION_SIZE} — it was trained on a WIDER schema and cannot be narrowed`,
    );
  }
  if (missing === 0) return cloneGenome(genome);

  const grown = cloneGenome(genome);
  // Ids continue past the highest in use, so nothing collides with an existing
  // hidden or output node. `buildNetwork` sorts input ids, so the new ones land
  // at the end — matching the observation indices they represent.
  const nextId = Math.max(...grown.nodes.map((n) => n.id)) + 1;
  for (let i = 0; i < missing; i++) {
    // Inputs carry an activation like any node; it is never applied to them
    // (an input IS its value), but the shape must be well formed.
    grown.nodes.push({ id: nextId + i, type: "input", activation: "identity" });
  }
  return grown;
}

/**
 * Migrates trained genomes onto the current observation, ready to seed a run.
 *
 * Deliberately does NOT diversify: `Population` owns that, and doing it in both
 * places produced twelve seeds that `Population` then treated as twelve
 * pre-made genomes and mutated none of them.
 */
export function migrateSeeds(from: string | Genome, also: readonly Genome[] = []): Genome[] {
  const source =
    typeof from === "string"
      ? ((JSON.parse(readFileSync(from, "utf8")) as AiModel).genome as Genome)
      : from;
  const sources: Genome[] = [source, ...also];
  return sources.map((g) => growInputs(g));
}
