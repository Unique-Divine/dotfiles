import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from guest_report import Report, collect, main, publish, target_relative

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="WSL collector")
SCRIPT = Path(__file__).with_name("guest_report.py")


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)


def cargo_target(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "CACHEDIR.TAG").write_text("dummy marker", encoding="utf-8")
    return path


def test_collector_measures_registered_targets_and_ignores_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "main checkout"
    repo.mkdir()
    git(repo, "init")
    git(
        repo,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initialize",
    )
    worktree = tmp_path / "linked checkout"
    git(repo, "worktree", "add", "--detach", str(worktree))
    first = cargo_target(repo / "target")
    second = cargo_target(worktree / "server" / "target")
    cargo_target(first / "nested" / "target")
    (first / "build").write_bytes(b"x" * 65536)
    os.link(first / "build", second / "build")
    (worktree / "target").symlink_to(first, target_is_directory=True)
    # A common directory name without Cargo evidence is not a candidate.
    (repo / "server" / "target").mkdir(parents=True)
    trash = tmp_path / "data" / "Trash"
    trash.mkdir(parents=True)
    monkeypatch.setenv("XDG_DATA_HOME", str(trash.parent))

    report = collect(
        "Ubuntu-24.04",
        [repo, worktree],
        {Path("target"), Path("server/target"), Path("target/nested/target")},
        None,
    )

    assert report["distro"] == "Ubuntu-24.04"
    assert report["filesystem"]["totalBytes"] > 0
    assert report["trim"] is None
    candidates = {Path(row["path"]): row for row in report["candidates"]}
    assert set(candidates) == {first, second, trash}
    assert candidates[first]["kind"] == candidates[second]["kind"] == "rust-target"
    assert candidates[trash]["kind"] == "trash"
    measured = sum(row["allocatedBytes"] for row in candidates.values())
    expected = subprocess.check_output(
        ["du", "-P", "-x", "-sc", "-B1", first, second, trash]
    )
    assert measured == int(expected.splitlines()[-1].partition(b"\t")[0])
    assert any("symlink" in error["message"] for error in report["errors"])


def test_cli_reports_and_publishes_with_retained_trim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu-24.04")
    report_dir = tmp_path / "Windows reports"

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, SCRIPT, *args],
            capture_output=True,
            check=True,
            text=True,
            timeout=10,
        )

    unrecorded = run()
    assert json.loads(unrecorded.stdout)["trim"] is None
    assert not report_dir.exists()

    args = ("--publish", "--report-dir", str(report_dir))
    first = run(*args, "--trim-at", "2026-01-01T10:00:00+02:00", "--trim-bytes", "137")
    fingerprint = hashlib.sha256(b"ubuntu-24.04").hexdigest()
    report_path = report_dir / f"{fingerprint}.json"
    assert first.stdout == report_path.read_text(encoding="utf-8")
    second = run(*args)
    assert second.stdout == report_path.read_text(encoding="utf-8")
    assert json.loads(second.stdout)["trim"] == {
        "observedAt": "2026-01-01T08:00:00+00:00",
        "bytes": 137,
        "method": "fstrim",
    }
    assert sorted(path.suffix for path in report_dir.iterdir()) == [".json", ".lock"]


@pytest.mark.parametrize("value", ["/repo/target", "server/../target", "server/build"])
def test_target_relative_rejects_paths_outside_contract(value: str) -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        target_relative(value)


def test_cli_requires_both_trim_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys, "argv", ["guest_report", "--distro", "Ubuntu", "--trim-bytes", "1"]
    )
    with pytest.raises(SystemExit, match="2"):
        main()


def test_slow_publisher_keeps_the_newer_observation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    first_to_finish = collect("Ubuntu", [], {Path("target")}, None)
    first_to_start: Report = {
        **first_to_finish,
        "observedAt": "2000-01-01T00:00:00+00:00",
    }
    current = publish(first_to_finish, tmp_path)

    assert publish(first_to_start, tmp_path) == current
    assert next(tmp_path.glob("*.json")).read_text(encoding="utf-8") == current
