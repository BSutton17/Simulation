"""
Checkpoint persistence across Kaggle sessions.

THE PROBLEM
-----------
`/kaggle/working` belongs to a session, not to a notebook. Closing the tab,
reopening the notebook, or being handed a new Draft Session gives you a fresh,
empty `/kaggle/working`. A checkpoint written there is safe from interruption
*within* a session and gone the moment the session is.

That is what cost the first production attempt: generation 1 completed after
~105 minutes, the checkpoint was written correctly, and the session was
replaced. The simulation was never the problem.

WHAT KAGGLE ACTUALLY OFFERS
---------------------------
Three mechanisms persist data past a session, and they are not equivalent:

1. Save Version / "Save & Run All (Commit)"
   Runs the notebook top to bottom in a batch session and keeps `/kaggle/working`
   as that version's output. Later notebooks can attach it via
   "Add Data -> Notebook Output". Reliable, needs no credentials — but only
   captures state when the batch run ENDS. A 9-hour interactive session that
   completes six generations and is then replaced saves nothing.

2. Kaggle Datasets via the Kaggle API
   A dataset can be created once and given a new version whenever we like, from
   inside the running notebook. This is the only option that persists a
   checkpoint DURING a session, generation by generation, so an unexpectedly
   lost session costs at most one generation. Needs an API token.

3. Manual download / upload
   Always works, needs no setup, and depends on a human being awake at the
   right moment.

This module implements (2) with (3) as the documented fallback, because only
(2) matches how the search actually fails.

CREDENTIALS
-----------
No token is stored in this repository, and none should ever be committed. The
token is read from Kaggle's own secret store (Add-ons -> Secrets) at runtime.
Setup instructions are in README under "Kaggle".
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

# --------------------------------------------------------------------------
# Backends
# --------------------------------------------------------------------------


class LocalStore:
    """
    Persistence to a directory.

    Used for development and for the automated tests, and it is a real backend
    rather than a mock: the resume logic, the freshness comparison and the
    integrity checks are the same code the Kaggle backend runs. Only the
    transport differs.
    """

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def name(self):
        return f"local:{self.root}"

    def push(self, path, note=""):
        target = self.root / "checkpoint.json"
        temporary = self.root / "checkpoint.json.tmp"
        shutil.copy(path, temporary)
        os.replace(temporary, target)  # atomic within a filesystem
        return True

    def pull(self, destination):
        source = self.root / "checkpoint.json"
        if not source.exists():
            return False
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, destination)
        return True


class KaggleDatasetStore:
    """
    Persistence to a Kaggle Dataset, one version per push.

    Every push creates a new dataset version, so the history is recoverable if a
    checkpoint is ever written wrong — which matters more than it sounds, since
    a corrupted checkpoint pushed over a good one would otherwise end the run.
    """

    def __init__(self, slug, workdir="/kaggle/working/_ckpt"):
        # slug is "username/dataset-name"
        self.slug = slug
        self.workdir = Path(workdir)

    @property
    def name(self):
        return f"kaggle:{self.slug}"

    def _run(self, args, check=True):
        result = subprocess.run(
            ["kaggle", *args], capture_output=True, text=True
        )
        if check and result.returncode != 0:
            raise RuntimeError(
                f"kaggle {' '.join(args)} failed ({result.returncode}):\n"
                f"{result.stdout}\n{result.stderr}"
            )
        return result

    def exists(self):
        owner, name = self.slug.split("/", 1)
        result = self._run(["datasets", "list", "-m", "-s", name], check=False)
        return result.returncode == 0 and self.slug in result.stdout

    def create(self, title=None):
        """Creates the dataset. Only needed once, ever."""
        self.workdir.mkdir(parents=True, exist_ok=True)
        owner, name = self.slug.split("/", 1)
        metadata = {
            "title": title or name,
            "id": self.slug,
            "licenses": [{"name": "CC0-1.0"}],
        }
        (self.workdir / "dataset-metadata.json").write_text(json.dumps(metadata, indent=2))
        # A dataset cannot be created empty.
        placeholder = self.workdir / "checkpoint.json"
        if not placeholder.exists():
            placeholder.write_text("{}")
        self._run(["datasets", "create", "-p", str(self.workdir), "--dir-mode", "zip"])
        return True

    def push(self, path, note=""):
        self.workdir.mkdir(parents=True, exist_ok=True)
        owner, name = self.slug.split("/", 1)
        (self.workdir / "dataset-metadata.json").write_text(
            json.dumps({"title": name, "id": self.slug, "licenses": [{"name": "CC0-1.0"}]}, indent=2)
        )
        shutil.copy(path, self.workdir / "checkpoint.json")
        self._run(
            ["datasets", "version", "-p", str(self.workdir), "-m", note or "checkpoint", "--dir-mode", "zip"]
        )
        return True

    def pull(self, destination):
        self.workdir.mkdir(parents=True, exist_ok=True)
        download = self.workdir / "download"
        if download.exists():
            shutil.rmtree(download)
        download.mkdir(parents=True)
        result = self._run(["datasets", "download", "-d", self.slug, "-p", str(download), "--unzip"], check=False)
        if result.returncode != 0:
            return False
        found = list(download.rglob("checkpoint.json"))
        if not found:
            return False
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(found[0], destination)
        return True


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------


def configure_credentials():
    """
    Puts a Kaggle API token where the CLI expects it, from Kaggle Secrets.

    Reads the secrets named KAGGLE_USERNAME and KAGGLE_KEY. Nothing is printed
    and nothing is written to the repository — the token lands in
    ~/.kaggle/kaggle.json with owner-only permissions, which is where the CLI
    looks and nowhere a notebook output would capture it.

    Returns the username, or None when secrets are not configured.
    """
    username = os.environ.get("KAGGLE_USERNAME")
    key = os.environ.get("KAGGLE_KEY")

    if not (username and key):
        try:
            from kaggle_secrets import UserSecretsClient  # only exists on Kaggle

            secrets = UserSecretsClient()
            username = secrets.get_secret("KAGGLE_USERNAME")
            key = secrets.get_secret("KAGGLE_KEY")
        except Exception as error:  # not on Kaggle, or secrets not attached
            print(f"  Kaggle secrets unavailable: {type(error).__name__}")
            return None

    if not (username and key):
        return None

    path = Path.home() / ".kaggle" / "kaggle.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"username": username, "key": key}))
    path.chmod(0o600)
    os.environ["KAGGLE_USERNAME"] = username
    os.environ["KAGGLE_KEY"] = key
    return username


# --------------------------------------------------------------------------
# The logic both backends share
# --------------------------------------------------------------------------


def read_checkpoint(path):
    """Parses a checkpoint, returning None if it is absent or unreadable."""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or "identity" not in data:
        return None
    return data


def describe(checkpoint):
    if checkpoint is None:
        return "none"
    identity = checkpoint.get("identity", {})
    return (
        f"gen {checkpoint.get('completedGenerations')}/{identity.get('generations')} "
        f"stage={checkpoint.get('stage')} "
        f"seed={identity.get('seed')} promote={identity.get('promote')} "
        f"engine={str(identity.get('engineSha'))[:10]}"
    )


def is_newer(candidate, incumbent):
    """
    Whether `candidate` represents more finished work than `incumbent`.

    Compares progress rather than timestamps. A clock is the wrong instrument
    here: two sessions can overlap, and a checkpoint written later is not
    necessarily further along. Generations first, then the stage, so a run whose
    validation has finished is never overwritten by the same run mid-validation.
    """
    if incumbent is None:
        return True
    if candidate is None:
        return False
    stages = {"search": 0, "validation": 1, "complete": 2}
    a = (candidate.get("completedGenerations", -1), stages.get(candidate.get("stage"), -1))
    b = (incumbent.get("completedGenerations", -1), stages.get(incumbent.get("stage"), -1))
    return a > b


def same_run(a, b):
    """
    Whether two checkpoints describe the same experiment.

    Guards against restoring a checkpoint from an unrelated run into this one —
    the TypeScript side would refuse it anyway, but failing here gives a clear
    message instead of a silent fresh start after a long download.
    """
    if a is None or b is None:
        return False
    keys = ["engineSha", "seed", "populationSize", "sigma", "promote", "tiersHash",
            "schemaVersion", "catalogHash", "fitnessVersion", "optimizerVersion", "weightsName"]
    ia, ib = a.get("identity", {}), b.get("identity", {})
    return all(ia.get(k) == ib.get(k) for k in keys)


def push_if_newer(store, local_path, note=""):
    """
    Publishes the local checkpoint, unless the store already holds better.

    The guard matters on resume: a session that pulls generation 6, crashes
    before finishing generation 7 and is restarted must not push its stale
    copy over the good one.
    """
    local = read_checkpoint(local_path)
    if local is None:
        return False, "no local checkpoint to push"

    remote_path = Path(str(local_path) + ".remote")
    remote = read_checkpoint(remote_path) if store.pull(remote_path) else None

    if not is_newer(local, remote):
        return False, f"store already has {describe(remote)}; local is {describe(local)}"

    store.push(local_path, note or describe(local))
    return True, f"pushed {describe(local)} to {store.name}"


def pull_latest(store, local_path):
    """Fetches the stored checkpoint if it is ahead of what is on disk."""
    candidate = Path(str(local_path) + ".candidate")
    if not store.pull(candidate):
        return False, f"no checkpoint in {store.name}"

    remote = read_checkpoint(candidate)
    if remote is None:
        return False, "stored checkpoint is unreadable — refusing to use it"

    local = read_checkpoint(local_path)
    if local is not None and not same_run(remote, local):
        return False, "stored checkpoint is from a different run — refusing to mix them"
    if not is_newer(remote, local):
        return False, f"local copy is already at {describe(local)}"

    Path(local_path).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(candidate, local_path)
    return True, f"restored {describe(remote)} from {store.name}"
