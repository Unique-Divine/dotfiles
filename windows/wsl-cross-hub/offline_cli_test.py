"""Use a native Windows offline WSL fixture without touching live registrations."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HUB = Path(__file__).resolve().parent
pytestmark = pytest.mark.skipif(
    sys.platform != "win32", reason="Windows launcher fixture"
)

OFFLINE_WSL = r"""
using System;
using System.IO;
class OfflineWsl {
    public static int Main(string[] args) {
        var command = string.Join(" ", args);
        File.AppendAllText(Environment.GetEnvironmentVariable("CROSS_HUB_TEST_TRACE"), command + "\n");
        if (command != "--list --running --quiet")
            return 55;
        Console.WriteLine("Windows Subsystem for Linux has no running distributions.");
        return 1;
    }
}
"""


def test_native_status_does_not_wake_wsl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shell = (
        Path(os.environ["SystemRoot"])
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    fake_wsl = tmp_path / "wsl.exe"
    compile_fixture = tmp_path / "compile.ps1"
    compile_fixture.write_text(
        "param([string]$Output)\n"
        "$ErrorActionPreference = 'Stop'\n"
        "Add-Type -OutputAssembly $Output -OutputType ConsoleApplication -TypeDefinition @'\n"
        + OFFLINE_WSL.lstrip()
        + "'@\n",
        encoding="ascii",
    )
    subprocess.run(
        [
            shell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            compile_fixture,
            fake_wsl,
        ],
        check=True,
        timeout=20,
    )
    for filename in (
        "status.ps1",
        "client.ps1",
        "cli.ps1",
        "wsl-cross-hub.cmd",
        "hub_cli.py",
        "status_core.py",
        "maintenance_plan.py",
        "worker.py",
        "maintenance_runtime.py",
    ):
        shutil.copyfile(HUB / filename, tmp_path / filename)

    inventory = (HUB / "inventory.ps1").read_text(encoding="utf-8")
    assignment = (
        '$process.StartInfo.FileName = Join-Path $env:SystemRoot "System32\\wsl.exe"'
    )
    assert assignment in inventory
    (tmp_path / "inventory.ps1").write_text(
        inventory.replace(
            assignment, "$process.StartInfo.FileName = $env:CROSS_HUB_TEST_WSL"
        ),
        encoding="utf-8",
    )
    report = json.dumps(
        {
            "runtime": {"state": "ready", "path": sys.executable},
            "stateDir": str(tmp_path / "state"),
            "worker": {"state": "ready"},
            "compaction": {"state": "missing"},
        }
    )
    (tmp_path / "wsl-cross-hub.ps1").write_text(
        "param([switch]$ReadOnly,[switch]$RuntimeOnly)\n'"
        + report.replace("'", "''")
        + "'\nexit 0\n",
        encoding="utf-8",
    )
    trace = tmp_path / "wsl-calls.txt"
    monkeypatch.setenv("CROSS_HUB_TEST_WSL", str(fake_wsl))
    monkeypatch.setenv("CROSS_HUB_TEST_TRACE", str(trace))
    run = subprocess.run(
        [os.environ["ComSpec"], "/d", "/c", "wsl-cross-hub.cmd", "status", "--json"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=40,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    status = json.loads(run.stdout)
    assert status["inventory"]["runningDistros"] == []
    assert isinstance(status["inventory"]["cFreeBytes"], int)
    assert trace.read_text().splitlines() == ["--list --running --quiet"]


@pytest.mark.parametrize("args", [("setup", "--json"), ("--json", "setup")])
def test_native_unprovisioned_setup_honors_json_flag_position(
    tmp_path: Path, args: tuple[str, str]
) -> None:
    for name in ("wsl-cross-hub.cmd", "cli.ps1"):
        shutil.copyfile(HUB / name, tmp_path / name)
    (tmp_path / "wsl-cross-hub.ps1").write_text(
        "param([switch]$ReadOnly,[switch]$RuntimeOnly,[switch]$MaintenanceSetup,[switch]$Apply)\n"
        'if ($RuntimeOnly) { \'{"runtime":{"state":"missing"}}\'; exit 0 }\n'
        'if ($MaintenanceSetup -and !$Apply) { \'{"setup":{"state":"preview"}}\'; exit 0 }\n'
        "exit 1\n",
        encoding="ascii",
    )
    result = subprocess.run(
        [os.environ["ComSpec"], "/d", "/c", "wsl-cross-hub.cmd", *args],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["setup"]["state"] == "preview"
