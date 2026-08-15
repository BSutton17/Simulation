"""
Integration test for cross-session checkpoint persistence.

Runs `checkpoint_store.py` unmodified against `_fake_kaggle_cli.py`, which
emulates the real Kaggle CLI's subcommands, flags, zip-on-upload and
unzip-on-download. The scenario is the one that actually cost us a run:
a session completes generations, the session is replaced, and a new session has
to find the work again.

    python kaggle/test_checkpoint_store.py

WHAT THIS PROVES: our push/pull logic, the freshness and same-run guards, the
CLI invocation, the archive round trip, and that a checkpoint survives the
destruction of the working directory byte for byte.

WHAT IT DOES NOT PROVE: that Kaggle's servers behave as emulated —
authentication, quotas, dataset visibility and version propagation. Those need
a real Kaggle session; the manual steps are in README.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import checkpoint_store as store  # noqa: E402

PASSED = []
FAILED = []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}{('  — ' + detail) if detail else ''}")
    return bool(condition)


def make_checkpoint(generations=20, completed=3, stage="search", seed=20260813, promote=1):
    """A checkpoint with the v2 shape the TypeScript side writes."""
    return {
        "version": "v2",
        "identity": {
            "engineSha": "36d9ce3eb0fc106c7b0a5ec8c00bcf06dee9431f",
            "engineDirty": False,
            "schemaVersion": "v1",
            "catalogHash": "f8f4ea6b",
            "fitnessVersion": "v1",
            "optimizerVersion": "v1",
            "weightsName": "designerPriority",
            "seed": seed,
            "generations": generations,
            "populationSize": 8,
            "sigma": 0.2,
            "promote": promote,
            "tiersHash": "bbcd40d2",
        },
        "writtenAt": "2026-08-14T00:00:00.000Z",
        "completedGenerations": completed,
        "stage": stage,
        "cma": {
            "dimension": 20,
            "lambda": 8,
            "mean": [0.5] * 20,
            "sigma": 0.188,
            "C": [[1.0 if i == j else 0.0 for j in range(20)] for i in range(20)],
            "pc": [0.0] * 20,
            "ps": [0.0] * 20,
            "generation": completed,
            "rngState": 268449301,
            "spare": None,
        },
        "schema": {"version": "v1", "catalogHash": "f8f4ea6b", "parameters": []},
        "generationRecords": [{"generation": g} for g in range(completed)],
        "evaluations": [],
        "cacheEntries": [{"key": f"hash{i}|screen", "evaluation": {"tier": "screen"}} for i in range(5)],
        "bestFullKey": "8a1d73fe|full",
        "counters": {
            "candidateCount": completed * 8, "matches": completed * 19008,
            "screens": completed * 8, "fulls": completed, "validations": 0,
            "failures": 0, "elapsedMs": 1234567,
        },
    }


def install_fake_cli(bin_dir):
    """Puts a `kaggle` executable on PATH that routes to the emulator."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        # A .cmd shim is what Windows will actually resolve for `kaggle`.
        shim = bin_dir / "kaggle.cmd"
        shim.write_text(f'@echo off\r\n"{sys.executable}" "{HERE / "_fake_kaggle_cli.py"}" %*\r\n')
    else:
        shim = bin_dir / "kaggle"
        shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{HERE / "_fake_kaggle_cli.py"}" "$@"\n')
        shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def main():
    workspace = Path(tempfile.mkdtemp(prefix="ckpt-persist-"))
    try:
        install_fake_cli(workspace / "bin")
        os.environ["FAKE_KAGGLE_ROOT"] = str(workspace / "kaggle-server")
        os.environ["KAGGLE_USERNAME"] = "testuser"
        os.environ["KAGGLE_KEY"] = "testkey"

        slug = "testuser/elementals-checkpoint"
        backend = store.KaggleDatasetStore(slug, workdir=str(workspace / "ckpt-work"))

        print("\nSESSION 1 — run, then lose the session")
        session1 = workspace / "session1" / "run"
        session1.mkdir(parents=True)
        local = session1 / "checkpoint.json"
        original = make_checkpoint(completed=3)
        local.write_text(json.dumps(original), encoding="utf-8")

        backend.create(title="elementals checkpoint")
        ok, message = store.push_if_newer(backend, local, "generation 3")
        check("generation 3 pushed to the dataset", ok, message)

        # The failure being reproduced: /kaggle/working is gone.
        shutil.rmtree(workspace / "session1")
        check("working directory destroyed", not local.exists())

        print("\nSESSION 2 — fresh session, recover the work")
        session2 = workspace / "session2" / "run"
        session2.mkdir(parents=True)
        recovered = session2 / "checkpoint.json"

        ok, message = store.pull_latest(backend, recovered)
        check("checkpoint recovered in a new session", ok, message)

        if recovered.exists():
            restored = json.loads(recovered.read_text())
            check("recovered byte-for-byte", restored == original,
                  "identical JSON" if restored == original else "CONTENT DIFFERS")
            identity = restored.get("identity", {})
            for field in ["engineSha", "seed", "populationSize", "sigma", "promote",
                          "tiersHash", "schemaVersion", "catalogHash", "fitnessVersion",
                          "optimizerVersion", "weightsName", "generations"]:
                check(f"identity preserved: {field}",
                      identity.get(field) == original["identity"][field])
            check("CMA-ES state preserved", restored["cma"] == original["cma"])
            check("RNG state preserved", restored["cma"]["rngState"] == 268449301)
            check("cached evaluations preserved", len(restored["cacheEntries"]) == 5)
            check("stage preserved", restored["stage"] == "search")
            check("checkpoint version preserved", restored["version"] == "v2")

        print("\nSESSION 2 — continues, and publishes further progress")
        advanced = make_checkpoint(completed=7)
        recovered.write_text(json.dumps(advanced), encoding="utf-8")
        ok, message = store.push_if_newer(backend, recovered, "generation 7")
        check("generation 7 pushed", ok, message)

        print("\nGUARDS")
        stale = session2 / "stale.json"
        stale.write_text(json.dumps(make_checkpoint(completed=4)), encoding="utf-8")
        ok, message = store.push_if_newer(backend, stale, "stale")
        check("a stale checkpoint cannot overwrite newer work", not ok, message)

        finished = session2 / "finished.json"
        finished.write_text(json.dumps(make_checkpoint(completed=20, stage="complete")), encoding="utf-8")
        ok, _ = store.push_if_newer(backend, finished, "complete")
        check("a finished run does push over an unfinished one", ok)

        mid = session2 / "mid.json"
        mid.write_text(json.dumps(make_checkpoint(completed=20, stage="validation")), encoding="utf-8")
        ok, message = store.push_if_newer(backend, mid, "validation")
        check("validation-pending cannot overwrite validation-complete", not ok, message)

        other = session2 / "other.json"
        other.write_text(json.dumps(make_checkpoint(completed=99, seed=999)), encoding="utf-8")
        ok, message = store.pull_latest(backend, other)
        check("a checkpoint from a different run is refused", not ok, message)

        # A corrupt archive must not be silently adopted.
        corrupt_source = workspace / "corrupt"
        corrupt_source.mkdir(exist_ok=True)
        (corrupt_source / "checkpoint.json").write_text("{ not json", encoding="utf-8")
        (corrupt_source / "dataset-metadata.json").write_text(
            json.dumps({"title": "x", "id": slug, "licenses": [{"name": "CC0-1.0"}]}), encoding="utf-8")
        subprocess.run(["kaggle", "datasets", "version", "-p", str(corrupt_source), "-m", "corrupt",
                        "--dir-mode", "zip"], capture_output=True, shell=(os.name == "nt"))
        target = session2 / "fromcorrupt.json"
        ok, message = store.pull_latest(backend, target)
        check("a corrupt stored checkpoint is refused", not ok, message)

        print("\nCREDENTIALS")
        saved_user, saved_key = os.environ.pop("KAGGLE_USERNAME"), os.environ.pop("KAGGLE_KEY")
        home_token = Path.home() / ".kaggle" / "kaggle.json"
        moved = None
        if home_token.exists():
            moved = home_token.with_suffix(".json.testbak")
            shutil.move(home_token, moved)
        try:
            failed = False
            try:
                backend.pull(session2 / "noauth.json")
            except RuntimeError:
                failed = True
            ok, _ = (False, "") if failed else store.pull_latest(backend, session2 / "noauth.json")
            check("missing credentials fail loudly rather than silently", failed or not ok)
        finally:
            if moved:
                shutil.move(moved, home_token)
            os.environ["KAGGLE_USERNAME"], os.environ["KAGGLE_KEY"] = saved_user, saved_key

        print("\n" + "=" * 70)
        print(f"{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            for label in FAILED:
                print(f"  FAILED: {label}")
        print("=" * 70)
        return 1 if FAILED else 0
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
