"""
Elementals balance search — Kaggle COORDINATOR.

Exactly ONE of these runs. It owns the CMA-ES state: it asks the strategy for a
population, publishes each candidate to the shared queue, waits for every result,
and advances the generation. It never evaluates anything itself — that is what
the worker notebooks are for.

    Save Version -> Save & Run All (Commit)

Requires "Internet" ON and three secrets attached:

    SUPABASE_URL
    SUPABASE_SECRET_KEY      <- coordinator only, never on a worker
    KAGGLE_API_TOKEN         <- durable checkpoint persistence

The secret key is needed because creating experiments and inserting jobs are
deliberately NOT granted to the publishable key: anything holding a worker key
could otherwise start or reshape a run.

START THIS FIRST. It prints an EXPERIMENT ID; paste that into every worker
notebook before starting them.
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

# The 181-dimensional ability search.
SCOPE = "expanded"
GENERATIONS = 60
SEED = 20260813
SIGMA = 0.2
PROMOTE = 1
VALIDATE = 1

# Blank uses the CMA-ES standard for this dimensionality: 4 + 3*ln(181) = 19.
POPULATION = ""

# Match-budget split. v2 gives 7-FFA 54% of the matches for 35% of the fitness
# weight; v1 gave it 13% and put it below its own sampling noise.
ALLOCATION = "v2"

# Names the experiment. Changing it starts a separate run rather than joining
# the existing one — which is exactly why V3 has its own name and the previous
# experiment stays untouched.
EXPERIMENT_NAME = "elementals-balance-v3-v2-s20260813"

# The checkpoint now lives in Supabase (table `checkpoints`), not in a Kaggle
# Dataset. /kaggle/working is deleted when a session ends, which is how the
# previous run lost thirteen generations: the checkpoint was written correctly
# after every generation and then thrown away with the session. Supabase is the
# only storage both a dying coordinator and its replacement can see.
#
# To resume after a session timeout: re-run this notebook unchanged. It finds
# the experiment by name, restores the latest checkpoint, and continues.

WORK = Path("/kaggle/working")
OUT = WORK / "coordinator"
SRC = WORK / "Simulation"


def sh(cmd, cwd=None, check=True):
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    process = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    for line in process.stdout:
        print(line, end="", flush=True)
    code = process.wait()
    if check and code != 0:
        raise RuntimeError(f"command failed with exit code {code}")
    return code


def load_secrets():
    """Pulls credentials into the environment. Values are never printed."""
    try:
        from kaggle_secrets import UserSecretsClient
        secrets = UserSecretsClient()
    except Exception as error:
        raise RuntimeError(
            f"Kaggle Secrets unavailable ({type(error).__name__}). "
            "Attach SUPABASE_URL and SUPABASE_SECRET_KEY under Add-ons -> Secrets."
        )

    for name in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
        try:
            os.environ[name] = secrets.get_secret(name)
            print(f"  {name}: configured", flush=True)
        except Exception:
            raise RuntimeError(f"secret {name} is not attached to this notebook")

    # Optional: the durable Kaggle Dataset checkpoint.
    try:
        os.environ["KAGGLE_API_TOKEN"] = secrets.get_secret("KAGGLE_API_TOKEN")
        print("  KAGGLE_API_TOKEN: configured", flush=True)
    except Exception:
        print("  KAGGLE_API_TOKEN: not attached — checkpoint stays session-local", flush=True)


def main():
    print("=" * 70)
    print("ELEMENTALS BALANCE SEARCH — COORDINATOR")
    print("=" * 70)
    print(f"  scope {SCOPE}   generations {GENERATIONS}   seed {SEED}   sigma {SIGMA}")
    print(f"  experiment {EXPERIMENT_NAME}")
    print()

    load_secrets()

    version = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    print(f"  node {version}", flush=True)
    if int(version.lstrip("v").split(".")[0]) < 20:
        raise RuntimeError(f"node {version} is too old; this project needs >= 20")

    if SRC.exists():
        shutil.rmtree(SRC)
    sh(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO, str(SRC)])
    sh(["npm", "ci"] if (SRC / "package-lock.json").exists() else ["npm", "install"], cwd=SRC)
    # Compiled JavaScript is 1.45x faster than tsx, with identical outcomes.
    sh(["npm", "run", "build"], cwd=SRC)

    OUT.mkdir(parents=True, exist_ok=True)
    command = [
        "node", "dist/simulation/src/distributed/runCoordinator.js",
        "--scope", SCOPE,
        "--generations", str(GENERATIONS),
        "--seed", str(SEED),
        "--sigma", str(SIGMA),
        "--promote", str(PROMOTE),
        "--validate", str(VALIDATE),
        "--name", EXPERIMENT_NAME,
        "--allocation", ALLOCATION,
        "--out", str(OUT),
    ]
    if POPULATION:
        command += ["--population", str(POPULATION)]

    sh(command, cwd=SRC)

    marker = OUT / "experiment-id.txt"
    if marker.exists():
        print("\n" + "=" * 70)
        print("EXPERIMENT ID:", marker.read_text().strip())
        print("Paste this into EXPERIMENT_ID in every worker notebook.")
        print("=" * 70)

    candidate = OUT / "candidate.json"
    if candidate.exists():
        print("\nBest candidate:")
        print(json.dumps(json.loads(candidate.read_text()), indent=2)[:3000])

    return 0


if __name__ == "__main__":
    sys.exit(main())
