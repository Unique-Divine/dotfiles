# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///

"""Control the Windows worker that runs WSL Cross Hub jobs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from uuid import UUID

MAINTENANCE_PROTOCOL = 1
BRIDGE_READY = "WSL_CROSS_HUB_READY"
WINDOWS_BOOTSTRAP = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::WriteLine('WSL_CROSS_HUB_READY')
$roots = @(
    (Join-Path $env:USERPROFILE 'dotfiles\windows\wsl-cross-hub'),
    (Join-Path $env:LOCALAPPDATA 'Programs\WslCrossHub')
)
$root = $roots | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_ 'wsl-cross-hub.ps1') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_ 'client.ps1') -PathType Leaf)
} | Select-Object -First 1
if (!$root) {
    [Console]::Error.WriteLine('Cross Hub is missing on Windows. Install the desktop app or run just win-sync from the Cross Hub checkout.')
    exit 66
}
$hub = Join-Path $root 'wsl-cross-hub.ps1'
$client = Join-Path $root 'client.ps1'
"""
SYSTEM_POWERSHELL = Path(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
)


class HubError(Exception):
    """An operational error shown without a traceback."""


def canonical_job_id(value: str) -> str:
    try:
        if str(UUID(value, version=4)) == value:
            return value
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("expected a lowercase UUIDv4 job ID")


def powershell() -> str:
    if sys.platform == "win32":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        native = Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    else:
        native = SYSTEM_POWERSHELL
    path = shutil.which("powershell.exe")
    if path:
        return path
    if native.is_file():
        return str(native)
    raise HubError("Windows PowerShell is unavailable. Run this command from WSL.")


def invoke_windows(action: str, *, timeout: int = 25) -> str:
    # Callers use fixed PowerShell text and validated UUIDs only.
    script = f"{WINDOWS_BOOTSTRAP}\n{action}\nexit $LASTEXITCODE"
    try:
        result = subprocess.run(
            [
                powershell(),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            cwd="/mnt/c" if Path("/mnt/c").is_dir() else None,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise HubError(
            "Windows command timed out. Check Cross Hub before retrying."
        ) from error
    except OSError as error:
        raise HubError(
            f"Could not start Windows PowerShell through WSL interop. {error}"
        ) from error
    header, _, body = result.stdout.partition("\n")
    if header.strip() != BRIDGE_READY:
        details = result.stderr.strip() or result.stdout.strip()
        message = "Windows PowerShell did not start through WSL interop."
        raise HubError(f"{message} {details}" if details else message)
    if result.returncode != 0:
        raise HubError(
            result.stderr.strip()
            or body.strip()
            or f"Windows command returned exit code {result.returncode}."
        )
    return body


def json_object(output: str) -> dict[str, object]:
    try:
        value = json.loads(output)
    except ValueError as error:
        raise HubError("Windows returned an invalid JSON response.") from error
    if not isinstance(value, dict):
        raise HubError("Windows returned an unexpected response.")
    return value


def field(report: dict[str, object], key: str) -> dict[str, object]:
    value = report.get(key)
    return value if isinstance(value, dict) else {}


def checks(report: dict[str, object]) -> list[tuple[bool, str]]:
    runtime = field(report, "runtime")
    task = field(report, "task")
    worker = field(report, "worker")
    compact = field(report, "compaction")

    runtime_ready = runtime.get("state") == "ready"
    task_ready = task.get("status") == "registered"
    worker_ready = worker.get("state") == "ready"
    protocol_ready = worker.get("maintenance_protocol") == MAINTENANCE_PROTOCOL
    compact_state = compact.get("state", "unknown")
    compact_ready = compact_state == "ready"

    if compact_ready:
        compact_text = "Compaction permission ready."
    elif compact_state == "busy":
        compact_text = str(compact.get("message") or "A compaction job is active.")
    elif compact_state == "blocked":
        compact_text = str(
            compact.get("message") or "Review the previous run before retrying."
        )
    elif compact_state == "misconfigured":
        compact_text = str(
            compact.get("message") or "Inspect the Windows compaction task and target."
        )
    elif compact_state in {"missing", "unknown"}:
        compact_text = (
            str(compact.get("message") or "Compaction needs one-time Windows setup.")
            + " Run wsl-cross-hub setup --apply at the Windows desktop and approve the prompt."
        )
    else:
        detail = compact.get("message") or compact.get("hint")
        compact_text = "Compaction permission could not be checked."
        if detail:
            compact_text += f" {detail}"

    return [
        (
            runtime_ready,
            "Windows Python ready."
            if runtime_ready
            else str(runtime.get("hint") or "Windows Python unavailable."),
        ),
        (
            task_ready,
            "Windows boot task registered."
            if task_ready
            else "Windows boot task unavailable. Run wsl-cross-hub setup --apply.",
        ),
        (
            worker_ready,
            "Windows worker is responding."
            if worker_ready
            else f"Windows worker is {worker.get('state', 'unavailable')}.",
        ),
        (compact_ready, compact_text),
        (
            not worker_ready or protocol_ready,
            ""
            if protocol_ready or not worker_ready
            else "Windows worker needs the maintenance update. Run wsl-cross-hub setup --apply.",
        ),
    ]


def show(payload: dict[str, object], *, machine: bool) -> None:
    if machine:
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    else:
        for _, message in checks(payload):
            if message:
                print(message)


def compact(machine: bool, *, confirmed: bool) -> int:
    doctor = json_object(invoke_windows("& $hub"))
    failures = [message for ready, message in checks(doctor) if not ready]
    if failures:
        if machine:
            print(json.dumps({"accepted": False, "errors": failures}))
        else:
            print("\n".join(failures), file=sys.stderr)
        return 1
    if not confirmed:
        if not sys.stdin.isatty():
            raise HubError("Pass --yes to confirm a compaction without a terminal.")
        print(
            "This will stop WSL and disconnect Linux sessions. Continue? [y/N] ",
            end="",
            file=sys.stderr,
            flush=True,
        )
        try:
            confirmed = input().strip().casefold() in {"y", "yes"}
        except EOFError:
            confirmed = False
        if not confirmed:
            print("Compaction cancelled.", file=sys.stderr)
            return 1
    result = json_object(invoke_windows("& $client -Operation compact"))
    show_job(result, machine=machine)
    state = result.get("state")
    if state in {"accepted", "running"} and not machine:
        print("Windows owns this job. Reconnect after it finishes.")
        print(f"Check progress with wsl-cross-hub logs {result.get('job_id')}.")
    return 0 if state in {"accepted", "running", "completed"} else 1


def show_job(result: dict[str, object], *, machine: bool) -> None:
    if machine:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    print(f"Job {result.get('job_id')} is {result.get('state')}.")
    details = result.get("result")
    if details is not None:
        print(json.dumps(details, ensure_ascii=False, indent=2))


def show_logs(output: str, *, machine: bool) -> None:
    lines = output.splitlines(keepends=True)
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json_object(line)
        except HubError:
            # A reader can observe a partially written final journal record.
            if not line.endswith("\n"):
                continue
            raise
        if machine:
            print(line.rstrip())
            continue
        at = event.get("at", "")
        stage = event.get("stage", "")
        detail = event.get("line") or event.get("message") or event.get("error")
        print(f"{at} {stage}" + (f"  {detail}" if detail else ""))


def display_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--json",
        dest="machine",
        action="store_true",
        default=argparse.SUPPRESS,
        help="print machine-readable JSON",
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wsl-cross-hub", description=__doc__)
    display_flags(parser)
    commands = parser.add_subparsers(dest="action", required=True)
    doctor = commands.add_parser("doctor", help="check Windows setup and permissions")
    checks_or_job = doctor.add_mutually_exclusive_group()
    checks_or_job.add_argument("--checks", action="store_true", help="show actionable health checks")
    check_ids = ("windows-ssh", "windows-herdr", "ubuntu-herdr")
    editor_ids = ("windows-neovim", "ubuntu-neovim")
    checks_or_job.add_argument("--investigate", choices=check_ids, metavar="CHECK")
    checks_or_job.add_argument("--cure", choices=check_ids + editor_ids, metavar="CHECK")
    doctor.add_argument("--runner", choices=("codex", "claude"), default="codex")
    submission = commands.add_parser("compact", help="submit Ubuntu compaction")
    submission.add_argument("--yes", action="store_true", help="confirm WSL shutdown")
    job = commands.add_parser("job", help="inspect a Windows job")
    job.add_argument("job_id", type=canonical_job_id)
    logs = commands.add_parser("logs", help="read a Windows job's maintenance journal")
    logs.add_argument("job_id", type=canonical_job_id)
    logs.add_argument("--agent", action="store_true", help="read redacted Doctor agent events")
    probe = commands.add_parser("probe", help="submit a Windows worker health probe")
    setup = commands.add_parser("setup", help="preview the one-time maintenance setup")
    setup.add_argument(
        "--apply", action="store_true", help="apply setup and request UAC"
    )
    for command in (doctor, submission, job, logs, probe, setup):
        display_flags(command)
    args = parser.parse_args(argv)
    machine = getattr(args, "machine", False)

    try:
        match args.action:
            case "doctor":
                if check := args.investigate or args.cure:
                    mode = "cure" if args.cure else "investigate"
                    runner = "managed" if check in editor_ids else args.runner
                    result = invoke_windows(
                        f"& $client -Operation doctor-job -Mode '{mode}' "
                        f"-CheckId '{check}' -Runner '{runner}'"
                    )
                    show_job(json_object(result), machine=machine)
                    return 0
                if args.checks:
                    result = json_object(invoke_windows("& $client -Operation doctor"))
                    if machine:
                        print(json.dumps(result, ensure_ascii=False))
                    else:
                        for item in result["checks"]:
                            runners = ", ".join(item["runners"]) or "none"
                            print(f"{item['id']}: {item['state']} · {item['detail']} · runners: {runners}")
                        for item in result.get("editors", []):
                            version = item["version"] or "missing"
                            config = "matches dotfiles" if item["configMatches"] else "unverified"
                            print(f"{item['id']}: {item['state']} · {version} / {item['expectedVersion']} · "
                                  f"config {config} · {item['detail']}")
                    return 0
                report = json_object(invoke_windows("& $hub"))
                show(report, machine=machine)
                return 0 if all(ready for ready, _ in checks(report)) else 1
            case "compact":
                return compact(machine, confirmed=args.yes)
            case "job":
                result = invoke_windows(
                    f"& $client -Operation status -JobId '{args.job_id}'"
                )
                show_job(json_object(result), machine=machine)
            case "logs":
                operation = "doctor-agent-logs" if args.agent else "logs"
                result = invoke_windows(
                    f"& $client -Operation {operation} -JobId '{args.job_id}'"
                )
                show_logs(result, machine=machine or args.agent)
            case "probe":
                result = invoke_windows("& $client -Operation probe")
                show_job(json_object(result), machine=machine)
            case "setup":
                flags = " -Apply" if args.apply else ""
                if args.apply:
                    print(
                        "Watch the Windows desktop and approve the one-time "
                        "administrator prompt when it appears.",
                        file=sys.stderr,
                        flush=True,
                    )
                result = invoke_windows(
                    f"& $hub -MaintenanceSetup{flags}",
                    timeout=300 if args.apply else 25,
                )
                if machine:
                    print(json.dumps(json_object(result), ensure_ascii=False))
                else:
                    print(result.strip())
        return 0
    except HubError as error:
        print(f"WSL Cross Hub: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
