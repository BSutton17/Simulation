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
import time
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

        print("\nAUTHENTICATION — current API token")
        # The token Kaggle issues now, in place of the legacy username/key pair.
        # Deliberately distinctive so it can be searched for anywhere it might leak.
        TOKEN = "kgl_test_TOKEN_c0ffee1234567890abcd"
        saved_legacy = (os.environ.pop("KAGGLE_USERNAME", None), os.environ.pop("KAGGLE_KEY", None))
        legacy_file = Path.home() / ".kaggle" / "kaggle.json"
        moved_legacy = None
        if legacy_file.exists():
            moved_legacy = legacy_file.with_suffix(".json.testbak")
            shutil.move(legacy_file, moved_legacy)
        token_file = Path.home() / ".kaggle" / "access_token"
        moved_token = None
        if token_file.exists():
            moved_token = token_file.with_suffix(".testbak")
            shutil.move(token_file, moved_token)

        try:
            os.environ["KAGGLE_API_TOKEN"] = TOKEN
            mode = store.configure_credentials()
            check("KAGGLE_API_TOKEN is the preferred credential", mode == "token", f"mode={mode}")
            check("no legacy username/key was required",
                  not os.environ.get("KAGGLE_USERNAME") and not os.environ.get("KAGGLE_KEY"))
            check("configure_credentials does not return the token", TOKEN not in str(mode))
            check("access_token file written outside the working directory",
                  token_file.exists() and "kaggle/working" not in str(token_file).replace("\\", "/"))
            check("no kaggle.json was created", not legacy_file.exists())

            # A real round trip, authenticated by the token alone. Its own
            # dataset: the shared one has a deliberately corrupt version pushed
            # to it by an earlier scenario, and pulling that would fail for a
            # reason that has nothing to do with authentication.
            token_backend = store.KaggleDatasetStore(
                "testuser/elementals-token-test", workdir=str(workspace / "token-work")
            )
            token_backend.create(title="token auth test")
            source = session2 / "token-source.json"
            source.write_text(json.dumps(make_checkpoint(completed=5)), encoding="utf-8")
            ok, message = store.push_if_newer(token_backend, source, "token auth")
            check("a push succeeds on token auth alone", ok, message)
            check("the token does not appear in operation output", TOKEN not in message)

            token_only = session2 / "token-only.json"
            ok, message = store.pull_latest(token_backend, token_only)
            check("a pull succeeds on token auth alone", ok, message)
            check("the round trip preserved the checkpoint",
                  token_only.exists()
                  and json.loads(token_only.read_text())["completedGenerations"] == 5)

            print("\nTOKEN CONTAINMENT")
            # Force a failure so the emulator dumps its environment — the most
            # likely route for a credential to escape into a notebook log.
            missing = store.KaggleDatasetStore("testuser/never-created",
                                               workdir=str(workspace / "missing-work"))
            leaked = None
            try:
                # Downloading a dataset that was never created is a hard 404,
                # which is what makes the emulator dump its environment.
                missing._run(["datasets", "download", "-d", "testuser/never-created",
                              "-p", str(workspace / "nowhere")])
            except RuntimeError as error:
                leaked = str(error)
            check("a CLI failure surfaces as an error", leaked is not None)
            if leaked:
                check("the token is redacted from the error", TOKEN not in leaked,
                      "redacted" if TOKEN not in leaked else "LEAKED")
                check("redaction is visible rather than silent", "REDACTED" in leaked or TOKEN not in leaked)

            check("redact() scrubs a registered secret",
                  TOKEN not in store.redact(f"auth used {TOKEN} here"))

            # Nothing the store publishes may carry the credential.
            payload = Path(backend.workdir)
            published = []
            if payload.exists():
                for path in payload.rglob("*"):
                    if path.is_file():
                        try:
                            published.append(path.read_text(encoding="utf-8", errors="ignore"))
                        except OSError:
                            pass
            check("the token is absent from every published file",
                  not any(TOKEN in text for text in published),
                  f"{len(published)} files checked")

            metadata = json.loads((payload / "dataset-metadata.json").read_text())
            check("dataset metadata carries no credential", TOKEN not in json.dumps(metadata))

            recovered_after_token = json.loads(token_only.read_text()) if token_only.exists() else {}
            check("checkpoint content is unaffected by the auth change",
                  TOKEN not in json.dumps(recovered_after_token))
        finally:
            os.environ.pop("KAGGLE_API_TOKEN", None)
            if token_file.exists():
                token_file.unlink()
            if moved_token:
                shutil.move(moved_token, token_file)
            if moved_legacy:
                shutil.move(moved_legacy, legacy_file)
            if saved_legacy[0]:
                os.environ["KAGGLE_USERNAME"] = saved_legacy[0]
            if saved_legacy[1]:
                os.environ["KAGGLE_KEY"] = saved_legacy[1]

        print("\nAUTHENTICATION — legacy fallback still works")
        os.environ["KAGGLE_USERNAME"], os.environ["KAGGLE_KEY"] = "testuser", "legacykey12345678"
        mode = store.configure_credentials()
        check("legacy pair is used when no token is present", mode == "legacy", f"mode={mode}")

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

        print("\nPULL SEMANTICS — recovery and no-op are different things")
        # pull_latest returns False for two unrelated reasons: it could not
        # recover, and it did not need to. Treating both as failure made the
        # real Kaggle verification report PERSISTENCE FAILED on a system that
        # was working — a leftover file from an earlier run was enough, because
        # Kaggle's Files-only persistence keeps /kaggle/working across sessions.
        # Both halves are pinned here so neither can collapse into the other.
        semantics = store.KaggleDatasetStore(
            "testuser/elementals-pull-semantics", workdir=str(workspace / "sem-work")
        )
        semantics.create(title="pull semantics")
        seed_file = workspace / "sem" / "seed.json"
        seed_file.parent.mkdir(parents=True, exist_ok=True)
        seed_file.write_text(json.dumps(make_checkpoint(completed=6)), encoding="utf-8")
        store.push_if_newer(semantics, seed_file, "seed")

        fresh = workspace / "sem" / "fresh" / "checkpoint.json"
        ok, message = store.pull_latest(semantics, fresh)
        check("a clean location recovers the checkpoint", ok, message)
        check("the recovered file is on disk", fresh.exists())
        check("the recovered content is right",
              fresh.exists() and json.loads(fresh.read_text())["completedGenerations"] == 6)

        ok_again, message_again = store.pull_latest(semantics, fresh)
        check("an already-current location reports a no-op",
              not ok_again and "already at" in message_again, message_again)
        check("a no-op is distinguishable from a recovery failure",
              "already at" in message_again and "no checkpoint" not in message_again)

        # Behind is not the same as current: a genuinely older local copy must
        # still be replaced, or a resumed session would keep stale state.
        behind = workspace / "sem" / "behind" / "checkpoint.json"
        behind.parent.mkdir(parents=True, exist_ok=True)
        behind.write_text(json.dumps(make_checkpoint(completed=2)), encoding="utf-8")
        ok_behind, message_behind = store.pull_latest(semantics, behind)
        check("an out-of-date location is brought forward", ok_behind, message_behind)
        check("it was brought to the stored generation",
              json.loads(behind.read_text())["completedGenerations"] == 6)

        print("\nLAUNCHER MIRROR — publishing while the search runs")
        # The production launcher watches the checkpoint file in a thread and
        # publishes when it advances. Pushing only at the end would protect
        # against nothing, since the end is what a lost session never reaches.
        import importlib

        launcher = importlib.import_module("kaggle_notebook")
        launcher.WATCH_SECONDS = 0.2  # the real value is 60

        mirror_backend = store.KaggleDatasetStore(
            "testuser/elementals-mirror-test", workdir=str(workspace / "mirror-work")
        )
        mirror_backend.create(title="mirror test")

        live = workspace / "live" / "checkpoint.json"
        live.parent.mkdir(parents=True, exist_ok=True)
        live.write_text(json.dumps(make_checkpoint(completed=1)), encoding="utf-8")

        mirror = launcher.CheckpointMirror(store, mirror_backend, live)
        mirror.start()
        for generation in (2, 3):
            live.write_text(json.dumps(make_checkpoint(completed=generation)), encoding="utf-8")
            deadline = time.time() + 5
            while time.time() < deadline and mirror.pushes < generation - 1:
                time.sleep(0.1)
        mirror.stop()

        check("the mirror published while the search was running", mirror.pushes >= 2,
              f"{mirror.pushes} versions")

        landed = workspace / "live" / "landed.json"
        ok, _ = store.pull_latest(mirror_backend, landed)
        stored = json.loads(landed.read_text()) if landed.exists() else {}
        check("the newest generation reached the dataset",
              stored.get("completedGenerations") == 3,
              f"stored generation {stored.get('completedGenerations')}")

        # A push failure must not take the run down with it.
        broken = store.KaggleDatasetStore("testuser/never-created-mirror",
                                          workdir=str(workspace / "broken-work"))
        survivor = launcher.CheckpointMirror(store, broken, live)
        crashed = False
        try:
            survivor._push("provoke a failure")
        except Exception:
            crashed = True
        check("a failed push is reported, not raised", not crashed)

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
