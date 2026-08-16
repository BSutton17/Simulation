"""
Elementals balance search — Kaggle WORKER.

Start as many of these as Kaggle will let you run concurrently. Each one claims
candidates from the shared queue, evaluates them, and submits the results. They
do not talk to each other and do not know how many others exist, so adding a
sixth is starting a sixth: nothing to configure, nothing to rebalance.

    Save Version -> Save & Run All (Commit)

Requires "Internet" ON and one secret attached:

    SUPABASE_URL
    SUPABASE_PUBLISHABLE_KEY

DO NOT attach SUPABASE_SECRET_KEY to a worker. Workers reach the queue through
database functions that validate their own inputs; the publishable key is all
they need, and it cannot delete a run or rewrite a result. The secret key
belongs to the coordinator alone.

Set EXPERIMENT_ID to the value the coordinator printed when it started.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

# --- configuration ---------------------------------------------------------
REPO = "https://github.com/BSutton17/Simulation.git"
BRANCH = "main"

# Printed by the coordinator on its first run. Every worker needs the same one.
EXPERIMENT_ID = ""

# Local evaluation threads. Two measured fastest on a 4-core Kaggle notebook:
# 19.85 match/s against 18.64 at three and 14.29 at one.
WORKERS = 2

# Stop between jobs before the session is killed, so a job is never abandoned
# mid-evaluation. A job that IS abandoned is not lost — its lease lapses and
# another worker takes it — but finishing cleanly wastes nothing.
HOURS = 10.5

WORK = Path("/kaggle/working")
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
    """
    Pulls credentials from Kaggle Secrets into the environment.

    The Node process reads the same variable names locally from .env, so
    nothing differs between a development machine and a notebook. Values are
    never printed — only whether each one was found.
    """
    try:
        from kaggle_secrets import UserSecretsClient
        secrets = UserSecretsClient()
    except Exception as error:
        raise RuntimeError(
            f"Kaggle Secrets unavailable ({type(error).__name__}). "
            "Attach SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY under Add-ons -> Secrets."
        )

    for name in ("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"):
        try:
            os.environ[name] = secrets.get_secret(name)
            print(f"  {name}: configured", flush=True)
        except Exception:
            raise RuntimeError(f"secret {name} is not attached to this notebook")

    # Defensive: if the elevated key is attached by mistake, do not let the
    # worker inherit it.
    os.environ.pop("SUPABASE_SECRET_KEY", None)


def main():
    print("=" * 70)
    print("ELEMENTALS BALANCE SEARCH — WORKER")
    print("=" * 70)
    if not EXPERIMENT_ID:
        print("\nFAILED: set EXPERIMENT_ID to the value the coordinator printed.")
        return 1
    print(f"  experiment {EXPERIMENT_ID}")
    print(f"  threads    {WORKERS}   cores {os.cpu_count()}   budget {HOURS}h")
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
    # Compiled JavaScript is 1.45x faster than running TypeScript through tsx,
    # with byte-identical outcomes.
    sh(["npm", "run", "build"], cwd=SRC)

    sh([
        "node", "dist/simulation/src/distributed/runWorker.js",
        "--experiment", EXPERIMENT_ID,
        "--workers", str(WORKERS),
        "--hours", str(HOURS),
    ], cwd=SRC)

    print("\nWorker finished. Start another session to keep contributing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
