import { ACTION_SIZE } from "./actions.js";
import { OBSERVATION_SIZE } from "./observation.js";
import type { Rng } from "../rng.js";

/**
 * The network interface the runtime depends on.
 *
 * Deliberately the smallest thing that could work. The controller must not know
 * whether its network came from NEAT, from a random draw, from a hand-built
 * fixture, or from a file — and NEAT, when it arrives, must not need to know
 * anything about `PlayerState`. This interface is the whole contract between
 * those two worlds, and it mentions neither.
 *
 * `activate` writes into a caller-owned buffer rather than returning an array,
 * for the same reason the encoder does: it runs several thousand times per seat
 * per match, and the AI is already the dominant cost in a simulated match.
 */
export interface Network {
  readonly inputSize: number;
  readonly outputSize: number;
  /** Reads `inputs`, writes `outputs`. Must be deterministic and pure. */
  activate(inputs: Float32Array, outputs: Float32Array): void;
}

/**
 * A dense single-layer network — the Phase 1 stand-in.
 *
 * This is NOT NEAT and is not a step toward it. NEAT will supply its own
 * `Network` implementation compiled from a genome, with evolved topology; this
 * exists only so the runtime pipeline can be exercised end to end, in real
 * matches, before any evolutionary code exists. Its job is to prove the plumbing
 * carries current, not to play well.
 */
export class DenseNetwork implements Network {
  readonly inputSize: number;
  readonly outputSize: number;
  /** Row-major, `outputSize × inputSize`. */
  private readonly weights: Float32Array;
  private readonly bias: Float32Array;

  constructor(inputSize: number, outputSize: number, weights: Float32Array, bias: Float32Array) {
    if (weights.length !== inputSize * outputSize) {
      throw new Error(
        `weights must be ${inputSize * outputSize} (${outputSize}×${inputSize}), got ${weights.length}`,
      );
    }
    if (bias.length !== outputSize) {
      throw new Error(`bias must be ${outputSize}, got ${bias.length}`);
    }
    this.inputSize = inputSize;
    this.outputSize = outputSize;
    this.weights = weights;
    this.bias = bias;
  }

  activate(inputs: Float32Array, outputs: Float32Array): void {
    if (inputs.length !== this.inputSize) {
      throw new Error(`inputs must be ${this.inputSize}, got ${inputs.length}`);
    }
    if (outputs.length !== this.outputSize) {
      throw new Error(`outputs must be ${this.outputSize}, got ${outputs.length}`);
    }
    for (let o = 0; o < this.outputSize; o++) {
      let sum = this.bias[o]!;
      const row = o * this.inputSize;
      for (let i = 0; i < this.inputSize; i++) {
        sum += this.weights[row + i]! * inputs[i]!;
      }
      outputs[o] = Math.tanh(sum);
    }
  }
}

/**
 * A network with weights drawn from a seeded stream.
 *
 * Seeded, so a "random" controller still replays identically — the simulator's
 * determinism guarantee has to survive the AI being random, or none of the
 * runtime tests below it mean anything.
 */
export function randomNetwork(
  rng: Rng,
  inputSize: number = OBSERVATION_SIZE,
  outputSize: number = ACTION_SIZE,
): DenseNetwork {
  const weights = new Float32Array(inputSize * outputSize);
  for (let i = 0; i < weights.length; i++) weights[i] = rng() * 2 - 1;
  const bias = new Float32Array(outputSize);
  for (let i = 0; i < bias.length; i++) bias[i] = rng() * 2 - 1;
  return new DenseNetwork(inputSize, outputSize, weights, bias);
}
