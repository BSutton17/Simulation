import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Copies runtime assets into the compiled output.
 *
 * `tsc` emits JavaScript and nothing else. Any file the code reads at RUNTIME
 * rather than imports has to be placed beside the emitted modules, or the
 * compiled build silently behaves differently from the TypeScript one.
 *
 * That is not hypothetical. `engine-source.json` records which engine commit
 * this repository vendors, and provenance resolves it relative to its own
 * module. Under tsx that found the marker; under `dist/` it found nothing and
 * fell back to `git rev-parse HEAD` — so every reading was stamped with the
 * SIMULATION repository's commit instead of the engine's.
 *
 * The effect was that any commit here at all — a README fix, a launcher tweak —
 * changed the recorded engine identity and made the checkpoint guard refuse to
 * resume a perfectly valid multi-session run. It cost a production session at
 * generation 1 before anyone noticed, because the guard's refusal looked
 * exactly like the guard working correctly.
 */

const ASSETS = [
  {
    from: "simulation/engine-source.json",
    to: "dist/simulation/engine-source.json",
    why: "engine identity for provenance",
    required: true,
  },
];

let copied = 0;
for (const asset of ASSETS) {
  if (!existsSync(asset.from)) {
    if (asset.required) {
      console.error(`missing required asset: ${asset.from} (${asset.why})`);
      process.exit(1);
    }
    continue;
  }
  mkdirSync(dirname(asset.to), { recursive: true });
  copyFileSync(asset.from, asset.to);
  console.log(`  ${asset.from} -> ${asset.to}`);
  copied += 1;
}

console.log(`copied ${copied} runtime asset${copied === 1 ? "" : "s"} into dist`);
