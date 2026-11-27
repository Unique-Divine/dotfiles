"""Read WSL filesystem usage and measure cleanup candidates."""

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

SCAN_SECONDS = 20
MAX_RECORDS = 128
MAX_REPORT_BYTES = 512 * 1024


class Filesystem(TypedDict):
    totalBytes: int
    usedBytes: int
    availableBytes: int


class Candidate(TypedDict):
    kind: str
    path: str
    allocatedBytes: int
    note: str


class Trim(TypedDict):
    observedAt: str
    bytes: int
    method: str


class Diagnostic(TypedDict):
    source: str
    message: str


class Report(TypedDict):
    schemaVersion: int
    distro: str
    observedAt: str
    filesystem: Filesystem
    trim: Trim | None
    candidates: list[Candidate]
    errors: list[Diagnostic]


class ScanTimeout(Exception):
    pass


def remaining(deadline: float) -> float:
    available = deadline - time.monotonic()
    if available <= 0:
        raise ScanTimeout
    return available


def add_error(errors: list[Diagnostic], source: str, message: str) -> None:
    if len(errors) < MAX_RECORDS - 1:
        errors.append({"source": source, "message": message[:360]})
    elif len(errors) < MAX_RECORDS:
        errors.append({"source": "scan", "message": "Further diagnostics omitted."})


def git_worktrees(repo: Path, deadline: float) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", repo, "worktree", "list", "--porcelain", "-z"],
        check=True,
        capture_output=True,
        timeout=min(3, remaining(deadline)),
    )
    return [
        Path(os.fsdecode(field.removeprefix(b"worktree ")))
        for field in result.stdout.split(b"\0")
        if field.startswith(b"worktree ")
    ]


def target_relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path.name != "target":
        raise argparse.ArgumentTypeError("expected a relative path ending in target")
    return path


def real_directory(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path:
        raise ValueError(f"Skipping a symlink or non-directory: {path}")
    return info


def has_cargo_marker(path: Path) -> bool:
    for marker in (
        path.parent / "Cargo.toml",
        path / "CACHEDIR.TAG",
        path / ".rustc_info.json",
    ):
        try:
            if stat.S_ISREG(marker.lstat().st_mode):
                return True
        except FileNotFoundError:
            continue
    return False


def find_candidates(
    repos: list[Path],
    relatives: set[Path],
    root_device: int,
    deadline: float,
    errors: list[Diagnostic],
) -> dict[Path, str]:
    found: dict[Path, str] = {}
    trash_root = Path(os.environ.get("XDG_DATA_HOME", ""))
    if not trash_root.is_absolute():
        trash_root = Path.home() / ".local" / "share"
    trash = trash_root / "Trash"
    try:
        if real_directory(trash).st_dev == root_device:
            found[trash] = "trash"
        else:
            add_error(errors, "trash", f"Outside the measured filesystem: {trash}")
    except FileNotFoundError:
        pass
    except (OSError, RuntimeError, ValueError) as error:
        add_error(errors, "trash", str(error))

    checked: set[Path] = set()
    try:
        for repo in repos:
            try:
                worktrees = git_worktrees(repo, deadline)
            except (OSError, subprocess.SubprocessError) as error:
                add_error(errors, "worktree", f"{repo}: {error}")
                continue
            for worktree in worktrees:
                remaining(deadline)
                if worktree in checked:
                    continue
                checked.add(worktree)
                for relative in sorted(relatives):
                    remaining(deadline)
                    path = worktree / relative
                    try:
                        info = real_directory(path)
                        if info.st_dev != root_device:
                            add_error(
                                errors, "target", f"Outside measured filesystem: {path}"
                            )
                        elif has_cargo_marker(path):
                            found[path] = "rust-target"
                    except FileNotFoundError:
                        continue
                    except (OSError, RuntimeError, ValueError) as error:
                        add_error(errors, "target", str(error))
                    if len(found) >= MAX_RECORDS:
                        add_error(errors, "scan", "Reached the candidate count limit.")
                        return found
    except ScanTimeout:
        add_error(errors, "scan", "Time limit reached while listing worktrees.")
    return found


def measure(
    found: dict[Path, str], deadline: float, errors: list[Diagnostic]
) -> list[Candidate]:
    roots: dict[Path, str] = {}
    for path in sorted(found, key=lambda item: (len(item.parts), item)):
        if not any(path.is_relative_to(parent) for parent in roots):
            roots[path] = found[path]
    if not roots:
        return []
    try:
        # One GNU du invocation counts hard links once and avoids following links.
        result = subprocess.run(
            ["du", "-P", "-x", "-s", "-B1", "-0", "--", *roots],
            check=False,
            capture_output=True,
            timeout=remaining(deadline),
        )
        output = result.stdout
        partial = result.returncode != 0
        if partial:
            add_error(errors, "du", os.fsdecode(result.stderr).strip() or "du failed.")
    except subprocess.TimeoutExpired as error:
        output = error.stdout or b""
        partial = True
        add_error(errors, "du", "Time limit reached while measuring candidates.")
    except ScanTimeout:
        add_error(errors, "du", "No scan time remained for measuring candidates.")
        return []
    except OSError as error:
        add_error(errors, "du", str(error))
        return []

    notes = {
        "trash": "Review trash contents before emptying.",
        "rust-target": "Possible Rust build output. Check active builds and local tools.",
    }
    candidates: list[Candidate] = []
    # A timeout can leave an incomplete final record.
    for record in output.split(b"\0")[:-1]:
        number, separator, name = record.partition(b"\t")
        path = Path(os.fsdecode(name))
        if not separator or not number.isdigit() or path not in roots:
            add_error(errors, "du", "Unexpected size record from du.")
            continue
        kind = roots[path]
        candidates.append(
            {
                "kind": kind,
                "path": str(path),
                "allocatedBytes": int(number),
                "note": f"Partial scan. {notes[kind]}" if partial else notes[kind],
            }
        )
    return sorted(candidates, key=lambda row: (-row["allocatedBytes"], row["path"]))


def collect(
    distro: str, repos: list[Path], targets: set[Path], trim: Trim | None
) -> Report:
    if sys.platform != "linux":
        raise OSError("run this collector inside WSL")
    observed_at = datetime.now(UTC).isoformat()
    filesystem = os.statvfs("/")
    block_size = filesystem.f_frsize
    errors: list[Diagnostic] = []
    deadline = time.monotonic() + SCAN_SECONDS
    found = find_candidates(repos, targets, Path("/").stat().st_dev, deadline, errors)
    return {
        "schemaVersion": 1,
        "distro": distro,
        "observedAt": observed_at,
        "filesystem": {
            "totalBytes": filesystem.f_blocks * block_size,
            "usedBytes": (filesystem.f_blocks - filesystem.f_bfree) * block_size,
            "availableBytes": filesystem.f_bavail * block_size,
        },
        "trim": trim,
        "candidates": measure(found, deadline, errors),
        "errors": errors,
    }


def trim_evidence(observed_at: str, size: int) -> Trim:
    when = datetime.fromisoformat(observed_at)
    if when.tzinfo is None or when > datetime.now(UTC) or size < 0:
        raise ValueError(
            "TRIM requires a past timestamp with a timezone and nonnegative bytes"
        )
    return {
        "observedAt": when.astimezone(UTC).isoformat(),
        "bytes": size,
        "method": "fstrim",
    }


def windows_report_dir() -> Path:
    result = subprocess.run(
        ["cmd.exe", "/d", "/u", "/c", "echo %LOCALAPPDATA%"],
        capture_output=True,
        check=True,
        timeout=5,
    )
    local_app_data = result.stdout.decode("utf-16-le").strip()
    if len(local_app_data) < 3 or local_app_data[1:3] != ":\\":
        raise ValueError("Could not read the Windows LOCALAPPDATA path.")
    converted = subprocess.run(
        ["wslpath", "-u", local_app_data],
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    return Path(converted.stdout.strip()) / "WslCrossHub" / "guest-reports"


def previous_report(
    path: Path, distro: str
) -> tuple[str, datetime, Trim | None] | None:
    if sys.platform != "linux":
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPORT_BYTES:
                return None
            raw = handle.read(MAX_REPORT_BYTES).decode("utf-8")
            previous = json.loads(raw)
        if (
            type(previous["schemaVersion"]) is not int
            or previous["schemaVersion"] != 1
            or previous["distro"].casefold() != distro.casefold()
        ):
            return None
        filesystem = previous["filesystem"]
        if not all(
            type(filesystem[name]) is int and filesystem[name] >= 0
            for name in ("totalBytes", "usedBytes", "availableBytes")
        ) or not all(
            isinstance(previous[name], list) and len(previous[name]) <= MAX_RECORDS
            for name in ("candidates", "errors")
        ):
            return None
        observed_at = datetime.fromisoformat(previous["observedAt"])
        if observed_at.tzinfo is None or observed_at > datetime.now(UTC):
            return None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
    try:
        trim = previous["trim"]
        if trim["method"] == "fstrim" and type(trim["bytes"]) is int:
            return raw, observed_at, trim_evidence(trim["observedAt"], trim["bytes"])
    except (ValueError, TypeError, KeyError, AttributeError):
        pass
    return raw, observed_at, None


def encode(report: Report) -> str:
    data = json.dumps(report, separators=(",", ":")) + "\n"
    if len(data.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("Report exceeds 512 KiB.")
    return data


def publish(report: Report, directory: Path) -> str:
    if sys.platform != "linux":
        raise OSError("publish the guest report from inside WSL")
    from fcntl import LOCK_EX, LOCK_NB, flock

    directory.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(
        report["distro"].casefold().encode("utf-8")
    ).hexdigest()
    path = directory / f"{fingerprint}.json"
    flags = os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path.with_suffix(".lock"), flags, 0o600)
    with os.fdopen(fd, "wb") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("Guest report lock must be a regular file.")
        flock(lock, LOCK_EX | LOCK_NB)
        previous = previous_report(path, report["distro"])
        if previous is not None and previous[1] > datetime.fromisoformat(
            report["observedAt"]
        ):
            return previous[0]
        previous_trim = previous[2] if previous else None
        trim = report["trim"]
        if previous_trim is not None and (
            trim is None or previous_trim["observedAt"] > trim["observedAt"]
        ):
            report = {**report, "trim": previous_trim}
        data = encode(report)
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=directory, delete=False
            ) as temp:
                temp_path = Path(temp.name)
                temp.write(data)
                temp.flush()
                os.fsync(temp.fileno())
            temp_path.replace(path)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--distro", default=os.environ.get("WSL_DISTRO_NAME", ""))
    parser.add_argument("--repo", action="append", type=Path, default=[])
    parser.add_argument(
        "--target-relative", action="append", type=target_relative, default=[]
    )
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--report-dir", type=Path)
    parser.add_argument(
        "--trim-at", help="timestamp from a completed fstrim, with timezone"
    )
    parser.add_argument("--trim-bytes", type=int, help="bytes reported by fstrim")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("run this collector inside WSL")
    distro = args.distro.strip()
    if not distro or len(distro) > 128 or any(not c.isprintable() for c in distro):
        parser.error("set WSL_DISTRO_NAME or pass a valid --distro")
    if args.report_dir is not None and not args.publish:
        parser.error("--report-dir requires --publish")
    if (args.trim_at is None) != (args.trim_bytes is None):
        parser.error("--trim-at and --trim-bytes must be supplied together")
    try:
        trim = trim_evidence(args.trim_at, args.trim_bytes) if args.trim_at else None
        report = collect(
            distro, args.repo, {Path("target"), *args.target_relative}, trim
        )
        result = (
            publish(report, args.report_dir or windows_report_dir())
            if args.publish
            else encode(report)
        )
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"WSL Cross Hub guest report: {error}", file=sys.stderr)
        return 1
    sys.stdout.write(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
