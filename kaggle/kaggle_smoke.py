"""
Elementals balance search — Kaggle SMOKE TEST.

This is NOT the training run. Its only job is to prove that the whole path
executes on Kaggle:

    repository -> npm -> kaggleSearch.ts -> CMA-ES -> evaluation
               -> checkpoint -> result.json -> candidate.json

It is a deliberately separate file from `kaggle_notebook.py` rather than a mode
flag inside it. A flag can be left in the wrong position; a file cannot be run
by accident. The production launcher keeps its real configuration untouched,
and `test/kaggleRunners.test.ts` fails if either drifts.

Requires "Internet" ON.

WHAT THIS COSTS, and why it is not smaller
------------------------------------------
Roughly 16,500 matches. The floor is set by the evaluation tiers, which are
fixed constants because they are what make a reading mean anything:

    baseline screen        1,656 matches   (unavoidable)
    baseline full          5,760 matches   (unavoidable)
    2 candidate screens    3,312 matches
    1 promoted full        5,760 matches

`--validate 0` is essential. The validation tier is 21,816 matches and runs for
BOTH the baseline and the elite — 43,632 more, several hours on four cores, and
it proves nothing the rest of the path has not already proven. Validation is
exercised by the real run, not by a smoke test.

The resume pass adds 9,072 matches: the baseline and the first generation come
back from the checkpoint's cache, so only the new generation is paid for.

TIMING, measured rather than guessed
------------------------------------
Both passes were run locally on Node 20.19.0 with 8 workers:

    pass 1 (fresh)    16,488 matches   34.8 min   7.9 matches/sec
    pass 2 (resume)    9,072 matches   20.4 min   7.4 matches/sec

Kaggle has four cores against this machine's twelve, and worker scaling is
sublinear (measured earlier at 3.22x for 8 workers and 2.74x for 4). Expect
roughly 45-60 minutes for pass 1 and 25-35 for the resume: call it 60-95
minutes in total.

That is more than a "quick check" and less than an eighth of the real run. The
floor is what it is because the evaluation tiers are fixed; shrinking one to
make this faster would produce a smoke test that passes without telling us
anything about the run it is supposed to de-risk. Set VERIFY_RESUME = False to
halve it if the resume property is not what you are testing today.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# --- configuration ---------------------------------------------------------
REPO = "https://github.com/BSutton17/Simulation.git"
BRANCH = "main"

# Deliberately tiny. Only large enough to produce a candidate at all: a
# candidate.json exists only when something was promoted to a full evaluation,
# so `promote` cannot be 0.
GENERATIONS = 1
POPULATION = 2
PROMOTE = 1
VALIDATE = 0

# Matched to the production launcher so the smoke test exercises the same
# search, just less of it. Changing these would test a different thing.
SIGMA = 0.2
SEED = 20260813

# Second pass: re-run with one more generation against the same output
# directory. The search must resume from the checkpoint rather than restart,
# which is the property that lets a real run survive Kaggle's session limit.
VERIFY_RESUME = True

WORK = Path("/kaggle/working")
OUT = WORK / "smoke"
SRC = WORK / "Simulation"


def sh(cmd, cwd=None, check=True):
    """Run a command, streaming output so a long job is watchable."""
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    process = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    for line in process.stdout:
        print(line, end="", flush=True)
    code = process.wait()
    if check and code != 0:
        raise RuntimeError(f"command failed with exit code {code}: {' '.join(str(c) for c in cmd)}")
    return code


def ensure_node():
    """Kaggle images ship Node, but the version moves. Verify rather than hope."""
    if shutil.which("node") is None:
        print("node not found — installing via conda", flush=True)
        sh(["conda", "install", "-y", "-c", "conda-forge", "nodejs"])
    version = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    print(f"node {version}", flush=True)
    major = int(version.lstrip("v").split(".")[0])
    if major < 20:
        raise RuntimeError(
            f"node {version} is too old; this project needs >= 20 "
            "(it uses node:test and worker_threads)"
        )


def check(label, condition, detail=""):
    """Record one pipeline assertion. Printed as a checklist, not an exception,
    so a single missing artifact does not hide everything after it."""
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}{('  — ' + detail) if detail else ''}", flush=True)
    return bool(condition)


def search(generations, label):
    workers = max(1, (os.cpu_count() or 4) - 1)
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}", flush=True)
    sh(
        [
            "node", "dist/simulation/src/kaggleSearch.js",
            "--generations", str(generations),
            "--population", str(POPULATION),
            "--sigma", str(SIGMA),
            "--seed", str(SEED),
            "--promote", str(PROMOTE),
            "--validate", str(VALIDATE),
            "--workers", str(workers),
            "--out", str(OUT),
        ],
        cwd=SRC,
    )


def main():
    print("=" * 70)
    print("SMOKE TEST — this is NOT the training run")
    print("=" * 70)
    print(f"  generations {GENERATIONS}   population {POPULATION}   "
          f"promote {PROMOTE}   validate {VALIDATE}")
    print(f"  cores {os.cpu_count()}   output {OUT}")
    print()

    ensure_node()

    if SRC.exists():
        shutil.rmtree(SRC)
    sh(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO, str(SRC)])
    sh(["npm", "ci"] if (SRC / "package-lock.json").exists() else ["npm", "install"], cwd=SRC)
    # Compile to JavaScript before running. Measured 1.45x faster than
    # executing TypeScript through tsx, with byte-identical outcomes:
    # tsx injects a __name helper for every function it transpiles, which
    # profiled at 13% of total runtime on its own.
    sh(["npm", "run", "build"], cwd=SRC)

    # A stale checkpoint from an earlier smoke attempt would be resumed instead
    # of exercising a fresh run, and the test would prove the wrong thing.
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    search(GENERATIONS, f"PASS 1 — fresh search, {GENERATIONS} generation(s)")

    print(f"\n{'=' * 70}\nPIPELINE VERIFICATION\n{'=' * 70}", flush=True)
    results = []

    checkpoint = OUT / "checkpoint.json"
    result_file = OUT / "result.json"
    candidate_file = OUT / "candidate.json"

    results.append(check("checkpoint.json written", checkpoint.exists()))
    results.append(check("result.json written", result_file.exists()))
    results.append(check("candidate.json written", candidate_file.exists()))
    results.append(check("fitness.txt written", (OUT / "fitness.txt").exists()))
    results.append(check("progress.log written", (OUT / "progress.log").exists()))

    if checkpoint.exists():
        ck = json.loads(checkpoint.read_text())
        results.append(check(
            "checkpoint records a completed generation",
            ck.get("completedGenerations", 0) >= 1,
            f"completedGenerations={ck.get('completedGenerations')}",
        ))
        results.append(check(
            "checkpoint carries CMA-ES state",
            isinstance(ck.get("cma"), dict) and "mean" in ck["cma"],
        ))
        results.append(check(
            "checkpoint carries cached evaluations",
            len(ck.get("cacheEntries", [])) > 0,
            f"{len(ck.get('cacheEntries', []))} entries",
        ))
        results.append(check(
            "checkpoint pins engine identity",
            bool(ck.get("identity", {}).get("engineSha")),
            ck.get("identity", {}).get("engineSha", "")[:10],
        ))
        results.append(check(
            "checkpoint pins promote",
            ck.get("identity", {}).get("promote") == PROMOTE,
            f"promote={ck.get('identity', {}).get('promote')}",
        ))
        # With VALIDATE = 0 there is no validation stage to wait for, so a run
        # that finished its generations really is finished.
        results.append(check(
            "checkpoint records a stage",
            ck.get("stage") in ("search", "validation", "complete"),
            f"stage={ck.get('stage')}",
        ))

    if result_file.exists():
        data = json.loads(result_file.read_text())
        results.append(check("a candidate was evaluated at full depth", data.get("best") is not None))
        results.append(check(
            "baseline was scored through the same pipeline",
            data.get("baseline", {}).get("full") is not None,
        ))
        results.append(check(
            "provenance is intact",
            bool(data.get("schema", {}).get("catalogHash")),
        ))
        results.append(check("no evaluation failures", data.get("totals", {}).get("failures") == 0))
        print(f"\n  baseline full  {data.get('baseline', {}).get('full')}")
        if data.get("best"):
            print(f"  best full      {data['best'].get('full')}")
            print(f"  candidate      {data['best'].get('candidate', {}).get('id')}")
        print(f"  totals         {json.dumps(data.get('totals', {}))}")

    if candidate_file.exists():
        cand = json.loads(candidate_file.read_text())
        results.append(check("candidate carries parameter overrides", bool(cand.get("parameters"))))
        results.append(check(
            "candidate is marked NOT PROMOTED",
            "NOT PROMOTED" in str(cand.get("promotion", "")),
        ))

    # --- resume --------------------------------------------------------------
    if VERIFY_RESUME and checkpoint.exists():
        before = json.loads(checkpoint.read_text())["completedGenerations"]
        search(GENERATIONS + 1, f"PASS 2 — resume, {GENERATIONS + 1} generation(s)")
        data = json.loads(result_file.read_text())
        resumed = data.get("resumedFrom")
        results.append(check(
            "second pass resumed instead of restarting",
            resumed is not None,
            json.dumps(resumed),
        ))
        results.append(check(
            "resume reused cached evaluations",
            bool(resumed) and resumed.get("cacheEntries", 0) > 0,
        ))
        after = json.loads(checkpoint.read_text())["completedGenerations"]
        results.append(check(
            "checkpoint advanced past the resume point",
            after > before,
            f"{before} -> {after}",
        ))
        results.append(check("checkpoint was not rejected", data.get("checkpointRejected") is None,
                             str(data.get("checkpointRejected"))))

    print(f"\n{'=' * 70}")
    if all(results):
        print(f"SMOKE TEST PASSED — {len(results)}/{len(results)} checks")
        print("The Kaggle pipeline runs end to end. Ready to launch the real run")
        print("with kaggle/kaggle_notebook.py.")
    else:
        print(f"SMOKE TEST FAILED — {sum(results)}/{len(results)} checks passed")
        print("Do NOT start the real run until this is green.")
    print("=" * 70)

    print(f"\nArtifacts in {OUT}:")
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}  ({f.stat().st_size:,} bytes)")

    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
