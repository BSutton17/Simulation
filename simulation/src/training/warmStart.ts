import { readFileSync } from "node:fs";
import { NeatRng, addConnection, cloneGenome, mutate, type Genome, type NeatConfig } from "../neat/index.js";
import { InnovationRegistry } from "../neat/index.js";
import { ACTION_SIZE, OBSERVATION_SIZE } from "../ai/index.js";
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
export function growInputs(genome: Genome, registry: InnovationRegistry): Genome {
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
  const added: number[] = [];
  for (let i = 0; i < missing; i++) {
    // Inputs carry an activation like any node; it is never applied to them
    // (an input IS its value), but the shape must be well formed.
    grown.nodes.push({ id: nextId + i, type: "input", activation: "identity" });
    added.push(nextId + i);
  }

  // ⚠️ WIRED AT ZERO, BECAUSE UNWIRED IS UNREACHABLE.
  //
  // Leaving the new inputs with no edges at all preserves behaviour perfectly
  // — and makes them invisible to evolution. Measured over a 300-generation
  // run: the three threat inputs had ZERO outgoing connections in both the
  // starting genome and the final champion. NEAT adds a connection by picking
  // endpoints at random, so on a warm-started genome carrying 637 of them the
  // odds of landing on one specific new input, and of that random edge helping
  // enough to survive selection, are negligible. The AI stood under Light Show
  // and Old Friends and died because nothing connected "a strike is coming" to
  // the buy-shield head — which was itself well wired, with 27 incoming edges.
  //
  // A weight of EXACTLY ZERO contributes exactly nothing, so the migrated
  // genome still computes precisely what it computed before, which is the
  // property that makes a warm start safe. What changes is that the gene now
  // EXISTS, so ordinary weight mutation can move it off zero and selection can
  // judge it. The search no longer has to invent the connection before it can
  // begin tuning it.
  if (added.length > 0) {
    const outputs = grown.nodes.filter((n) => n.type === "output").map((n) => n.id);
    for (const from of added) {
      for (const to of outputs) {
        addConnection(grown, {
          innovation: registry.connection(from, to),
          from,
          to,
          weight: 0,
          enabled: true,
        });
      }
    }
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
/**
 * Adds output nodes up to `ACTION_SIZE`, wiring none of them.
 *
 * ⚠️ THE ACTION SPACE GROWS TOO, and only inputs were being migrated. A
 * genome trained against 25 heads dropped into a 28-head space keeps its 25 and
 * simply has no node for the rest, so the new heads read whatever was left in
 * the output buffer. They would never fire, never vary, and never be selected
 * for — the warm start would silently guarantee the new behaviour could not be
 * learned, which is the opposite of what warm starting is for.
 *
 * Unconnected outputs are safe for the same reason unconnected inputs are: an
 * output with no incoming edge is a constant, so every head the genome already
 * had computes exactly what it computed before. Evolution wires the new ones in
 * when they start earning their place.
 */
export function growOutputs(genome: Genome): Genome {
  const outputs = genome.nodes.filter((n) => n.type === "output");
  const missing = ACTION_SIZE - outputs.length;
  if (missing < 0) {
    throw new Error(
      `genome ${genome.id} has ${outputs.length} outputs but the action space is ` +
        `${ACTION_SIZE} — it was trained on a WIDER action space and cannot be narrowed`,
    );
  }
  if (missing === 0) return cloneGenome(genome);

  const grown = cloneGenome(genome);
  const nextId = Math.max(...grown.nodes.map((n) => n.id)) + 1;
  for (let i = 0; i < missing; i++) {
    grown.nodes.push({ id: nextId + i, type: "output", activation: "identity" });
  }
  return grown;
}

export function migrateSeeds(from: string | Genome, also: readonly Genome[] = []): Genome[] {
  const source =
    typeof from === "string"
      ? ((JSON.parse(readFileSync(from, "utf8")) as AiModel).genome as Genome)
      : from;
  const sources: Genome[] = [source, ...also];
  // One registry across every seed, so the same new edge gets the same
  // innovation number in all of them — otherwise crossover would treat
  // identical connections as unrelated genes.
  //
  // Started PAST everything the sources already use, so a freshly minted
  // innovation can never collide with a historical marking the trained genomes
  // are still carrying.
  const maxNode = Math.max(...sources.flatMap((g) => g.nodes.map((n) => n.id)));
  const maxInnovation = Math.max(
    0,
    ...sources.flatMap((g) => g.connections.map((c) => c.innovation)),
  );
  const registry = new InnovationRegistry(maxNode + 1 + OBSERVATION_SIZE, maxInnovation + 1);
  // ⚠️ OUTPUTS FIRST. `growInputs` wires each new input to every output that
  // exists when it runs, so growing inputs first left the three new heads
  // unreachable from the three new inputs — the exact pairing this is for.
  return sources.map((g) => growInputs(growOutputs(g), registry));
}
