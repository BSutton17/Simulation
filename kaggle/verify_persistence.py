"""
The one thing that cannot be tested off Kaggle: does persistence actually work?

Everything else about the checkpoint store is covered by
`test_checkpoint_store.py`, which runs the real code against an emulated CLI.
What that cannot prove is Kaggle's side — whether the token authenticates,
whether a dataset version appears, whether a new session can read it back.

This is that proof, and it is deliberately tiny: a few kilobytes of fake
checkpoint, seconds of runtime, no search. Run it in one session, then in a
second, fresh session.

    %run /kaggle/working/Simulation/kaggle/verify_persistence.py

Run 1 uploads. Run 2, in a NEW session, downloads and checks. The script works
out which it is from what already exists in the dataset.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import checkpoint_store as store  # noqa: E402

# Change only if you want a different dataset name. The username is filled in
# from your credentials, so this needs no editing.
DATASET_NAME = "elementals-checkpoint-test"

WORK = Path("/kaggle/working") if Path("/kaggle/working").exists() else Path.cwd() / "_verify"
LOCAL = WORK / "verify" / "checkpoint.json"

# A checkpoint-shaped payload with the fields that must survive. Not a real
# run: this proves the transport, not the search.
PAYLOAD = {
    "version": "v2",
    "identity": {
        "engineSha": "36d9ce3eb0fc106c7b0a5ec8c00bcf06dee9431f",
        "engineDirty": False,
        "schemaVersion": "v1",
        "catalogHash": "f8f4ea6b",
        "fitnessVersion": "v1",
        "optimizerVersion": "v1",
        "weightsName": "designerPriority",
        "seed": 20260813,
        "generations": 20,
        "populationSize": 8,
        "sigma": 0.2,
        "promote": 1,
        "tiersHash": "bbcd40d2",
    },
    "writtenAt": "2026-08-14T00:00:00.000Z",
    "completedGenerations": 3,
    "stage": "search",
    "cma": {"mean": [0.5] * 20, "sigma": 0.188, "rngState": 268449301, "generation": 3},
    "cacheEntries": [{"key": "probe|screen"}],
    "counters": {"matches": 57024},
    "_note": "persistence probe, not a real run",
}


def main():
    print("=" * 70)
    print("KAGGLE PERSISTENCE VERIFICATION")
    print("=" * 70)

    mode = store.configure_credentials()
    if mode is None:
        print("\nFAILED: no Kaggle credential found.")
        print("  Add KAGGLE_API_TOKEN under Add-ons -> Secrets, and attach it")
        print("  to this notebook. Nothing else is needed.")
        return 1
    print(f"  authenticated via: {mode}")  # never the value itself

    username = os.environ.get("KAGGLE_USERNAME")
    if not username:
        # With token auth there is no username in the environment; ask the CLI.
        try:
            import subprocess, shutil
            exe = shutil.which("kaggle")
            probe = subprocess.run([exe, "config", "view"], capture_output=True, text=True)
            for line in (probe.stdout or "").splitlines():
                if "username" in line.lower():
                    username = line.split(":")[-1].strip()
        except Exception:
            pass
    if not username:
        username = input("Kaggle username: ").strip()
    if not username:
        print("\nFAILED: could not determine your Kaggle username.")
        return 1

    slug = f"{username}/{DATASET_NAME}"
    backend = store.KaggleDatasetStore(slug, workdir=str(WORK / "_probe"))
    print(f"  dataset: {slug}")

    LOCAL.parent.mkdir(parents=True, exist_ok=True)
    probe = WORK / "verify" / "remote.json"
    found = backend.pull(probe)

    if not found:
        # ---- SESSION A ----
        print("\nSESSION A — nothing stored yet, uploading")
        LOCAL.write_text(json.dumps(PAYLOAD, indent=2), encoding="utf-8")
        try:
            backend.create(title="Elementals checkpoint persistence test")
            print("  dataset created")
        except RuntimeError as error:
            print(f"  dataset already exists ({str(error).splitlines()[0][:60]})")
        ok, message = store.push_if_newer(backend, LOCAL, "persistence probe")
        print(f"  {message}")
        if not ok:
            print("\nFAILED: upload was refused.")
            return 1
        print("\n" + "=" * 70)
        print("SESSION A DONE")
        print("=" * 70)
        print(f"  1. Check https://www.kaggle.com/datasets/{slug} shows a version.")
        print("  2. Close this session completely (not just the tab).")
        print("  3. Open a NEW session and run this same script again.")
        print("     It will detect the upload and verify the download.")
        return 0

    # ---- SESSION B ----
    print("\nSESSION B — found stored data, verifying")
    restored = json.loads(probe.read_text())

    checks = []

    def check(label, condition, detail=""):
        checks.append(condition)
        print(f"  [{'PASS' if condition else 'FAIL'}] {label}{('  — ' + detail) if detail else ''}")

    check("downloaded from the dataset", True)
    check("content matches what was uploaded", restored == PAYLOAD)
    identity = restored.get("identity", {})
    for field in ["engineSha", "seed", "populationSize", "sigma", "promote", "tiersHash"]:
        check(f"identity preserved: {field}", identity.get(field) == PAYLOAD["identity"][field])
    check("CMA-ES state preserved", restored.get("cma") == PAYLOAD["cma"])
    check("RNG state preserved", restored.get("cma", {}).get("rngState") == 268449301)
    check("stage preserved", restored.get("stage") == "search")
    check("checkpoint version preserved", restored.get("version") == "v2")

    # The resume path the real run uses.
    target = WORK / "verify" / "resume" / "checkpoint.json"
    ok, message = store.pull_latest(backend, target)
    check("pull_latest recovers it", ok, message)

    print("\n" + "=" * 70)
    if all(checks):
        print("PERSISTENCE VERIFIED — a checkpoint survived losing the session.")
        print("=" * 70)
        print(f"\nDelete the test dataset when you are done:")
        print(f"  https://www.kaggle.com/datasets/{slug}  -> Settings -> Delete")
        return 0
    print("PERSISTENCE FAILED — do not start a multi-session run.")
    print("=" * 70)
    return 1


if __name__ == "__main__":
    sys.exit(main())
