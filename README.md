# Simulation

Headless balance simulation and CMA-ES balance search for **Elementals**.

This repository runs the real game engine with no server, no sockets and no
rendering, plays thousands of AI-vs-AI matches, scores how balanced the
resulting game is, and searches for parameter values that score better. It is
built to run unattended on a hosted runner such as Kaggle.

**It never changes the game.** The output is a candidate parameter set plus the
evidence behind it. Applying one is a deliberate human act.

## Quick start

```bash
npm install
npm test              # 70 test files
npm run test:list     # show exactly which files will run
npm run typecheck
npm run smoke         # one generation, ~15 min, proves the pipeline works
```

`npm test` runs `scripts/test.mjs`, which discovers test files in Node rather
than in a shell glob. That is not incidental: `--test "test/**/*.test.ts"`
means different things depending on who expands the pattern — bash expands it
before Node sees it, cmd.exe does not expand it at all, and Node's own glob
handling varies by version. On Windows that combination spawned eleven child
processes and hung without reporting a single test. Passing explicit paths
removes the shell from the question, so the command behaves identically on
Kaggle's Linux image and on Windows.

A real search:

```bash
npm run search -- --generations 40 --population 8 --hours 8 --out runs/search
```

## Kaggle

Two launchers, deliberately separate files rather than one file with a mode
flag — a flag can be left in the wrong position, a file cannot be run by
accident. Paste either into a notebook cell with **Internet ON**.

| | | |
|---|---|---|
| `kaggle/kaggle_smoke.py` | **Smoke test.** Proves the pipeline executes. | ~60–95 min |
| `kaggle/kaggle_notebook.py` | **The real run.** 40 generations, population 8. | up to 8 h |

**Run the smoke test first.** It runs 1 generation at population 2, then
re-runs with 2 generations against the same output directory to prove the
search resumes from its checkpoint rather than restarting. It then checks every
artifact and prints a pass/fail checklist.

It costs ~16,500 matches, and that is the floor rather than a choice. The
evaluation tiers are fixed constants because they are what make a reading mean
anything, so the baseline's screen and full evaluations (7,416 matches) are
unavoidable no matter how small the population. `VALIDATE = 0` matters most:
the validation tier is 21,816 matches and runs for both the baseline and the
elite, which would add several hours while proving nothing the rest of the path
has not already proven.

Both passes have been run end to end on Node 20.19.0: pass 1 took 34.8 minutes
for 16,488 matches with zero failures, and pass 2 resumed from the checkpoint
(reusing 5 cached evaluations) and cost only the new generation. Kaggle's four
cores are slower than the twelve this was measured on, hence the wider range
above.

`test/kaggleRunners.test.ts` fails if the production configuration drifts, if
the smoke test grows, or if either launcher stops driving the one CLI.

### Surviving a lost session

`/kaggle/working` belongs to a **session**, not to a notebook. Closing the tab
or being handed a new Draft Session gives you a fresh, empty one. A checkpoint
written there is safe from interruption *within* a session and gone the moment
the session is — which is exactly how a completed generation was lost.

`kaggle/checkpoint_store.py` persists the checkpoint to a **Kaggle Dataset**
via the Kaggle API, generation by generation. Of the three mechanisms Kaggle
offers, it is the only one that persists *during* a session: "Save Version"
only captures state when a batch run ends, and manual download depends on
somebody being awake at the right moment.

**One-time setup** (about five minutes):

1. On kaggle.com: **Settings → API → Create New Token**. A `kaggle.json`
   downloads containing a username and a key.
2. In your notebook: **Add-ons → Secrets → Add a new secret**, twice —
   `KAGGLE_USERNAME` and `KAGGLE_KEY`, using the values from that file.
   Attach both secrets to the notebook.
3. Delete the downloaded `kaggle.json`. It is never needed again, and it must
   never be committed — `test/kagglePersistence.test.ts` fails if one appears
   in the repository.

The store then creates a dataset (once) and adds a version after each
generation. A new session pulls the newest version and resumes.

Two guards prevent the obvious ways this goes wrong. A push is refused if the
dataset already holds **more** finished work, so a resumed session that crashes
early cannot overwrite good progress with its stale copy; comparison is by
generations and stage, never by timestamp, because two sessions can overlap. A
pull is refused if the stored checkpoint belongs to a **different run**, so an
unrelated experiment cannot be spliced into this one.

**What is tested and what is not.** `kaggle/test_checkpoint_store.py` runs the
real store against an emulated Kaggle CLI — same subcommands, flags, and
zip/unzip round trip — reproducing the session-loss failure and checking the
checkpoint returns byte-for-byte with its CMA-ES state, RNG state and all
twelve identity fields intact. 28 assertions, run as part of `npm test`.

It does **not** prove Kaggle's servers behave that way. Authentication, quotas,
dataset visibility and version propagation can only be checked on Kaggle. Before
trusting a multi-session run, do this once by hand: run the smoke test, confirm
a dataset version appears under your account, then open a **new** session and
confirm it resumes rather than starting over.

## Worker count

```bash
npm run build
npm run bench:workers -- --counts 1,2,3,4,6,8 --repeats 3
```

Reports matches/sec, speedup, efficiency and memory per worker count, and
verifies outcomes are **identical** across all of them — a worker count that
were faster but changed results would be worthless.

Measured on a 12-logical-core development box, throughput was flat past three
workers: 3 gave 28.8 match/s, 4 gave 30.4, 6 gave 31.0 and 8 gave 28.6. Two
repeats proved too few — one pass produced 10.5 match/s at six workers against
31.0 on the next — so **use `--repeats 3` or more**, and ignore any single row.

These numbers describe that machine. Kaggle has four logical cores, and the
production runner uses `cpu_count() - 1`. Run the benchmark on Kaggle before
changing that; do not copy the local answer.

A Kaggle session is killed on a hard clock — 9h interactive, 12h committed. Two
things make that survivable:

- The search **checkpoints after every generation**, atomically. A session that
  dies without warning loses at most the generation in flight.
- `--hours` makes it **stop itself at a generation boundary** with time left to
  write its artifacts, rather than being cut off mid-evaluation.

To continue across sessions, download `checkpoint.json`, add it as a Kaggle
Dataset, and point `RESUME_FROM` at it. A resumed run must match the original
in engine, schema, fitness version, seed, population and sigma — otherwise the
checkpoint is refused, by design. Splicing two different searches together and
presenting the result as one is a worse failure than starting over.

## What is in here

| Path | |
|---|---|
| `src/data`, `src/engine`, `src/match` | The game engine, vendored from upstream. **Do not edit here** — see below. |
| `simulation/src` | Headless runner, AI controllers, evaluation, fitness, CMA-ES search. |
| `simulation/src/evaluation` | Plans and runs matches across a worker pool; reports rates with Wilson intervals. |
| `simulation/src/fitness` | Turns a reading into a score. The only place that judges. |
| `simulation/src/search` | Parameter schema, CMA-ES, checkpointing, the search loop. |
| `test` | 70 test files covering the engine and the simulator. |
| `scripts/test.mjs` | Cross-platform test discovery and runner. |

## Which tests live here, and which do not

This repository holds the tests that exercise the **engine, the simulation and
the balance pipeline**. The 21 tests that exercise the **transport layer**
belong to the production Server repository and are deliberately absent — they
cannot pass here, and adding Socket.IO to make them pass would destroy the
property that lets this repo run on a bare cloud runner.

The split is derived, not hand-maintained. `simulation/tools/exportRepo.mjs`
upstream classifies every test by four checks, and `test/boundary.test.ts` here
re-asserts the result on every run:

| Excluded because | Count | Tests |
|---|---:|---|
| Imports `src/net` (transport modules) | 9 | `abilityCosts`, `economyIntegration`, `gameEventsTransport`, `gameLoop`, `matchManager`, `newKingdomPassives`, `placeholderKingdoms`, `reconnectionManager`, `roomCode` |
| Needs `socket.io-client` and boots the server | 8 | `disconnect`, `gameSync`, `lobby`, `matchBuy`, `matchTarget`, `session`, `startup`, `stress` |
| Boots the production server (`src/index.ts`) | 1 | `health` |
| Imports server config or logging (`src/config`, `src/util`) | 3 | `config`, `errorHandling`, `logging` |

**21 excluded, 69 exported, plus the boundary guard = 70 files here.** Several
tests fail more than one check; each is counted once, under its primary reason.

Three of those categories are invisible to ordinary import analysis, which is
why the first export shipped them by mistake:

- `import { io } from "socket.io-client"` has **no relative dependency** on the
  transport layer at all, so a walker following only `./` specifiers waves it
  through.
- `test/helpers/server.ts` imports nothing but `node:child_process`, then
  **spawns** `src/index.ts`.
- `config.test.ts` names its fixture by **string path**, so no dependency graph
  could see it and the fixture stayed behind while the test travelled.

### The engine is vendored, not owned

`src/` is a copy of the game engine from the upstream `elementals` repository.
Its commit is recorded in `simulation/engine-source.json`, and provenance reads
that marker instead of this repository's own commit.

That indirection matters. A balance reading is only valid for the engine that
produced it, and the evaluator **refuses** to compare readings across engines.
Without the marker, a run here would be stamped with this repo's commit and
would be declared incomparable to an upstream run of the identical game.

Changes to the engine belong upstream, followed by a re-export:

```bash
# from the upstream elementals/Server checkout
node simulation/tools/exportRepo.mjs --out ../../Simulation --clean
```

The export walks the real import graph and **fails** if the simulator has
acquired a dependency on the transport layer, rather than shipping a repo that
cannot install.

## How a search works

```
        screen                full                   validation
  cheap, all candidates → all 120 duel pairings → disjoint seed pool
```

Each candidate is a set of parameter *overrides* — 20 searchable values out of
672 tunables, each with explicit bounds. `economy.incomePerCitizen` is locked by
design and a test enforces it.

CMA-ES climbs `searchObjective`, the score **without** the constraint cap. The
capped `overall` remains the human verdict. Using the capped score to steer
pinned every candidate to exactly 0.6000 across an entire run, leaving the
optimizer no gradient at all.

## Reading the output

| File | |
|---|---|
| `candidate.json` | The best parameter set found, with its scores. A proposal. |
| `result.json` | The full run: every generation, every evaluation, provenance. |
| `fitness.txt` | Human-readable breakdown of the best candidate's score. |
| `progress.log` | Flushed every line, so a killed session still leaves a record. |
| `checkpoint.json` | Resume state. Keep this. |

### Nothing here is promotable on its own

A single run provides one validation pool, and one pool cannot separate a real
fix from a favourable draw. This is not hypothetical: a candidate that cleared
every constraint on one pool with a 0.8957 score had two of them return on a
second, with nothing changed but the seeds. Both margins had been sitting inside
their own confidence intervals the whole time.

Promotion requires **at least two independent pools**, with every constraint's
interval — not its point estimate — clear of its threshold. `simulation/src/fitness/promotion.ts`
implements that gate.

## Requirements

**Node 20 or newer**, and Node 20 is not a formality — Kaggle's image is
20.19.0. No runtime dependencies; `tsx` and `typescript` are dev-only.

Developing on a newer Node is fine, but "it works here" proves very little
about the deployment target, and two failures have already reached Kaggle that
no local run could reproduce:

- `fs.globSync` arrived in **Node 22**. The test runner imported it, so on
  Kaggle the runner threw at module load — before a single test ran, with an
  error naming neither the version nor the cause.
- `node:test` is absent from `builtinModules` on Node 20 but present on Node 24,
  because it is reachable only via the `node:` prefix. A membership check
  against `builtinModules` passes locally and then condemns every test file.

Two guards in `test/boundary.test.ts` keep this from recurring:

- **No source file may use an API newer than `engines.node`.** The version
  floor lives in `scripts/lib/nodeApiFloor.json` — as data, because the check
  scans `.ts` and `.mjs` for those very patterns and a denylist written in
  TypeScript matches itself. Patterns match a call or an import, not a mention,
  so discussing an API in a comment does not trip it.
- **The declared floor must stay at or below Node 20**, so nobody raises it past
  the deployment target while every local check still passes.

Neither guard can substitute for running on the real thing. This fix was
verified against a genuine Node 20.19.0 binary, not just statically.
