"""Exercise the Windows launcher with isolated state and a mocked UAC request."""

import json
import os
import shutil
import subprocess
import sys
import time
from base64 import b64encode
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

HUB = Path(__file__).resolve().parent
MISSING_TASK = r"""
function global:Get-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)
    Write-Error "Task absent in isolated test" -Category ObjectNotFound -ErrorAction Stop
}
"""
MOCK_REGULAR_SESSION = r"""
# Hosted Windows runners are elevated. Exercise the regular-user launcher
# branch while retaining the production privilege check and mocking UAC.
function global:New-Object {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$TypeName,
        [Parameter(Position = 1)][object[]]$ArgumentList, [string]$ComObject)
    if ($TypeName -eq "Security.Principal.WindowsPrincipal") {
        $mock = [pscustomobject]@{}
        $mock | Add-Member -MemberType ScriptMethod -Name IsInRole -Value { param($role) return $false }
        return $mock
    }
    Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
}
"""
MOCK_UAC = r"""
function global:Start-Process {
    param([string]$FilePath, [string]$Verb, [string[]]$ArgumentList,
        [switch]$PassThru, [switch]$Wait)
    if (!$expectUac -or $Verb -ne "RunAs" -or $ArgumentList[-2] -ne "-EncodedCommand") {
        throw "Unexpected UAC request."
    }
    if (!(Test-Path -LiteralPath (Join-Path $state "app\worker.py"))) {
        throw "Expected a stable worker before requesting UAC."
    }
    [pscustomobject]@{ ExitCode = 0 }
}
"""

pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="requires native Windows Python and PowerShell 5.1",
)


@pytest.fixture
def powershell() -> Path:
    executable = (
        Path(os.environ["SystemRoot"])
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    if not executable.is_file():
        pytest.skip("Windows PowerShell 5.1 is unavailable")
    return executable


@pytest.fixture
def windows_python() -> Path:
    if sys.version_info[:2] != (3, 13):
        pytest.skip("run with Windows Python 3.13, such as uvx --python 3.13 pytest")
    return Path(sys.base_prefix) / "python.exe"


def ps_string(value: Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def run_hub(
    powershell: Path,
    state: Path,
    *flags: str,
    hub: Path = HUB,
    python: Path | None = None,
    mock_task: bool = True,
    expect_uac: bool = False,
    env: dict[str, str] | None = None,
    expected_code: int = 0,
) -> dict[str, Any]:
    command = [
        '$ErrorActionPreference = "Stop"',
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
        f"$state = {ps_string(state)}",
        f"$expectUac = ${str(expect_uac).lower()}",
        MOCK_REGULAR_SESSION,
        MOCK_UAC,
    ]
    if mock_task:
        command.append(MISSING_TASK)
    arguments = [
        f"& {ps_string(hub / 'wsl-cross-hub.ps1')}",
        "-StateDir $state",
        *flags,
    ]
    if python:
        arguments.extend(("-PythonExe", ps_string(python)))
    command.extend((" ".join(arguments), "exit $LASTEXITCODE"))
    encoded = b64encode("\n".join(command).encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        (
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ),
        env=env,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == expected_code, result.stdout + result.stderr
    return json.loads(result.stdout)


def test_missing_runtime_leaves_state_untouched(
    powershell: Path, tmp_path: Path
) -> None:
    state = tmp_path / "state"
    result = run_hub(powershell, state, python=tmp_path / "python.exe", mock_task=False)
    assert result["product"] == "WSL Cross Hub"
    assert result["runtime"]["state"] == "missing"
    assert result["worker"]["state"] == "unavailable"
    assert not state.exists()


def test_setup_preview_leaves_state_untouched(
    powershell: Path, windows_python: Path, tmp_path: Path
) -> None:
    state = tmp_path / "state"
    result = run_hub(
        powershell, state, "-Setup", python=windows_python, expect_uac=False
    )
    assert result["runtime"]["state"] == "ready"
    assert result["worker"]["state"] == "offline"
    assert result["setup"]["state"] == "preview"
    task = result["setup"]["task"]
    assert task["registered"] is False
    assert task["startRequested"] is False
    assert task["runLevel"] == "Limited"
    assert str(state / "app" / "worker.py") in task["arguments"]
    assert not state.exists()


def test_doctor_reads_live_worker(
    powershell: Path, windows_python: Path, tmp_path: Path
) -> None:
    state = tmp_path / "state"
    process = subprocess.Popen(
        (windows_python, "-I", "-S", HUB / "worker.py", "--state-dir", state, "worker"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 15
        while True:
            report = run_hub(powershell, state, python=windows_python, mock_task=False)[
                "worker"
            ]
            if report["state"] == "ready" or time.monotonic() >= deadline:
                break
            assert process.poll() is None
            time.sleep(0.1)
        assert report["state"] == "ready"
        assert report["pid"] == process.pid
        assert report["platform"] == "win32"
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_setup_publishes_worker_before_uac(
    powershell: Path, windows_python: Path, tmp_path: Path
) -> None:
    state = tmp_path / "isolated setup"
    result = run_hub(
        powershell, state, "-Setup", "-Apply", python=windows_python, expect_uac=True
    )
    assert result["setup"]["state"] == "start-requested"
    assert result["worker"]["state"] == "offline"
    app = state / "app"
    worker = app / "worker.py"
    assert worker.read_bytes() == (HUB / "worker.py").read_bytes()
    assert not (state / "jobs.sqlite3").exists()
    assert {path.name for path in app.iterdir()} == {
        "worker.py",
        "maintenance_runtime.py",
        "cure_runtime.py",
        "editor_runtime.py",
    }


@pytest.mark.parametrize("apply", [False, True])
def test_maintenance_setup_dispatches_one_installer(
    powershell: Path, windows_python: Path, tmp_path: Path, apply: bool
) -> None:
    hub = tmp_path / "hub"
    hub.mkdir()
    for name in (
        "wsl-cross-hub.ps1",
        "worker.py",
        "maintenance_runtime.py",
        "cure_runtime.py",
        "editor_runtime.py",
        "setup_core.py",
    ):
        shutil.copyfile(HUB / name, hub / name)
    (hub / "install-compaction.ps1").write_text(
        """param([switch]$Preview, [string]$BootPythonExe,
            [string]$BootStateDir, [string]$BootInstallRoot)
        [ordered]@{ preview = [bool]$Preview; python = $BootPythonExe;
            state = $BootStateDir; root = $BootInstallRoot } | ConvertTo-Json
        exit 0
        """,
        encoding="utf-8",
    )
    state = tmp_path / "state with spaces"
    flags = ["-MaintenanceSetup"] + (["-Apply"] if apply else [])
    result = run_hub(powershell, state, *flags, hub=hub, python=windows_python)
    assert result["preview"] == (not apply)
    if not apply:
        assert not state.exists()
        return
    assert Path(result["python"]) == windows_python
    assert Path(result["state"]) == state
    root = Path(result["root"])
    assert root.parent == state / "app-versions"
    # The require-idle probe may create a bytecode directory after publication.
    assert {path.name for path in root.iterdir() if path.is_file()} == {
        "worker.py",
        "maintenance_runtime.py",
        "cure_runtime.py",
        "editor_runtime.py",
    }
    assert not (state / "app").exists()


def test_windows_client_can_read_an_open_maintenance_journal(
    powershell: Path, tmp_path: Path
) -> None:
    job_id = str(uuid4())
    directory = tmp_path / "maintenance"
    directory.mkdir()
    entry = '{"stage":"diskpart-output","line":"Compaction in progress"}'
    with (directory / f"{job_id}.jsonl").open("a", encoding="utf-8") as journal:
        journal.write(entry + "\n")
        journal.flush()
        read = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                HUB / "client.ps1",
                "-Operation",
                "logs",
                "-StateDir",
                tmp_path,
                "-JobId",
                job_id,
            ],
            capture_output=True,
            encoding="utf-8",
            timeout=15,
            check=False,
        )
    assert read.returncode == 0, read.stderr
    assert read.stdout.strip() == entry


def test_desktop_doctor_logs_return_journal_and_agent_events(
    powershell: Path, tmp_path: Path
) -> None:
    job_id = str(uuid4())
    directory = tmp_path / "maintenance"
    directory.mkdir()
    journal = '{"stage":"doctor-verified","state":"healthy"}'
    event = '{"type":"turn.completed"}'
    (directory / f"{job_id}.jsonl").write_text(journal + "\n", encoding="utf-8")
    (directory / f"{job_id}.agent.jsonl").write_text(event + "\n", encoding="utf-8")
    for name in ("client.ps1", "status.ps1"):
        shutil.copyfile(HUB / name, tmp_path / name)
    (tmp_path / "wsl-cross-hub.ps1").write_text(
        "param($StateDir, [switch]$ReadOnly, [switch]$RuntimeOnly)\n"
        "@{ stateDir = $StateDir } | ConvertTo-Json\nexit 0\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        (
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            tmp_path / "status.ps1",
            "-Operation",
            "doctor-logs",
            "-StateDir",
            tmp_path,
            "-JobId",
            job_id,
        ),
        capture_output=True,
        encoding="utf-8",
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"lines": [journal, "", "Agent events", event]}


def test_desktop_compaction_routes_only_the_approved_target(
    powershell: Path, tmp_path: Path
) -> None:
    status_script = tmp_path / "status.ps1"
    shutil.copyfile(HUB / "status.ps1", status_script)
    (tmp_path / "wsl-cross-hub.ps1").write_text(
        """'{"runtime":{"state":"ready","path":"python.exe"},
        "compaction":{"state":"ready","distro":"Ubuntu-24.04"},
        "stateDir":"test-state"}'
        exit 0
        """,
        encoding="utf-8",
    )
    (tmp_path / "client.ps1").write_text(
        """param($Operation, $PythonExe, $StateDir)
        if ($Operation -ne 'compact' -or $StateDir -ne 'test-state') { exit 2 }
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'submissions') -Value $Operation
        '{"job_id":"fixture-job","state":"accepted"}'
        exit 0
        """,
        encoding="utf-8",
    )
    command = [
        str(powershell),
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(status_script),
        "-Operation",
        "compact",
        "-Distro",
    ]
    mismatch = subprocess.run(
        [*command, "docker-desktop"],
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert mismatch.returncode != 0
    assert b"approved compaction target" in mismatch.stderr
    assert not (tmp_path / "submissions").exists()

    approved = subprocess.run(
        [*command, "Ubuntu-24.04"],
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert approved.returncode == 0, approved.stderr
    assert json.loads(approved.stdout)["state"] == "accepted"
    assert (tmp_path / "submissions").read_text().splitlines() == ["compact"]


def test_setup_reports_publish_failure_before_uac(
    powershell: Path, windows_python: Path, tmp_path: Path
) -> None:
    state = tmp_path / "isolated setup"
    app = state / "app"
    app.mkdir(parents=True)
    worker = app / "worker.py"
    worker.write_bytes(b"different")
    result = run_hub(
        powershell,
        state,
        "-Setup",
        "-Apply",
        python=windows_python,
        expected_code=1,
    )
    assert result["setup"]["state"] == "failed"
    assert "A different worker is already installed" in result["setup"]["error"]
    assert worker.read_bytes() == b"different"


def test_bundled_uv_provisions_isolated_windows_python(
    powershell: Path, tmp_path: Path
) -> None:
    uv = os.environ.get("WSL_CROSS_HUB_TEST_UV")
    if not uv:
        pytest.skip(
            "set WSL_CROSS_HUB_TEST_UV to native uv.exe to test a fresh download"
        )
    bundle = tmp_path / "bundle"
    bundled_uv = bundle / "runtime" / "uv.exe"
    bundled_uv.parent.mkdir(parents=True)
    for filename in (
        "wsl-cross-hub.ps1",
        "install-task.ps1",
        "setup_core.py",
        "worker.py",
        "maintenance_runtime.py",
        "cure_runtime.py",
        "editor_runtime.py",
    ):
        shutil.copyfile(HUB / filename, bundle / filename)
    shutil.copyfile(uv, bundled_uv)

    state = tmp_path / "state"
    install = tmp_path / "python"
    env = os.environ | {
        "UV_PYTHON_INSTALL_DIR": str(install),
        "UV_CACHE_DIR": str(tmp_path / "uv-cache"),
        "UV_PYTHON_NO_REGISTRY": "1",
    }
    try:
        preview = run_hub(powershell, state, "-Setup", hub=bundle, env=env)
        assert preview["runtime"]["state"] == "provisionable"
        assert preview["setup"]["provisionsPython"] is True
        assert not install.exists()
        assert not state.exists()

        result = run_hub(
            powershell, state, "-Setup", "-Apply", hub=bundle, expect_uac=True, env=env
        )
        assert result["runtime"]["state"] == "ready"
        assert Path(result["runtime"]["path"]).is_relative_to(install)
        assert Path(result["uv"]) == bundled_uv
        assert result["setup"]["state"] == "start-requested"
    finally:
        # uv owns the version aliases it creates on Windows.
        if install.exists():
            subprocess.run(
                (bundled_uv, "--no-config", "python", "uninstall", "3.13"),
                env=env,
                capture_output=True,
                timeout=30,
                check=True,
            )
