import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lowers the price of abilities nobody can afford, until everyone can.
 *
 *   node scripts/pricePass.mjs [stepPct] [maxRounds]
 *
 * The loop, automated:
 *
 *   1. play the validation slate with the best AI
 *   2. list the abilities it OWNS but can never afford to cast
 *   3. cut ONLY those, by one step
 *   4. repeat until the list is empty
 *
 * ⚠️ ONLY THE UNAFFORDABLE ONES. An ability in use keeps its price — a cut it
 * did not need is a balance change nobody asked for. An ability that is
 * DECLINED keeps its price too, and that exclusion matters more: declined means
 * the policy had it available, affordable and ready, and chose something else.
 * Discounting that chases a number downward forever without ever touching the
 * judgement behind it.
 *
 * ⚠️ THE PRICE MOVES, SO THE ANSWER MOVES. Cutting a price changes how the AI
 * spends, which changes what it can afford next round — Water's holdings
 * tracked its own cheapest ability all the way down. So the list is
 * re-measured every round rather than computed once and applied in bulk.
 *
 * Nothing here touches damage, cooldowns or durations. Those are what the
 * balance search is for, once prices are settled and frozen.
 */

const STEP = Number(process.argv[2] ?? 10);
const MAX_ROUNDS = Number(process.argv[3] ?? 12);
const MODEL = "runs/neat/hard.json";
const SERVER_DATA = "../elementals/Server/src/data";

// `shell: true` because Windows resolves `npx` to `npx.cmd`, which spawnSync
// will not find on its own.
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: true,
  });

const state = join(tmpdir(), `price-pass-${process.pid}.json`);

console.log(`PRICE PASS — ${STEP}% per round, at most ${MAX_ROUNDS} rounds\n`);

let round = 0;
let previous = null;

for (; round < MAX_ROUNDS; round++) {
  // 1-2. Measure.
  run("npx", ["tsx", "simulation/src/tools/whyUnused.ts", MODEL, "--json", state]);
  const report = JSON.parse(readFileSync(state, "utf8"));
  const targets = report.cannotAfford;

  console.log(
    `round ${String(round).padStart(2)}  used ${String(report.used).padStart(2)}  ` +
      `idle ${String(report.idle).padStart(2)}  unaffordable ${targets.length}` +
      (targets.length > 0 ? `  -> ${targets.join(", ")}` : ""),
  );

  if (targets.length === 0) {
    console.log(`\nDONE — every owned ability is affordable to cast.`);
    if (report.declined.length > 0) {
      console.log(
        `\n${report.declined.length} still idle, but DECLINED rather than unaffordable:\n  ` +
          report.declined.join("\n  ") +
          `\nThese are the policy's judgement. A price cut cannot reach them; they need\n` +
          `a damage or effect change, which is the balance search's job.`,
      );
    }
    break;
  }

  // A round that changes nothing is a loop that will never end — stop and say
  // so rather than burning the remaining budget on the same list.
  const signature = targets.slice().sort().join(",");
  if (signature === previous?.signature && targets.length === previous.count) {
    previous.stuck += 1;
    if (previous.stuck >= 3) {
      console.log(
        `\nSTOPPED — the same ${targets.length} abilities have resisted three rounds of cuts.\n` +
          `Their holdings are probably tracking their own price downward, which no\n` +
          `further discount fixes. Worth looking at those kingdoms' income instead.`,
      );
      break;
    }
  } else {
    previous = { signature, count: targets.length, stuck: 0 };
  }

  // 3. Cut, in both repos so the game and the lab never disagree.
  const out = run("node", [
    join(SERVER_DATA, "../../scripts/cutAbilityCost.mjs"),
    SERVER_DATA,
    String(STEP),
    ...targets,
  ]);
  for (const line of out.split("\n").filter((l) => l.trim().startsWith("cost") || /->/.test(l))) {
    if (line.trim()) console.log(`         ${line.trim()}`);
  }
  // Mirror every ability file, so the game and the lab never disagree about a
  // price. Copied through node rather than a shell so this runs the same way
  // on Windows and on Kaggle's Linux image.
  for (const file of readdirSync(SERVER_DATA).filter((f) => f.endsWith("Abilities.ts"))) {
    copyFileSync(join(SERVER_DATA, file), join("src/data", file));
  }
}

if (round >= MAX_ROUNDS) {
  console.log(`\nSTOPPED — hit the ${MAX_ROUNDS}-round limit with work still to do.`);
}
rmSync(state, { force: true });
