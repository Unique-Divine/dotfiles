"""Exercise the WSL CLI through a fake Windows PowerShell executable."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest

CLI = Path(__file__).with_name("hub_cli.py")

FAKE_POWERSHELL = r"""
import json
import os
import sys

script = sys.argv[-1]
with open(os.environ['HUB_TEST_CALLS'], 'a') as calls:
    calls.write(json.dumps(script) + '\n')

if os.environ.get('HUB_INTEROP_FAIL'):
    print('interop unavailable', file=sys.stderr)
    sys.exit(1)

print('WSL_CROSS_HUB_READY')
if '& $client -Operation logs' in script or '& $client -Operation doctor-agent-logs' in script:
    print(os.environ['HUB_TEST_JOURNAL'], end='')
elif '& $status' in script:
    print(os.environ['HUB_TEST_STATUS'])
elif '& $client -Operation doctor\n' in script:
    print(json.dumps({'checks': [{'id': 'windows-ssh', 'host': 'windows',
        'state': 'failed', 'detail': 'Service is stopped', 'runners': ['codex'] }]}))
elif '& $client' in script:
    print(json.dumps({'job_id': os.environ['HUB_TEST_JOB'], 'state': 'accepted'}))
elif '-MaintenanceSetup' in script:
    state = 'installed' if '-Apply' in script else 'preview'
    print(json.dumps({'setup': {'state': state}}))
else:
    print(os.environ['HUB_TEST_DOCTOR'])
"""


@pytest.fixture
def windows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    if sys.platform == "win32":
        pytest.skip("fake PowerShell uses a POSIX executable")
    fake_tools = tmp_path / "fake tools"
    fake_tools.mkdir()
    powershell = fake_tools / "powershell.exe"
    powershell.write_text(f"#!{sys.executable}\n{FAKE_POWERSHELL}")
    powershell.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    monkeypatch.setenv("PATH", os.pathsep.join((str(fake_tools), os.environ["PATH"])))
    monkeypatch.setenv("HUB_TEST_CALLS", str(calls))
    monkeypatch.setenv("HUB_TEST_JOB", str(uuid4()))
    ready_report = {
        "runtime": {"state": "ready"},
        "task": {"status": "registered"},
        "worker": {"state": "ready", "maintenance_protocol": 1},
        "compaction": {"state": "ready"},
    }
    monkeypatch.setenv("HUB_TEST_DOCTOR", json.dumps(ready_report))
    return calls


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )


def commands(calls: Path) -> list[str]:
    return [
        json.loads(row).splitlines()[-2].strip()
        for row in calls.read_text().splitlines()
    ]


def test_missing_permission_is_an_actionable_health_check(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = json.loads(os.environ["HUB_TEST_DOCTOR"])
    report["compaction"]["state"] = "missing"
    monkeypatch.setenv("HUB_TEST_DOCTOR", json.dumps(report))

    health = run_cli("doctor")
    assert health.returncode == 1
    assert "Windows worker is responding." in health.stdout
    assert "wsl-cross-hub setup --apply" in health.stdout

    rejected = run_cli("compact", "--yes", "--json")
    assert rejected.returncode == 1
    assert json.loads(rejected.stdout)["accepted"] is False
    assert commands(windows) == ["& $hub", "& $hub"]


def test_stale_worker_protocol_blocks_compaction(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = json.loads(os.environ["HUB_TEST_DOCTOR"])
    del report["worker"]["maintenance_protocol"]
    monkeypatch.setenv("HUB_TEST_DOCTOR", json.dumps(report))

    health = run_cli("compact", "--yes")
    assert health.returncode == 1
    assert "worker needs the maintenance update" in health.stderr
    assert commands(windows) == ["& $hub"]


def test_noninteractive_compaction_needs_confirmation(windows: Path) -> None:
    unconfirmed = run_cli("compact")
    assert unconfirmed.returncode == 1
    assert "Pass --yes" in unconfirmed.stderr
    assert commands(windows) == ["& $hub"]


def test_ack_prints_job_id_without_waiting_for_recovery(windows: Path) -> None:
    result = run_cli("--json", "compact", "--yes")
    assert result.returncode == 0
    assert json.loads(result.stdout) == {
        "job_id": os.environ["HUB_TEST_JOB"],
        "state": "accepted",
    }
    assert commands(windows) == ["& $hub", "& $client -Operation compact"]


def test_job_and_maintenance_journal(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = os.environ["HUB_TEST_JOB"]
    event = {"stage": "shutdown-requested", "at": "2026-11-22T15:30:00Z"}
    monkeypatch.setenv("HUB_TEST_JOURNAL", json.dumps(event) + '\n{"stage":')
    status = run_cli("job", job_id)
    journal = run_cli("logs", job_id, "--json")

    assert status.returncode == journal.returncode == 0
    assert job_id in status.stdout
    assert json.loads(journal.stdout) == event
    assert commands(windows) == [
        f"& $client -Operation status -JobId '{job_id}'",
        f"& $client -Operation logs -JobId '{job_id}'",
    ]


def test_invalid_job_does_not_call_windows(windows: Path) -> None:
    status = run_cli("job", "..\\other.jsonl")
    assert status.returncode == 2
    assert not windows.exists()


def test_setup_defaults_to_preview(windows: Path) -> None:
    preview = run_cli("setup")
    assert preview.returncode == 0
    assert commands(windows) == ["& $hub -MaintenanceSetup"]


def test_wsl_interop_error_is_distinct(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HUB_INTEROP_FAIL", "1")
    failed = run_cli("doctor")
    assert failed.returncode == 1
    assert "did not start through WSL interop" in failed.stderr


def test_apply_notifies_stderr_without_polluting_json(windows: Path) -> None:
    applied = run_cli("setup", "--apply", "--json")
    assert applied.returncode == 0
    assert "approve the one-time administrator prompt" in applied.stderr
    assert json.loads(applied.stdout) == {"setup": {"state": "installed"}}
    assert commands(windows) == ["& $hub -MaintenanceSetup -Apply"]


def test_compaction_inspection_error_does_not_suggest_setup(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = json.loads(os.environ["HUB_TEST_DOCTOR"])
    report["compaction"] = {
        "state": "unavailable",
        "message": "Task Scheduler is offline.",
    }
    monkeypatch.setenv("HUB_TEST_DOCTOR", json.dumps(report))

    health = run_cli("doctor")
    assert health.returncode == 1
    assert "Task Scheduler is offline." in health.stdout
    assert "setup --apply" not in health.stdout


def test_doctor_check_and_manual_cure(windows: Path) -> None:
    checks = run_cli("doctor", "--checks", "--json")
    assert checks.returncode == 0
    assert json.loads(checks.stdout)["checks"][0]["id"] == "windows-ssh"

    cure = run_cli("doctor", "--cure", "windows-ssh", "--runner", "claude")
    assert cure.returncode == 0
    assert os.environ["HUB_TEST_JOB"] in cure.stdout
    assert commands(windows) == [
        "& $client -Operation doctor",
        "& $client -Operation doctor-job -Mode 'cure' -CheckId 'windows-ssh' -Runner 'claude'",
    ]


def test_doctor_agent_log_reads_the_companion_stream(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    event = {"stage": "agent-result", "runner": "codex"}
    monkeypatch.setenv("HUB_TEST_JOURNAL", json.dumps(event) + "\n")
    job = os.environ["HUB_TEST_JOB"]
    logs = run_cli("logs", job, "--agent")
    assert logs.returncode == 0
    assert json.loads(logs.stdout) == event
    assert commands(windows) == [
        f"& $client -Operation doctor-agent-logs -JobId '{job}'"
    ]


def test_doctor_rejects_unknown_check_before_calling_windows(windows: Path) -> None:
    result = run_cli("doctor", "--cure", "unknown")
    assert result.returncode == 2
    assert not windows.exists()


def test_offline_storage_and_history(
    windows: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hub_cli

    fixture = {
        "observedAt": "2026-11-26T10:00:00Z",
        "inventoryStale": False,
        "inventory": {
            "cFreeBytes": 1024**3,
            "runningDistros": [],
            "distributions": [{"name": "Ubuntu", "vhdLengthBytes": 1024**3}],
        },
        "worker": {"state": "ready"},
        "guestReports": [
            {
                "distro": "Ubuntu",
                "state": "stale",
                "report": {"filesystem": {"availableBytes": 1024**3}},
            }
        ],
        "history": [],
    }
    monkeypatch.setenv("HUB_TEST_STATUS", json.dumps(fixture))
    result = run_cli("status")
    assert result.returncode == 0
    assert "Ubuntu: stopped" in result.stdout
    assert "Ubuntu filesystem: 1.0 GiB free · stale" in result.stdout
    assert json.loads(run_cli("status", "--cached", "--json").stdout) == fixture
    assert json.loads(run_cli("history", "--json").stdout) == []
    assert commands(windows) == [
        "& $status -Operation collect",
        "& $status -Operation latest",
        "& $status -Operation latest",
    ]
    assert hub_cli.size(None) == "unknown"


def test_watch_latest_keeps_original_job(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    import hub_cli

    job_id = str(uuid4())
    calls = []
    reports = iter(
        [
            {"job": {"job_id": job_id, "state": "accepted"}},
            {"job_id": job_id, "state": "accepted"},
            {"job_id": job_id, "state": "running", "percent": 38},
            {"job_id": job_id, "state": "completed", "percent": 100},
        ]
    )

    def bridge(action):
        calls.append(action)
        return json.dumps(next(reports))

    monkeypatch.setattr(hub_cli, "invoke_windows", bridge)
    monkeypatch.setattr(hub_cli.time, "sleep", lambda _delay: None)
    assert hub_cli.main(["job", "--latest", "compaction", "--watch", "--json"]) == 0
    assert (
        calls
        == ["& $status -Operation maintenance"]
        + [f"& $status -Operation job-detail -JobId '{job_id}'"] * 3
    )
    assert [
        json.loads(row)["state"] for row in capsys.readouterr().out.splitlines()
    ] == ["accepted", "running", "completed"]
