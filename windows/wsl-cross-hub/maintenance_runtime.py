"""Run one Windows-owned WSL maintenance job against a registered disk."""

import ctypes
import ipaddress
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterator
from ctypes import wintypes
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import TypedDict
from uuid import UUID

TASK_LEAF_NAME = "Unique-WslCrossHub-Compact"
TASK_NAME = "\\" + TASK_LEAF_NAME
RECOVERY_TASK = "Unique-WslCrossHub-Recovery"
DOCKER_DISTROS = {"docker-desktop", "docker-desktop-data"}
TASK_XML_NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
COMPACTION_TIMEOUT = 90 * 60
MAX_EVENT_BYTES = 65536
EXPECTED_HELPER = "compact-vhdx.ps1"
TASK_DISABLED = 1
TASK_READY = 3
ADMINISTRATORS_SID = "S-1-5-32-544"
LOCAL_SYSTEM_SID = "S-1-5-18"
FILE_FULL_CONTROL = 0x1F01FF
FILE_READ_EXECUTE = 0x1200A9
FILE_GENERIC_READ_EXECUTE = 0xA0000000
POWERSHELL_ARGS = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File"


class SetupRequired(RuntimeError):
    """The maintenance helper needs the one-time administrator setup."""


class SetupMissing(SetupRequired):
    """The maintenance helper has not been installed yet."""


class TaskBusy(RuntimeError):
    """Windows already has a compaction task instance."""


class DispatchDenied(RuntimeError):
    """Task Scheduler definitively refused to enqueue the maintenance task."""


class Target(TypedDict):
    owner_sid: str
    distro: str
    registration: str
    vhdx: str
    volume_serial: str
    file_id: str


class CompactionResult(TypedDict):
    work_started: bool
    compaction_ok: bool
    detach_verified: bool
    error: str | None


class RunSummary(TypedDict, total=False):
    compaction_ok: bool
    detach_verified: bool
    recovery_ok: bool
    vhdx_reduction_bytes: int
    c_free_delta_bytes: int
    error: str
    journal_error: str


@dataclass(frozen=True)
class Guest:
    boot_id: str
    uid: str
    herdr: str
    tailscale_ipv4: str


class Journal:
    def __init__(self, directory: Path, job_id: str) -> None:
        self.job_id = job_id
        self.allow_degraded = False
        self.error: str | None = None
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / f"{job_id}.jsonl"
        self.path.touch(exist_ok=False)

    def __call__(self, stage: str, **details: object) -> None:
        row = {
            **details,
            "at": datetime.now(UTC).isoformat(),
            "job_id": self.job_id,
            "stage": stage,
        }
        try:
            with self.path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(row) + "\n")
                file.flush()
                os.fsync(file.fileno())
        except OSError as error:
            self.error = str(error)
            if not self.allow_degraded:
                raise


def wsl_text(raw: bytes) -> str:
    if raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16-be").strip("\ufeff \r\n")
    encoding = "utf-16-le" if b"\x00" in raw else "utf-8-sig"
    return raw.decode(encoding, errors="replace").strip("\ufeff \r\n")


def has_link(path: Path) -> bool:
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            return True
    return False


def regular_item(path: Path) -> os.stat_result:
    info = path.stat()
    if has_link(path) or not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Expected a regular local file at {path}.")
    return info


def validate_task(
    xml: str, target: Target, powershell: Path, install_root: Path,
    helper: str = EXPECTED_HELPER,
) -> None:
    root = ET.fromstring(xml)

    def values(query: str) -> list[str]:
        return [node.text or "" for node in root.findall(query, TASK_XML_NS)]

    expected_action = f'{POWERSHELL_ARGS} "{install_root / helper}"'
    principal_ids = values("t:Principals/t:Principal/t:UserId")
    checks = (
        values("t:Principals/t:Principal/t:RunLevel") == ["HighestAvailable"],
        values("t:Principals/t:Principal/t:LogonType") == ["S4U"],
        [value.casefold() for value in principal_ids]
        == [target["owner_sid"].casefold()],
        len(root.findall("t:Actions/*", TASK_XML_NS)) == 1,
        [value.casefold() for value in values("t:Actions/t:Exec/t:Command")]
        == [str(powershell).casefold()],
        values("t:Actions/t:Exec/t:Arguments") == [expected_action],
        [value.casefold() for value in values("t:Actions/t:Exec/t:WorkingDirectory")]
        == [str(install_root).casefold()],
        not root.findall("t:Triggers/*", TASK_XML_NS),
        values("t:Settings/t:AllowStartOnDemand") != ["false"],
        values("t:Settings/t:MultipleInstancesPolicy") == ["IgnoreNew"],
    )
    if not all(checks):
        raise SetupRequired(
            "The registered compaction task does not match Cross Hub setup."
        )


def parse_target(contents: str) -> Target:
    row = json.loads(contents)
    keys = ("owner_sid", "distro", "registration", "vhdx", "volume_serial", "file_id")
    if not isinstance(row, dict) or any(
        not isinstance(row.get(key), str) or not row[key] for key in keys
    ):
        raise ValueError("Compaction setup has an invalid target manifest.")
    if not re.fullmatch(r"[0-9A-F]{8}", row["volume_serial"]) or not re.fullmatch(
        r"[0-9A-F]{16}", row["file_id"]
    ):
        raise ValueError("Compaction setup has an invalid VHDX identity.")
    registration = UUID(row["registration"])
    if row["registration"].casefold() != "{" + str(registration) + "}":
        raise ValueError("Compaction setup has an invalid WSL registration ID.")
    path = PureWindowsPath(row["vhdx"])
    if not (path.is_absolute() and path.drive.endswith(":")):
        raise ValueError("Compaction setup requires a local absolute VHDX path.")
    return {
        "owner_sid": row["owner_sid"],
        "distro": row["distro"],
        "registration": row["registration"],
        "vhdx": row["vhdx"],
        "volume_serial": row["volume_serial"],
        "file_id": row["file_id"],
    }


def read_task_script(statement: str, task_name: str = TASK_LEAF_NAME) -> str:
    return (
        "$ErrorActionPreference='Stop';"
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);"
        "$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect();"
        r"$folder=$svc.GetFolder('\');"
        f"$task=$folder.GetTask('{task_name}');" + statement
    )


TASK_SECURITY_QUERY = """
$raw = New-Object Security.AccessControl.RawSecurityDescriptor ($task.GetSecurityDescriptor(7))
$info = [ordered]@{
    owner = $raw.Owner.Value
    protected = [bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    acl = @(
        foreach ($ace in $raw.DiscretionaryAcl) {
            [ordered]@{
                sid = $ace.SecurityIdentifier.Value
                type = [int]$ace.AceType
                flags = [int]$ace.AceFlags
                mask = $ace.AccessMask
            }
        }
    )
}
$info | ConvertTo-Json -Compress -Depth 4
"""


def validate_task_security(contents: str, target: Target) -> None:
    info = json.loads(contents)
    expected = {
        ADMINISTRATORS_SID: {FILE_FULL_CONTROL},
        LOCAL_SYSTEM_SID: {FILE_FULL_CONTROL},
        target["owner_sid"]: {FILE_READ_EXECUTE, FILE_GENERIC_READ_EXECUTE},
    }
    if (
        isinstance(info, dict)
        and info.get("owner") == ADMINISTRATORS_SID
        and info.get("protected") is True
        and isinstance(info.get("acl"), list)
    ):
        for ace in info["acl"]:
            if (
                not isinstance(ace, dict)
                or ace.get("type") != 0
                or ace.get("flags") != 0
                or not isinstance(ace.get("sid"), str)
                or not isinstance(ace.get("mask"), int)
                or (ace["mask"] & 0xFFFFFFFF) not in expected.pop(ace["sid"], set())
            ):
                break
        else:
            if not expected:
                return
    raise SetupRequired(
        "The Windows compaction task needs protected administrator ownership "
        "and matching read/run permissions. Run the one-time setup."
    )


TASK_RUN = """
try {
    $instance = $task.Run($null)
    if ($null -eq $instance) {
        'unknown'
    } else {
        'accepted'
    }
} catch {
    'rejected:{0:X8}' -f $_.Exception.GetBaseException().HResult
}
"""


class FileInformation(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD),
        ("creation_time", wintypes.FILETIME),
        ("access_time", wintypes.FILETIME),
        ("write_time", wintypes.FILETIME),
        ("volume_serial", wintypes.DWORD),
        ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD),
        ("links", wintypes.DWORD),
        ("file_index_high", wintypes.DWORD),
        ("file_index_low", wintypes.DWORD),
    ]


def disk_file_identity(path: Path, *, exclusive: bool = False) -> tuple[str, str, int]:
    # With access=0 the check can run against the mounted WSL backing file.
    # An exclusive recovery probe opens for GENERIC_READ with no sharing.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create.restype = wintypes.HANDLE
    query = kernel.GetFileInformationByHandle
    query.argtypes = (wintypes.HANDLE, ctypes.POINTER(FileInformation))
    query.restype = wintypes.BOOL
    close = kernel.CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL

    access = 0x80000000 if exclusive else 0  # GENERIC_READ
    share = 0 if exclusive else 0x7  # FILE_SHARE_READ | WRITE | DELETE
    handle = create(
        str(path), access, share, None, 3, 0x00200000, None
    )  # OPEN_EXISTING | FILE_FLAG_OPEN_REPARSE_POINT
    if handle in {None, ctypes.c_void_p(-1).value}:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = FileInformation()
        if not query(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if info.attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("The registered disk resolved to a Windows reparse point.")
        file_index = (info.file_index_high << 32) | info.file_index_low
        return f"{info.volume_serial:08X}", f"{file_index:016X}", info.links
    finally:
        close(handle)


def require_disk_identity(target: Target, *, exclusive: bool = False) -> None:
    identity = disk_file_identity(Path(target["vhdx"]), exclusive=exclusive)
    if identity != (target["volume_serial"], target["file_id"], 1):
        raise SetupRequired(
            "The registered VHDX file identity changed. Review compaction setup."
        )


class WindowsHost:
    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Compaction requires the native Windows worker.")
        system32 = Path(os.environ["SystemRoot"]) / "System32"
        program_files = Path(os.environ["ProgramFiles"])
        self.install_root = program_files / "WslCrossHubMaintenance"
        self.task_log = self.install_root / "diskpart.jsonl"
        self.powershell = system32 / "WindowsPowerShell/v1.0/powershell.exe"
        self.scheduler = system32 / "schtasks.exe"
        native_wsl = program_files / "WSL/wsl.exe"
        self.wsl = native_wsl if native_wsl.is_file() else system32 / "wsl.exe"

    def command(self, *args: str | Path, timeout: float = 15) -> str:
        result = subprocess.run(
            [str(arg) for arg in args],
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        stdout, stderr = wsl_text(result.stdout), wsl_text(result.stderr)
        if result.returncode:
            raise RuntimeError(
                f"{args[0]} exited {result.returncode}. {stderr or stdout}".rstrip()
            )
        return stdout

    def ps(self, script: str) -> str:
        return self.command(
            self.powershell, "-NoProfile", "-NonInteractive", "-Command", script
        )

    def task_state(self) -> int:
        output = self.ps(read_task_script("[int]$task.State"))
        if output not in {"1", "2", "3", "4"}:
            raise RuntimeError("Windows could not determine compaction task state.")
        return int(output)

    def last_task_result(self) -> str:
        text = self.ps(read_task_script("$task.LastTaskResult"))
        return f"0x{int(text) & 0xFFFFFFFF:08X}"

    def installed_target(self) -> Target:
        manifest = self.install_root / "target.json"
        try:
            regular_item(manifest)
            regular_item(self.install_root / EXPECTED_HELPER)
            regular_item(self.task_log)
            with self.task_log.open("rb"):
                pass
        except FileNotFoundError:
            raise SetupMissing(
                "Windows needs the one-time administrator setup for compaction."
            ) from None
        try:
            target = parse_target(manifest.read_text(encoding="utf-8-sig"))
        except ValueError as error:
            raise SetupRequired(str(error)) from error
        try:
            xml = self.command(self.scheduler, "/Query", "/TN", TASK_NAME, "/XML")
        except RuntimeError as error:
            raise SetupRequired(
                f"Windows could not read the registered compaction task. {error}"
            ) from error
        validate_task(xml, target, self.powershell, self.install_root)
        validate_task_security(self.ps(read_task_script(TASK_SECURITY_QUERY)), target)
        self.check_registered_target(target)
        state = self.task_state()
        if state == TASK_DISABLED:
            raise SetupRequired("The registered Windows compaction task is disabled.")
        if state != TASK_READY:
            raise TaskBusy("The Windows compaction task is already queued or running.")
        return target

    def check_registered_target(self, target: Target) -> None:
        import winreg

        key = (
            r"Software\Microsoft\Windows\CurrentVersion\Lxss"
            + "\\"
            + target["registration"]
        )
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as registration:
                name, _ = winreg.QueryValueEx(registration, "DistributionName")
                version, _ = winreg.QueryValueEx(registration, "Version")
                base, _ = winreg.QueryValueEx(registration, "BasePath")
                try:
                    filename, _ = winreg.QueryValueEx(registration, "VhdFileName")
                except FileNotFoundError:
                    filename = "ext4.vhdx"
        except FileNotFoundError:
            raise SetupRequired(
                "The Ubuntu registration changed. Review the target and run compaction setup."
            ) from None
        disk = Path(target["vhdx"])
        if (
            name != target["distro"]
            or version != 2
            or disk != Path(base.removeprefix("\\\\?\\")) / (filename or "ext4.vhdx")
        ):
            raise SetupRequired(
                "The Ubuntu VHDX registration differs from the configured target."
            )
        info = regular_item(disk)
        require_disk_identity(target)
        if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_SPARSE_FILE:
            raise RuntimeError("A sparse VHDX is outside this DiskPart workflow.")

    def running_distros(self) -> list[str]:
        result = subprocess.run(
            [str(self.wsl), "--list", "--running", "--quiet"],
            capture_output=True,
            timeout=8,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        output, error = wsl_text(result.stdout), wsl_text(result.stderr)
        if "no running distributions" in (output + " " + error).casefold():
            return []
        if result.returncode or error:
            raise RuntimeError(f"Could not list running WSL distros. {error or output}")
        return [line.strip() for line in output.splitlines() if line.strip()]

    def docker_running(self) -> bool:
        result = self.ps(
            "if (Get-Process -Name 'Docker Desktop','com.docker.backend',"
            "'com.docker.build','com.docker.proxy' -ErrorAction SilentlyContinue)"
            " {'running'} else {'stopped'}"
        )
        if result not in {"running", "stopped"}:
            raise RuntimeError("Could not determine Docker Desktop process state.")
        return result == "running"

    def stop_docker(self, target: Target, journal: Journal) -> None:
        running = {name.casefold() for name in self.running_distros()}
        distro = target["distro"].casefold()
        if distro not in running or running - DOCKER_DISTROS - {distro}:
            raise RuntimeError("Start the approved Ubuntu distro and stop any other Linux distros.")
        if self.docker_running() or running & DOCKER_DISTROS:
            journal("docker-stop-started")
            program_files = Path(os.environ["ProgramFiles"])
            docker = program_files / "Docker" / "Docker" / "resources" / "bin" / "docker.exe"
            self.command(docker, "desktop", "stop", "--timeout", "90", timeout=100)
        deadline = time.monotonic() + 30
        while self.docker_running() or any(
            name.casefold() in DOCKER_DISTROS for name in self.running_distros()
        ):
            if time.monotonic() >= deadline:
                raise RuntimeError("Docker Desktop shutdown did not finish. Ubuntu is still running.")
            time.sleep(1)
        journal("docker-stopped")

    def ensure_windows_access(self, target: Target, journal: Journal) -> None:
        service_state = self.ps(
            "$ssh=Get-Service sshd -ErrorAction SilentlyContinue;"
            "$tailscale=Get-Service Tailscale -ErrorAction SilentlyContinue;"
            "if ($ssh.Status -ne 'Running') {'ssh'}"
            " elseif ($tailscale -and $tailscale.Status -ne 'Running') {'tailscale'}"
            " else {'ready'}"
        )
        if service_state not in {"ssh", "tailscale", "ready"}:
            raise RuntimeError("Windows could not determine recovery service state.")
        if service_state != "ready":
            journal("windows-services-started")
            try:
                self.start_windows_services(target)
            except (OSError, RuntimeError, ValueError, ET.ParseError, subprocess.TimeoutExpired) as error:
                if service_state == "ssh":
                    raise
                journal("windows-tailscale-warning", error=str(error))

        deadline = time.monotonic() + 30
        ssh_pid = None
        while time.monotonic() < deadline:
            try:
                ssh_pid = self.windows_ssh_pid()
                self.verify_windows_ssh(ssh_pid)
                break
            except (OSError, RuntimeError):
                time.sleep(1)
        else:
            raise RuntimeError("Windows OpenSSH did not become reachable. Ubuntu is still running.")

        herdr = Path(os.environ["USERPROFILE"]) / ".local" / "bin" / "herdr.exe"
        args = (herdr, "--session", "main-ud-win")
        deadline = time.monotonic() + 25
        started = False
        while time.monotonic() < deadline:
            try:
                if "status: running" in self.command(*args, "status", "server", timeout=5):
                    journal("windows-access-ready", windows_sshd=ssh_pid, herdr="main-ud-win")
                    return
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            if not started:
                with journal.path.with_suffix(".windows-herdr.log").open("ab") as log:
                    subprocess.Popen(
                        [*map(str, args), "server"], stdin=subprocess.DEVNULL,
                        stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                started = True
            time.sleep(1)
        raise RuntimeError("Windows Herdr session main-ud-win did not become ready.")

    def start_windows_services(self, target: Target) -> None:
        try:
            xml = self.command(self.scheduler, "/Query", "/TN", RECOVERY_TASK, "/XML")
            regular_item(self.install_root / "recover-access.ps1")
        except (OSError, RuntimeError) as error:
            raise SetupRequired(
                "Install the one-time Cross Hub Windows recovery task."
            ) from error
        validate_task(xml, target, self.powershell, self.install_root, "recover-access.ps1")
        validate_task_security(
            self.ps(read_task_script(TASK_SECURITY_QUERY, RECOVERY_TASK)), target
        )
        if self.ps(read_task_script(TASK_RUN, RECOVERY_TASK)) != "accepted":
            raise RuntimeError("Windows did not accept the Cross Hub recovery task.")

    def verify_windows_ssh(self, pid: int) -> None:
        listeners = self.ps(
            f"Get-NetTCPConnection -State Listen -OwningProcess {pid} "
            "-ErrorAction SilentlyContinue | ForEach-Object "
            '{ "$($_.LocalAddress) $($_.LocalPort)" }'
        )
        for line in listeners.splitlines():
            address, port = line.split()
            address = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(address, address)
            try:
                with socket.create_connection((address, int(port)), timeout=2) as ssh:
                    if ssh.recv(128).startswith(b"SSH-"):
                        return
            except OSError:
                continue
        raise RuntimeError("Windows OpenSSH has no responding listener.")

    def windows_ssh_pid(self) -> int:
        result = self.ps(
            "(Get-CimInstance -ClassName Win32_Service -Filter \"Name='sshd'\").ProcessId"
        )
        if not result.isdigit() or int(result) <= 0:
            raise RuntimeError(
                "Start Windows SSH so Windows stays reachable during shutdown."
            )
        return int(result)

    def guest(
        self, target: Target, *args: str, timeout: float = 15, root: bool = False
    ) -> str:
        user = ("-u", "root") if root else ()
        return self.command(
            self.wsl, "-d", target["distro"], *user, "--exec", *args, timeout=timeout
        )

    def guest_identity(self, target: Target) -> Guest:
        uid = self.guest(target, "/usr/bin/id", "-u")
        if not uid.isdecimal() or uid == "0":
            raise RuntimeError(
                "Set the distribution default user to the account used by Herdr."
            )
        home = PurePosixPath(self.guest(target, "/usr/bin/printenv", "HOME"))
        if not home.is_absolute():
            raise RuntimeError("Could not determine the Ubuntu user's home directory.")
        herdr = str(home / ".local/bin/herdr")
        self.guest(target, "/usr/bin/test", "-x", herdr)
        address = self.guest(target, "/usr/bin/tailscale", "ip", "-4")
        addr = ipaddress.IPv4Address(address)
        if addr not in ipaddress.IPv4Network("100.64.0.0/10"):
            raise RuntimeError(
                "The Linux Tailscale address is outside the expected range."
            )
        return Guest(self.boot_id(target), uid, herdr, address)

    def boot_id(self, target: Target) -> str:
        value = self.guest(
            target, "/bin/cat", "/proc/sys/kernel/random/boot_id", timeout=12
        )
        return str(UUID(value))

    def shutdown(self) -> None:
        self.command(self.wsl, "--shutdown", timeout=60)

    def verify_released(self, target: Target) -> None:
        if (
            self.task_state() != TASK_READY
            or self.running_distros()
            or self.docker_running()
        ):
            raise RuntimeError(
                "Stop Docker Desktop and keep WSL offline while verifying disk release."
            )
        require_disk_identity(target, exclusive=True)
        disk = target["vhdx"].replace("'", "''")
        state = self.ps(
            "$ErrorActionPreference='Stop';"
            r'Import-Module "$PSHOME\Modules\Storage\Storage.psd1";'
            f"$image=Get-DiskImage -ImagePath '{disk}';"
            "if ($image.Attached -eq $false) {'released'} else {'attached'}"
        )
        if state != "released":
            raise RuntimeError("Windows has not confirmed the VHDX is detached.")
        if self.task_state() != TASK_READY:
            raise TaskBusy(
                "The compaction task became active during disk verification."
            )

    def start_compaction(self) -> None:
        response = self.ps(read_task_script(TASK_RUN))
        if response == "accepted":
            return
        if response == "rejected:80070005":
            raise DispatchDenied(
                "Task Scheduler denied the compaction request (0x80070005)."
            )
        raise RuntimeError(
            f"Task Scheduler did not confirm compaction dispatch. {response}"
        )

    def measurements(self, target: Target) -> dict[str, int]:
        vhdx = Path(target["vhdx"])
        return {
            "c_free_bytes": shutil.disk_usage("C:\\").free,
            "vhdx_length_bytes": regular_item(vhdx).st_size,
        }

    def require_preflight(self, target: Target) -> int:
        if self.running_distros() != [target["distro"]]:
            raise RuntimeError(
                f"Start {target['distro']} and stop all other WSL distributions."
            )
        if self.docker_running():
            raise RuntimeError("Stop Docker Desktop with ud docker stop, then retry.")
        return self.windows_ssh_pid()

    def prepare_guest(self, target: Target) -> str:
        self.guest(target, "/usr/bin/sync", timeout=60, root=True)
        return self.guest(target, "/usr/sbin/fstrim", "-v", "/", timeout=240, root=True)

    def wait_stopped(self) -> None:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if not self.running_distros():
                return
            time.sleep(1)
        raise RuntimeError(
            "Windows could not verify that all WSL distros have stopped."
        )

    def launch_herdr(self, target: Target, guest: Guest, journal: Journal) -> None:
        output = journal.path.with_suffix(".herdr.log")
        with output.open("ab") as log:
            process = subprocess.Popen(
                [
                    str(self.wsl),
                    "-d",
                    target["distro"],
                    "--exec",
                    guest.herdr,
                    "server",
                ],
                cwd=os.environ["USERPROFILE"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW
                | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        journal("herdr-launch-requested", windows_pid=process.pid)

    def recover(
        self, target: Target, guest: Guest, must_reboot: bool, journal: Journal
    ) -> None:
        journal("restart-requested")
        deadline = time.monotonic() + 90
        last_error = ""
        observed_boot: str | None = None
        launched_herdr = False
        started_guest_services = False
        while time.monotonic() < deadline:
            try:
                boot = self.boot_id(target)
                if boot != observed_boot:
                    observed_boot = boot
                    journal(
                        "ubuntu-started",
                        boot_id=boot,
                        boot_changed=boot != guest.boot_id,
                    )
                if must_reboot and boot == guest.boot_id:
                    raise RuntimeError("Ubuntu still reports the original boot ID.")
                if not started_guest_services:
                    self.guest(
                        target, "/usr/bin/systemctl", "start", "tailscaled",
                        "ssh.socket", timeout=15, root=True,
                    )
                    started_guest_services = True
                address = self.guest(
                    target, "/usr/bin/tailscale", "ip", "-4", timeout=6
                )
                if address != guest.tailscale_ipv4:
                    raise RuntimeError(
                        "The prior Ubuntu Tailscale address is not ready."
                    )
                runtime = f"/run/user/{guest.uid}"
                moshi = self.guest(
                    target,
                    "/usr/bin/env",
                    f"XDG_RUNTIME_DIR={runtime}",
                    f"DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus",
                    "/bin/systemctl",
                    "--user",
                    "is-active",
                    "moshi-hook.service",
                    timeout=6,
                )
                if moshi != "active":
                    raise RuntimeError("The Moshi hook is not active.")
                try:
                    herdr = self.guest(
                        target, guest.herdr, "status", "server", timeout=6
                    )
                except (RuntimeError, subprocess.TimeoutExpired):
                    herdr = ""
                if "status: running" not in herdr:
                    if not launched_herdr:
                        self.launch_herdr(target, guest, journal)
                        launched_herdr = True
                    raise RuntimeError("The Linux Herdr server is not ready.")
                with socket.create_connection((address, 22), timeout=3) as ssh:
                    if not ssh.recv(128).startswith(b"SSH-"):
                        raise RuntimeError(
                            "The Linux SSH listener did not send its banner."
                        )
                journal(
                    "recovery-ready",
                    boot_id=boot,
                    tailscale_ipv4=address,
                    moshi_hook=moshi,
                    herdr_running=True,
                    linux_ssh=True,
                )
                return
            except (
                OSError,
                RuntimeError,
                ValueError,
                subprocess.TimeoutExpired,
            ) as error:
                if str(error) != last_error:
                    last_error = str(error)
                    journal("recovery-waiting", error=last_error)
                time.sleep(2)
        raise RuntimeError(f"Recovery checks timed out. {last_error}")


def read_elevated_rows(
    file: Path, offset: int
) -> Iterator[tuple[int, dict[str, object]]]:
    try:
        handle = file.open("rb")
    except FileNotFoundError:
        if offset:
            raise RuntimeError("The Windows compaction journal disappeared.") from None
        return
    with handle:
        if os.fstat(handle.fileno()).st_size < offset:
            raise RuntimeError("The Windows compaction journal was truncated.")
        handle.seek(offset)
        while raw := handle.readline(MAX_EVENT_BYTES + 1):
            if len(raw) > MAX_EVENT_BYTES:
                raise ValueError("An elevated journal line exceeds its size limit.")
            if not raw.endswith(b"\n"):
                return
            row = json.loads(raw)
            if not isinstance(row, dict):
                raise TypeError("The elevated journal returned an invalid event.")
            yield handle.tell(), row


def parse_compaction_result(row: dict[str, object]) -> CompactionResult:
    started, compacted, detached = (
        row.get("work_started"),
        row.get("compaction_ok"),
        row.get("detach_verified"),
    )
    error = row.get("error")
    if (
        not isinstance(started, bool)
        or not isinstance(compacted, bool)
        or not isinstance(detached, bool)
        or (error is not None and not isinstance(error, str))
        or (compacted and not started)
    ):
        raise ValueError("The Windows compaction helper returned an invalid result.")
    return {
        "work_started": started,
        "compaction_ok": compacted,
        "detach_verified": detached,
        "error": error,
    }


def wait_for_compaction(
    host: WindowsHost, offset: int, journal: Journal
) -> CompactionResult:
    started = time.monotonic()
    next_notice = started + 15
    run_id: str | None = None
    result: CompactionResult | None = None
    cursor = offset
    while time.monotonic() - started < COMPACTION_TIMEOUT:
        for next_cursor, row in read_elevated_rows(host.task_log, cursor):
            cursor = next_cursor
            event_id, stage = row.pop("run_id", None), row.pop("stage", None)
            if not isinstance(event_id, str) or not isinstance(stage, str):
                raise TypeError(
                    "The Windows compaction journal event lacks a run ID or stage."
                )
            if stage == "diskpart-started":
                if run_id is not None:
                    raise RuntimeError("Two Windows compaction runs overlapped.")
                run_id = str(UUID(event_id))
            if run_id is None or str(UUID(event_id)) != run_id or result is not None:
                raise RuntimeError(
                    "Could not correlate output with the requested compaction run."
                )
            if stage == "diskpart-result":
                result = parse_compaction_result(row)
            elevated_at = row.pop("at", None)
            journal(stage, elevated_at=elevated_at, elevated_run_id=run_id, **row)
        if result is not None and host.task_state() == TASK_READY:
            return result
        now = time.monotonic()
        if now >= next_notice:
            journal("compaction-heartbeat", elapsed_seconds=round(now - started))
            next_notice = now + 15
            if host.task_state() == TASK_READY:
                if result is not None:
                    return result
                # The last line can land between the read and the scheduler query.
                if not list(read_elevated_rows(host.task_log, cursor)):
                    try:
                        detail = (
                            f" Latest Task Scheduler result: {host.last_task_result()}."
                        )
                    except (
                        OSError,
                        RuntimeError,
                        ValueError,
                        subprocess.TimeoutExpired,
                    ):
                        detail = ""
                    raise RuntimeError(
                        "The compaction task exited without a result." + detail
                    )
        time.sleep(0.5)
    raise RuntimeError(
        "Compaction result timed out. Inspect the Windows task before restarting WSL."
    )


def maintenance_health(
    factory: Callable[[], WindowsHost] = WindowsHost,
) -> dict[str, object]:
    try:
        host = factory()
        target = host.installed_target()
    except TaskBusy as error:
        return {"state": "busy", "message": str(error)}
    except SetupMissing as error:
        return {
            "state": "missing",
            "message": str(error),
            "hint": "Run one-time Windows compaction setup.",
        }
    except SetupRequired as error:
        return {
            "state": "misconfigured",
            "message": str(error),
            "hint": "Review the existing Windows compaction registration or disk configuration.",
        }
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        TypeError,
        ET.ParseError,
        subprocess.TimeoutExpired,
    ) as error:
        return {"state": "unavailable", "message": str(error)}
    return {"state": "ready", "distro": target["distro"], "vhdx": target["vhdx"]}


def journal_offset(path: Path) -> int:
    try:
        return regular_item(path).st_size
    except FileNotFoundError:
        return 0


def execute_maintenance(host: WindowsHost, journal: Journal) -> tuple[str, RunSummary]:
    phase = "preflight"
    shutdown_requested = False
    stop_verified = False
    detach_verified = False
    compaction_requested = False
    summary: RunSummary = {"compaction_ok": False, "recovery_ok": False}
    try:
        journal("preflight-started")
        target = host.installed_target()
        host.ensure_windows_access(target, journal)
        host.stop_docker(target, journal)
        ssh_pid = host.require_preflight(target)
        guest = host.guest_identity(target)
        journal(
            "preflight-passed",
            distro=target["distro"],
            vhdx=target["vhdx"],
            volume_serial=target["volume_serial"],
            file_id=target["file_id"],
            boot_id=guest.boot_id,
            windows_sshd=ssh_pid,
            docker="stopped",
        )
        phase = "trim"
        journal("trim-started")
        journal("trim-completed", output=host.prepare_guest(target))
        before = host.measurements(target)
        journal("windows-baseline", **before)

        phase = "shutdown-preflight"
        if (
            host.installed_target() != target
            or host.require_preflight(target) != ssh_pid
        ):
            raise RuntimeError("Windows preflight changed before shutdown.")
        offset = journal_offset(host.task_log)
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        ET.ParseError,
        subprocess.TimeoutExpired,
    ) as error:
        journal.allow_degraded = True
        journal("phase-failed", phase=phase, error=str(error))
        return "failed", {**summary, "error": str(error)}

    try:
        phase = "shutdown"
        journal("shutdown-requested")
        # Require a durable intent before touching WSL. Once it is down,
        # losing the user journal must never suppress a verified-safe restart.
        journal.allow_degraded = True
        shutdown_requested = True
        host.shutdown()
        host.wait_stopped()
        stop_verified = True
        journal(
            "shutdown-observed",
            all_distros_stopped=True,
            windows_sshd=host.windows_ssh_pid(),
        )

        phase = "compaction"
        if (
            host.installed_target() != target
            or host.running_distros()
            or host.docker_running()
        ):
            raise RuntimeError("The compaction preflight changed after shutdown.")
        if journal_offset(host.task_log) != offset:
            raise RuntimeError("Another compaction ran during shutdown.")
        journal("compaction-requested", journal_offset=offset)
        compaction_requested = True
        try:
            host.start_compaction()
        except DispatchDenied:
            host.verify_released(target)
            if journal_offset(host.task_log) != offset:
                raise RuntimeError(
                    "The protected journal changed after the dispatch denial."
                )
            compaction_requested = False
            journal("compaction-dispatch-denied", disk_released=True)
            raise
        outcome = wait_for_compaction(host, offset, journal)
        detach_verified = outcome["detach_verified"]
        summary["detach_verified"] = detach_verified
        summary["compaction_ok"] = outcome["compaction_ok"]
        if not detach_verified:
            raise RuntimeError(
                outcome["error"] or "Windows could not confirm disk detachment."
            )
        after = host.measurements(target)
        summary["vhdx_reduction_bytes"] = (
            before["vhdx_length_bytes"] - after["vhdx_length_bytes"]
        )
        summary["c_free_delta_bytes"] = after["c_free_bytes"] - before["c_free_bytes"]
        journal("windows-result", before=before, after=after, **summary)
        if not outcome["compaction_ok"]:
            raise RuntimeError(
                outcome["error"] or "DiskPart did not complete compaction."
            )
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        TypeError,
        ET.ParseError,
        subprocess.TimeoutExpired,
    ) as error:
        summary["error"] = str(error)
        journal.allow_degraded = True
        journal("phase-failed", phase=phase, error=str(error))

    if compaction_requested and not detach_verified:
        journal(
            "recovery-deferred",
            message="Verify disk detachment on Windows before restarting WSL.",
        )
        return "attention", summary
    if shutdown_requested:
        try:
            if host.task_state() != TASK_READY or (
                not compaction_requested and journal_offset(host.task_log) != offset
            ):
                journal(
                    "recovery-deferred",
                    message="An independent compaction may still need disk detachment.",
                )
                return "attention", summary
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            journal("recovery-deferred", error=str(error))
            return "attention", summary
        try:
            host.recover(target, guest, stop_verified, journal)
            host.ensure_windows_access(target, journal)
            summary["recovery_ok"] = True
            journal(
                "windows-ssh-observed",
                windows_sshd_preserved=host.windows_ssh_pid() == ssh_pid,
            )
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            journal("recovery-failed", error=str(error))
            summary["error"] = f"{summary.get('error', '')} {error}".strip()
            return "failed", summary
    return ("failed" if "error" in summary else "completed"), summary
