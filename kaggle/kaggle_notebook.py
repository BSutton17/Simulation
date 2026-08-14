"""
Elementals balance search — Kaggle runner.

Paste this into a Kaggle notebook cell, or add it as a Kaggle Utility Script.
Requires "Internet" ON in the notebook settings (it clones from GitHub and
installs npm packages).

A Kaggle session is killed on a hard clock — 9h interactive, 12h committed. The
search is checkpointed after every generation into /kaggle/working, and HOURS
below tells it to stop itself at a generation boundary with time to spare, so
the final artifacts get written instead of being cut off mid-flight.

To continue a search: download `checkpoint.json` from the previous session's
output, add it as a Kaggle Dataset, point RESUME_FROM at it, and run again with
the SAME seed, generations, population and sigma. Anything else and the
checkpoint is refused by design rather than silently splicing two different
searches together.
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

GENERATIONS = 40
POPULATION = 8
SIGMA = 0.2
SEED = 20260813
PROMOTE = 3
VALIDATE = 1

# Stop cleanly with room to write artifacts. Kaggle interactive sessions end at
# 9h; leaving an hour is deliberate, not superstition — the validation stage at
# the end of a run is itself expensive.
HOURS = 8.0

# Path to a checkpoint.json from a previous session, or None to start fresh.
RESUME_FROM = None  # e.g. "/kaggle/input/elementals-checkpoint/checkpoint.json"

WORK = Path("/kaggle/working")
OUT = WORK / "run"
SRC = WORK / "Simulation"


def sh(cmd, cwd=None, check=True):
    """Run a command, streaming its output so a long job is watchable."""
    print(f"$ {' '.join(cmd)}", flush=True)
    process = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    for line in process.stdout:
        print(line, end="", flush=True)
    code = process.wait()
    if check and code != 0:
        raise RuntimeError(f"command failed with exit code {code}: {' '.join(cmd)}")
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


def main():
    ensure_node()
    OUT.mkdir(parents=True, exist_ok=True)

    if SRC.exists():
        shutil.rmtree(SRC)
    sh(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO, str(SRC)])

    # npm ci needs the lockfile; fall back to install if the repo has none.
    if (SRC / "package-lock.json").exists():
        sh(["npm", "ci"], cwd=SRC)
    else:
        sh(["npm", "install"], cwd=SRC)

    if RESUME_FROM:
        source = Path(RESUME_FROM)
        if not source.exists():
            raise FileNotFoundError(f"RESUME_FROM does not exist: {source}")
        shutil.copy(source, OUT / "checkpoint.json")
        print(f"resuming from {source}", flush=True)

    # Kaggle CPU notebooks report 4 logical cores. defaultWorkerCount() would
    # pick 3; leaving one core for the main thread is what the pool expects.
    workers = max(1, (os.cpu_count() or 4) - 1)

    sh(
        [
            "npx", "tsx", "simulation/src/kaggleSearch.ts",
            "--generations", str(GENERATIONS),
            "--population", str(POPULATION),
            "--sigma", str(SIGMA),
            "--seed", str(SEED),
            "--promote", str(PROMOTE),
            "--validate", str(VALIDATE),
            "--workers", str(workers),
            "--hours", str(HOURS),
            "--out", str(OUT),
        ],
        cwd=SRC,
    )

    print("\n" + "=" * 70)
    print("ARTIFACTS IN /kaggle/working/run")
    print("=" * 70)
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}  ({f.stat().st_size:,} bytes)")

    candidate = OUT / "candidate.json"
    if candidate.exists():
        print("\nBest candidate:")
        print(json.dumps(json.loads(candidate.read_text()), indent=2)[:4000])

    result = OUT / "result.json"
    if result.exists():
        data = json.loads(result.read_text())
        if data.get("stoppedEarly"):
            print("\n" + "!" * 70)
            print("RUN STOPPED EARLY —", data["stoppedEarly"]["reason"])
            print("Download checkpoint.json and run again with the same settings")
            print("to continue from generation", data["stoppedEarly"]["afterGeneration"])
            print("!" * 70)


if __name__ == "__main__":
    sys.exit(main())
