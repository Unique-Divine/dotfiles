"""Publish the worker to the local directory used by the Windows boot task."""

import argparse
import os
import stat
from pathlib import Path
from tempfile import NamedTemporaryFile


def is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def matches_worker(path: Path, source: bytes) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if is_link(info) or not stat.S_ISREG(info.st_mode) or path.read_bytes() != source:
        raise ValueError(f"A different worker is already installed at {path}.")
    return True


def publish_worker(source: Path, install_root: Path) -> None:
    contents = source.read_bytes()
    try:
        info = install_root.lstat()
    except FileNotFoundError:
        install_root.mkdir(parents=True, exist_ok=True)
        info = install_root.lstat()
    if is_link(info) or not stat.S_ISDIR(info.st_mode):
        raise ValueError(
            "The stable app directory must be a local directory, without a junction."
        )

    destination = install_root / "worker.py"
    if matches_worker(destination, contents):
        return

    staged_path = None
    try:
        with NamedTemporaryFile(
            dir=install_root, prefix="worker.", suffix=".tmp", delete=False
        ) as staged:
            staged_path = Path(staged.name)
            staged.write(contents)
        if staged_path.read_bytes() != contents:
            raise ValueError("The copied worker did not match the source.")
        try:
            # Windows rename is atomic and rejects an existing destination.
            # On POSIX, link provides the same no-overwrite behavior for tests.
            if os.name == "nt":
                staged_path.rename(destination)
            else:
                destination.hardlink_to(staged_path)
        except FileExistsError:
            if not matches_worker(destination, contents):
                raise
    finally:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("install_root", type=Path)
    options = parser.parse_args()
    try:
        publish_worker(options.source, options.install_root)
    except (OSError, ValueError) as error:
        # The launcher captures stdout and includes the error in its JSON result.
        print(error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
