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
npm test          # 80 test files
npm run typecheck
npm run smoke     # one generation, ~15 min, proves the pipeline works
```

A real search:

```bash
npm run search -- --generations 40 --population 8 --hours 8 --out runs/search
```

## Kaggle

`kaggle/kaggle_notebook.py` clones this repo, installs, runs the search and
reports the artifacts. Paste it into a notebook cell with **Internet ON**.

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
| `test` | 80 test files covering the engine and the simulator. |

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

Node 20 or newer. No runtime dependencies; `tsx` and `typescript` are dev-only.
