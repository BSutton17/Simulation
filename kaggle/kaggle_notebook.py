"""
Elementals balance search — Kaggle production runner.

Paste this into a Kaggle notebook cell. Requires "Internet" ON.

This is the real training run. For a cheap end-to-end check of the pipeline use
kaggle_smoke.py; for a check that cross-session persistence works, use
verify_persistence.py. Both take minutes. This takes hours.

SURVIVING A LOST SESSION
------------------------
/kaggle/working belongs to a session, not to a notebook. A new Draft Session
gets an empty one, which is how a completed generation was lost once already.

So the checkpoint is mirrored to a Kaggle Dataset while the search runs. A
watcher thread notices when the checkpoint advances and publishes a new version
— pushing only at the end would protect against nothing, since the end is
exactly what a lost session never reaches. On startup the newest stored
checkpoint is pulled back, so a fresh session continues rather than restarts.

Set PERSIST = False to disable that and fall back to manual RESUME_FROM.

CREDENTIALS
-----------
Add KAGGLE_API_TOKEN under Add-ons -> Secrets and attach it to this notebook.
No kaggle.json download, nothing in the repository, and the token is never
printed. See README for the one-time setup.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

# --- production configuration ----------------------------------------------
# Locked in after the planning analysis. test/kaggleRunners.test.ts asserts
# these exact values, so a change here fails the suite until it is deliberate.
REPO = "https://github.com/BSutton17/Simulation.git"
BRANCH = "main"

GENERATIONS = 20
POPULATION = 8
SIGMA = 0.2
SEED = 20260813
PROMOTE = 1
VALIDATE = 1

# Stop at a generation boundary with time to spare. The budget is only checked
# BETWEEN generations, so a generation starting just under it overruns by up to
# one generation — measured at 58.5 minutes on this Kaggle machine.
#
# 7.0 is sized for a 9-hour interactive session and is safe in a batch session
# too. If you confirm the batch limit is 12 hours, raising this to 10.5 fits ten
# generations per session instead of seven and finishes the run in two sessions
# rather than three. Raise it only after confirming the limit: overshooting
# means the session is killed mid-generation, losing that generation's work.
HOURS = 7.0

# Measured on this Kaggle machine: 2 workers gave 19.85 match/s against 18.64
# at 3 and 17.41 at 4, with identical outcomes at every count. Re-run
# `npm run bench:workers -- --repeats 3` if the machine ever changes.
WORKERS = 2

# --- persistence -------------------------------------------------------------
PERSIST = True
DATASET_NAME = "elementals-checkpoint"

# Abort before starting if the checkpoint cannot be persisted.
#
# Unattended is the whole point of a batch run, and an unattended run without
# persistence is the worst of both worlds: hours of compute with nobody watching
# and nothing to recover. Failing in the first minute is far better than
# discovering it in the twelfth hour. Set False only for a deliberate throwaway.
REQUIRE_PERSISTENCE = True

# Your Kaggle username. Leave blank to detect it from the CLI; set it if
# detection ever fails, since a batch session has no one to ask.
USERNAME = ""
# Seconds between checks of the checkpoint file. Generations take the better
# part of an hour, so this is not a hot loop.
WATCH_SECONDS = 60

# Only used when PERSIST is False: a manually placed checkpoint.
RESUME_FROM = None  # e.g. "/kaggle/input/elementals-checkpoint/checkpoint.json"

WORK = Path("/kaggle/working")
OUT = WORK / "run"
SRC = WORK / "Simulation"


def sh(cmd, cwd=None, check=True):
    """Run a command, streaming its output so a long job is watchable."""
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


class CheckpointMirror:
    """
    Keeps the Kaggle Dataset copy of the checkpoint up to date while the search
    runs.

    A background thread rather than a hook in the search: the search is a child
    process, and reaching into it would mean a protocol between the two. The
    checkpoint file is already the contract, and watching it needs nothing from
    the TypeScript side.

    Every failure here is swallowed after being reported. Losing a push costs
    one generation of redundancy; killing the search costs the session.
    """

    def __init__(self, store, backend, path):
        self.store = store
        self.backend = backend
        self.path = Path(path)
        self._stop = threading.Event()
        self._thread = None
        self.pushes = 0
        self.last_seen = None

    def _progress(self):
        data = self.store.read_checkpoint(self.path)
        if data is None:
            return None
        return (data.get("completedGenerations", -1), data.get("stage"))

    def _push(self, why):
        try:
            ok, message = self.store.push_if_newer(self.backend, self.path, why)
            if ok:
                self.pushes += 1
            print(f"  [persist] {message}", flush=True)
        except Exception as error:
            # Redacted: the store scrubs credentials from CLI output, and this
            # message goes into a notebook log that may be shared.
            print(f"  [persist] push failed ({type(error).__name__}): "
                  f"{self.store.redact(str(error))[:200]}", flush=True)

    def _loop(self):
        while not self._stop.wait(WATCH_SECONDS):
            progress = self._progress()
            if progress and progress != self.last_seen:
                self.last_seen = progress
                self._push(f"generation {progress[0]}, stage {progress[1]}")

    def start(self):
        self.last_seen = self._progress()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        # Final push regardless of what the watcher last saw, so the completed
        # run is stored even if it finished between polls.
        self._push("final")


def setup_persistence():
    """Returns (store, backend, mirror) or (None, None, None)."""
    if not PERSIST:
        print("  persistence disabled (PERSIST = False)", flush=True)
        return None, None, None

    sys.path.insert(0, str(SRC / "kaggle"))
    import checkpoint_store as store

    mode = store.configure_credentials()
    if mode is None:
        print("\n" + "!" * 70)
        print("NO KAGGLE CREDENTIAL FOUND — the run will not survive losing this session.")
        print("Add KAGGLE_API_TOKEN under Add-ons -> Secrets and attach it, then re-run.")
        print("Continuing without persistence.")
        print("!" * 70 + "\n")
        return None, None, None
    print(f"  authenticated via: {mode}", flush=True)

    username = USERNAME or os.environ.get("KAGGLE_USERNAME")
    if not username:
        try:
            exe = shutil.which("kaggle")
            probe = subprocess.run([exe, "config", "view"], capture_output=True, text=True)
            for line in (probe.stdout or "").splitlines():
                if "username" in line.lower():
                    username = line.split(":")[-1].strip()
        except Exception:
            pass
    if not username:
        # Never prompt. A batch session has no stdin, and asking would hang the
        # run until the session times out with nothing to show for it.
        print("  could not determine the Kaggle username — set USERNAME at the "
              "top of this file", flush=True)
        return None, None, None

    slug = f"{username}/{DATASET_NAME}"
    backend = store.KaggleDatasetStore(slug, workdir=str(WORK / "_ckpt"))
    print(f"  checkpoint dataset: {slug}", flush=True)

    # Recover anything a previous session stored.
    OUT.mkdir(parents=True, exist_ok=True)
    local = OUT / "checkpoint.json"
    try:
        ok, message = store.pull_latest(backend, local)
        print(f"  [persist] {message}", flush=True)
    except Exception as error:
        print(f"  [persist] nothing to restore ({type(error).__name__})", flush=True)
        ok = False

    if not ok and not local.exists():
        try:
            backend.create(title="Elementals balance search checkpoint")
            print("  [persist] checkpoint dataset created", flush=True)
        except Exception:
            pass  # already exists, which is fine

    return store, backend, CheckpointMirror(store, backend, local)


def main():
    print("=" * 70)
    print("ELEMENTALS BALANCE SEARCH — PRODUCTION RUN")
    print("=" * 70)
    print(f"  generations {GENERATIONS}   population {POPULATION}   promote {PROMOTE}   "
          f"validate {VALIDATE}")
    print(f"  sigma {SIGMA}   seed {SEED}   hours {HOURS}   workers {WORKERS}")
    print(f"  cores {os.cpu_count()}   output {OUT}")
    print()

    ensure_node()
    OUT.mkdir(parents=True, exist_ok=True)

    if SRC.exists():
        shutil.rmtree(SRC)
    sh(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO, str(SRC)])

    if (SRC / "package-lock.json").exists():
        sh(["npm", "ci"], cwd=SRC)
    else:
        sh(["npm", "install"], cwd=SRC)

    # Compile to JavaScript before running. Measured 1.45x faster than
    # executing TypeScript through tsx, with byte-identical outcomes.
    sh(["npm", "run", "build"], cwd=SRC)

    store, backend, mirror = setup_persistence()

    if PERSIST and REQUIRE_PERSISTENCE and mirror is None:
        raise RuntimeError(
            "checkpoint persistence could not be set up, and REQUIRE_PERSISTENCE is on.\n"
            "  An unattended run without persistence risks losing every hour it computes.\n"
            "  Fix: attach KAGGLE_API_TOKEN under Add-ons -> Secrets, and set USERNAME\n"
            "  at the top of this file if the username could not be detected.\n"
            "  To run anyway, set REQUIRE_PERSISTENCE = False."
        )

    if RESUME_FROM and not mirror:
        source = Path(RESUME_FROM)
        if not source.exists():
            raise FileNotFoundError(f"RESUME_FROM does not exist: {source}")
        shutil.copy(source, OUT / "checkpoint.json")
        print(f"resuming from {source}", flush=True)

    if mirror:
        mirror.start()
    try:
        sh(
            [
                "node", "dist/simulation/src/kaggleSearch.js",
                "--generations", str(GENERATIONS),
                "--population", str(POPULATION),
                "--sigma", str(SIGMA),
                "--seed", str(SEED),
                "--promote", str(PROMOTE),
                "--validate", str(VALIDATE),
                "--workers", str(WORKERS),
                "--hours", str(HOURS),
                "--out", str(OUT),
            ],
            cwd=SRC,
        )
    finally:
        # Runs even if the search raised: whatever it completed is worth storing.
        if mirror:
            mirror.stop()
            print(f"  [persist] {mirror.pushes} checkpoint versions published", flush=True)

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
            if mirror:
                print("The checkpoint is stored. Open a NEW session and run this")
                print("same script again — it will pull the checkpoint and continue")
                print("from generation", data["stoppedEarly"]["afterGeneration"])
            else:
                print("Download checkpoint.json and run again with the same settings")
                print("to continue from generation", data["stoppedEarly"]["afterGeneration"])
            print("!" * 70)


if __name__ == "__main__":
    sys.exit(main())
