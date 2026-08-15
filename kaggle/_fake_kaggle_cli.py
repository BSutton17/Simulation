"""
A stand-in for the `kaggle` command line tool, for tests.

The persistence code shells out to the real CLI. Testing it against a mock of
our own functions would prove only that our mock matches our expectations, so
this emulates the CLI itself: same subcommands, same flags, same zip-on-upload
and unzip-on-download behaviour, same "dataset already exists" failure. Our code
runs completely unmodified against it.

What it does NOT prove: that Kaggle's servers behave this way. Those parts —
authentication, quota, dataset visibility, propagation delay — can only be
checked by running against Kaggle. The manual steps are in README.

State lives in the directory named by FAKE_KAGGLE_ROOT, one subdirectory per
dataset slug, one numbered subdirectory per version.
"""

import json
import os
import shutil
import sys
import zipfile
from pathlib import Path


def root():
    value = os.environ.get("FAKE_KAGGLE_ROOT")
    if not value:
        sys.stderr.write("FAKE_KAGGLE_ROOT is not set\n")
        sys.exit(2)
    path = Path(value)
    path.mkdir(parents=True, exist_ok=True)
    return path


def require_credentials():
    """The real CLI refuses to do anything without credentials."""
    token = Path.home() / ".kaggle" / "kaggle.json"
    if not token.exists() and not (os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY")):
        sys.stderr.write("Could not find kaggle.json. Authentication failed.\n")
        sys.exit(1)


def dataset_dir(slug):
    return root() / slug.replace("/", "__")


def versions(slug):
    d = dataset_dir(slug)
    if not d.exists():
        return []
    return sorted((p for p in d.iterdir() if p.is_dir() and p.name.startswith("v")),
                  key=lambda p: int(p.name[1:]))


def flag(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


def publish(slug, source_dir, message):
    """Zips the payload the way the real CLI does with --dir-mode zip."""
    target = dataset_dir(slug) / f"v{len(versions(slug)) + 1}"
    target.mkdir(parents=True, exist_ok=True)
    archive = target / "archive.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in Path(source_dir).iterdir():
            # dataset-metadata.json is configuration, not payload.
            if path.is_file() and path.name != "dataset-metadata.json":
                zf.write(path, path.name)
    (target / "message.txt").write_text(message or "", encoding="utf-8")
    return target


def main(argv):
    if len(argv) < 2 or argv[0] != "datasets":
        sys.stderr.write(f"unsupported command: {' '.join(argv)}\n")
        return 2

    sub = argv[1]
    args = argv[2:]
    require_credentials()

    if sub == "create":
        source = flag(args, "-p")
        metadata = json.loads((Path(source) / "dataset-metadata.json").read_text())
        slug = metadata["id"]
        if versions(slug):
            sys.stderr.write("ERROR: dataset already exists\n")
            return 1
        publish(slug, source, "initial")
        print(f"Your private Dataset is being created. Please check progress at https://www.kaggle.com/{slug}")
        return 0

    if sub == "version":
        source = flag(args, "-p")
        metadata = json.loads((Path(source) / "dataset-metadata.json").read_text())
        slug = metadata["id"]
        if not versions(slug):
            sys.stderr.write("ERROR: dataset not found\n")
            return 1
        publish(slug, source, flag(args, "-m", ""))
        print("Dataset version is being created. Please check progress at ...")
        return 0

    if sub == "download":
        slug = flag(args, "-d")
        destination = Path(flag(args, "-p", "."))
        available = versions(slug)
        if not available:
            sys.stderr.write("404 - Not Found\n")
            return 1
        destination.mkdir(parents=True, exist_ok=True)
        archive = available[-1] / "archive.zip"  # newest version wins
        if "--unzip" in args:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(destination)
        else:
            shutil.copy(archive, destination / "archive.zip")
        print(f"Downloading {slug} to {destination}")
        return 0

    if sub == "list":
        needle = flag(args, "-s", "")
        for path in root().iterdir():
            slug = path.name.replace("__", "/")
            if needle in slug:
                print(slug)
        return 0

    sys.stderr.write(f"unsupported subcommand: {sub}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
