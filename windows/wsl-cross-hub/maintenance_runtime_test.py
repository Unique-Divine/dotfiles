import json
from pathlib import Path
from uuid import uuid4

import maintenance_runtime as runtime
import pytest

TARGET: runtime.Target = {
    "owner_sid": "S-1-5-21-1",
    "distro": "Ubuntu-24.04",
    "registration": "{01234567-89ab-cdef-0123-456789abcdef}",
    "volume_serial": "0123ABCD",
    "file_id": "000011112222ABCD",
    "vhdx": r"C:\Users\Name\Ubuntu\ext4.vhdx",
}
GUEST = runtime.Guest(
    "boot-before", "1000", "/home/name/.local/bin/herdr", "100.103.68.42"
)


class RecordingHost(runtime.WindowsHost):
    def __init__(
        self,
        task_log: Path,
        *,
        problem: str = "",
    ) -> None:
        self.calls: list[str] = []
        self.task_log = task_log
        self.problem = problem
        self.stopped = False

    def installed_target(self) -> runtime.Target:
        self.calls.append("check-task")
        if self.problem == "missing":
            raise runtime.SetupMissing("Run one-time setup.")
        if self.problem == "foreign" and self.stopped:
            raise RuntimeError("Another compaction is running.")
        return TARGET

    def require_preflight(self, target: runtime.Target) -> int:
        self.calls.append("preflight")
        if self.problem == "docker":
            raise RuntimeError("Stop Docker Desktop.")
        return 42

    def guest_identity(self, target: runtime.Target) -> runtime.Guest:
        return GUEST

    def prepare_guest(self, target: runtime.Target) -> str:
        self.calls.append("trim")
        return "/: 10 GiB (10737418240 bytes) trimmed"

    def measurements(self, target: runtime.Target) -> dict[str, int]:
        self.calls.append("measure")
        return {
            "c_free_bytes": 15 if self.stopped else 10,
            "vhdx_length_bytes": 10 if self.stopped else 15,
        }

    def shutdown(self) -> None:
        self.calls.append("shutdown")
        self.stopped = True
        if self.problem == "shutdown":
            raise RuntimeError("WSL shutdown call timed out.")
        if self.problem == "foreign":
            self.event("diskpart-started", str(uuid4()))

    def wait_stopped(self) -> None:
        self.calls.append("verify-stopped")

    def stop_docker(self, target: runtime.Target, journal: runtime.Journal) -> None:
        if self.problem == "docker-shutdown":
            raise RuntimeError("Docker shutdown timed out.")

    def ensure_windows_access(self, target: runtime.Target, journal: runtime.Journal) -> None:
        if self.problem == "windows-recovery":
            raise RuntimeError("Windows OpenSSH is unavailable.")

    def windows_ssh_pid(self) -> int:
        return 42

    def running_distros(self) -> list[str]:
        return [] if self.stopped else [TARGET["distro"]]

    def docker_running(self) -> bool:
        return False

    def task_state(self) -> int:
        return 4 if self.problem == "foreign" else 3

    def event(self, stage: str, run_id: str, **data: object) -> None:
        with self.task_log.open("a", encoding="utf-8") as handle:
            row = {
                "at": "2026-11-22T15:00:00Z",
                "stage": stage,
                "run_id": run_id,
                **data,
            }
            handle.write(json.dumps(row) + "\n")

    def verify_released(self, target: runtime.Target) -> None:
        if self.problem == "denied-busy-disk":
            raise RuntimeError("The VHDX has an active Windows handle.")

    def start_compaction(self) -> None:
        self.calls.append("launch")
        if self.problem.startswith("denied"):
            raise runtime.DispatchDenied("Task Scheduler access denied.")
        if self.problem == "launch":
            raise RuntimeError("The scheduler call timed out.")
        run_id = str(uuid4())
        self.event("diskpart-started", run_id)
        self.event("diskpart-output", run_id, line="50 percent completed", percent=50)
        self.event("detach-requested", run_id)
        if self.problem == "overlap":
            self.event("diskpart-started", str(uuid4()))
        self.event(
            "diskpart-result",
            run_id,
            work_started=True,
            compaction_ok=self.problem != "compact",
            detach_verified=self.problem != "detach",
        )

    def recover(
        self,
        target: runtime.Target,
        guest: runtime.Guest,
        must_reboot: bool,
        journal: runtime.Journal,
    ) -> None:
        self.calls.append("recover")
        if self.problem == "recovery":
            raise RuntimeError("Ubuntu did not return.")
        assert must_reboot is (self.problem != "shutdown")
        journal("recovery-ready")


def read_events(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_maintenance_uses_fresh_diskpart_output_and_recovers(tmp_path: Path) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl")
    stale_id = str(uuid4())
    host.event("diskpart-started", stale_id)
    host.event(
        "diskpart-result",
        stale_id,
        work_started=True,
        compaction_ok=True,
        detach_verified=True,
    )
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, summary = runtime.execute_maintenance(host, journal)

    assert state == "completed"
    assert summary == {
        "compaction_ok": True,
        "detach_verified": True,
        "recovery_ok": True,
        "vhdx_reduction_bytes": 5,
        "c_free_delta_bytes": 5,
    }
    assert host.calls == [
        "check-task",
        "preflight",
        "trim",
        "measure",
        "check-task",
        "preflight",
        "shutdown",
        "verify-stopped",
        "check-task",
        "launch",
        "measure",
        "recover",
    ]
    events = read_events(journal.path)
    assert all(row["job_id"] == journal.job_id for row in events)
    assert stale_id not in journal.path.read_text()
    progress = [row for row in events if row["stage"] == "diskpart-output"]
    assert [row["percent"] for row in progress] == [50]


@pytest.mark.parametrize("problem", ["missing", "docker"])
def test_preflight_failure_leaves_wsl_untouched(tmp_path: Path, problem: str) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem=problem)
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, result = runtime.execute_maintenance(host, journal)

    assert state == "failed"
    assert "error" in result
    assert "trim" not in host.calls
    assert "shutdown" not in host.calls


@pytest.mark.parametrize(
    "problem", ["launch", "detach", "overlap", "foreign", "denied-busy-disk"]
)
def test_unclear_detachment_prevents_restart(tmp_path: Path, problem: str) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem=problem)
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, summary = runtime.execute_maintenance(host, journal)

    assert state == "attention"
    assert not summary["recovery_ok"]
    assert "recover" not in host.calls
    assert read_events(journal.path)[-1]["stage"] == "recovery-deferred"


def test_recovery_failure_retains_diskpart_success(tmp_path: Path) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem="recovery")
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, summary = runtime.execute_maintenance(host, journal)

    assert state == "failed"
    assert summary["compaction_ok"]
    assert summary["detach_verified"]
    assert not summary["recovery_ok"]


@pytest.mark.parametrize("problem", ["compact", "shutdown", "denied"])
def test_recovers_when_safe_after_a_failure(tmp_path: Path, problem: str) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem=problem)
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, summary = runtime.execute_maintenance(host, journal)

    assert state == "failed"
    assert not summary["compaction_ok"]
    assert summary["recovery_ok"]
    assert host.calls[-1] == "recover"


def test_partial_line_and_journal_truncation(tmp_path: Path) -> None:
    path = tmp_path / "diskpart.jsonl"
    path.write_bytes(b'{"stage": "ready"}\n{"stage":')
    events = list(runtime.read_elevated_rows(path, 0))
    assert len(events) == 1
    cursor, row = events[0]
    assert row["stage"] == "ready"
    assert not list(runtime.read_elevated_rows(path, cursor))

    path.write_bytes(b"")
    with pytest.raises(RuntimeError, match="truncated"):
        list(runtime.read_elevated_rows(path, cursor))


@pytest.mark.parametrize(
    "change",
    [
        "<LogonType>InteractiveToken</LogonType>",
        "<AllowStartOnDemand>false</AllowStartOnDemand>",
    ],
)
def test_rejects_unattended_task_mismatch(tmp_path: Path, change: str) -> None:
    exe = tmp_path / "powershell.exe"
    xml = registered_task_xml(tmp_path, exe)
    runtime.validate_task(xml, TARGET, exe, tmp_path)
    original = (
        "<LogonType>S4U</LogonType>"
        if "<LogonType>" in change
        else "<AllowStartOnDemand>true</AllowStartOnDemand>"
    )
    with pytest.raises(runtime.SetupRequired, match="does not match"):
        runtime.validate_task(xml.replace(original, change), TARGET, exe, tmp_path)


def registered_task_xml(tmp_path: Path, exe: Path) -> str:
    arguments = f'{runtime.POWERSHELL_ARGS} "{tmp_path / runtime.EXPECTED_HELPER}"'
    logon = "<LogonType>S4U</LogonType>"
    demand = "<AllowStartOnDemand>true</AllowStartOnDemand>"
    return f"""<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
      <Principals><Principal><UserId>{TARGET["owner_sid"]}</UserId>
      {logon}<RunLevel>HighestAvailable</RunLevel></Principal></Principals>
      <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>{demand}</Settings>
      <Actions><Exec><Command>{exe}</Command><Arguments>{arguments}</Arguments>
      <WorkingDirectory>{tmp_path}</WorkingDirectory></Exec></Actions>
    </Task>"""


def test_health_reports_setup_required_without_touching_linux(tmp_path: Path) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem="missing")
    assert runtime.maintenance_health(lambda: host) == {
        "state": "missing",
        "message": "Run one-time setup.",
        "hint": "Run one-time Windows compaction setup.",
    }
    assert host.calls == ["check-task"]


def registered_task_security() -> dict[str, object]:
    acl = [
        {
            "sid": runtime.LOCAL_SYSTEM_SID,
            "type": 0,
            "flags": 0,
            "mask": runtime.FILE_FULL_CONTROL,
        },
        {
            "sid": runtime.ADMINISTRATORS_SID,
            "type": 0,
            "flags": 0,
            "mask": runtime.FILE_FULL_CONTROL,
        },
        {
            "sid": TARGET["owner_sid"],
            "type": 0,
            "flags": 0,
            "mask": runtime.FILE_READ_EXECUTE,
        },
    ]
    return {"owner": runtime.ADMINISTRATORS_SID, "protected": True, "acl": acl}


def test_task_security_requires_protected_owner_and_read_run_rights() -> None:
    descriptor = registered_task_security()
    acl = descriptor["acl"]
    assert isinstance(acl, list)
    runtime.validate_task_security(json.dumps(descriptor), TARGET)

    with pytest.raises(runtime.SetupRequired, match="protected administrator"):
        runtime.validate_task_security(
            json.dumps({**descriptor, "owner": TARGET["owner_sid"]}), TARGET
        )

    for rights in (0x120089, runtime.FILE_FULL_CONTROL):
        acl[-1]["mask"] = rights
        with pytest.raises(
            runtime.SetupRequired, match="matching read/run permissions"
        ):
            runtime.validate_task_security(json.dumps(descriptor), TARGET)


def test_verified_recovery_survives_lost_user_journal(tmp_path: Path) -> None:
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    class HostLosesUserJournal(RecordingHost):
        def shutdown(self) -> None:
            journal.path.unlink()
            journal.path.mkdir()
            super().shutdown()

    host = HostLosesUserJournal(tmp_path / "diskpart.jsonl")

    state, result = runtime.execute_maintenance(host, journal)

    assert state == "completed"
    assert result["recovery_ok"]
    assert result["detach_verified"]
    assert journal.error
    assert host.calls[-1] == "recover"


@pytest.mark.parametrize(
    ("state", "expected", "message"),
    [
        (1, "misconfigured", "disabled"),
        (2, "busy", "already queued or running"),
        (4, "busy", "already queued or running"),
    ],
)
def test_registered_task_health(
    tmp_path: Path, state: int, expected: str, message: str
) -> None:
    class ScheduledHost(runtime.WindowsHost):
        def __init__(self) -> None:
            self.install_root = tmp_path
            self.task_log = tmp_path / "diskpart.jsonl"
            self.powershell = tmp_path / "powershell.exe"
            self.scheduler = tmp_path / "schtasks.exe"

        def command(self, *args: str | Path, timeout: float = 15) -> str:
            return registered_task_xml(self.install_root, self.powershell)

        def ps(self, script: str) -> str:
            return json.dumps(registered_task_security())

        def check_registered_target(self, target: runtime.Target) -> None:
            assert target == TARGET

        def task_state(self) -> int:
            return state

    (tmp_path / "target.json").write_text(json.dumps(TARGET), encoding="utf-8")
    (tmp_path / runtime.EXPECTED_HELPER).touch()
    (tmp_path / "diskpart.jsonl").touch()

    result = runtime.maintenance_health(ScheduledHost)

    assert result["state"] == expected
    assert message in str(result["message"])


@pytest.mark.parametrize(
    ("response", "error"),
    [
        ("accepted", None),
        ("rejected:80070005", runtime.DispatchDenied),
        ("rejected:80041326", RuntimeError),
        ("unknown", RuntimeError),
    ],
)
def test_only_definitive_access_denial_is_reported_as_no_dispatch(
    response: str,
    error: type[RuntimeError] | None,
) -> None:
    class Scheduler(runtime.WindowsHost):
        def __init__(self) -> None:
            pass

        def ps(self, script: str) -> str:
            assert "$task.Run($null)" in script
            assert runtime.TASK_LEAF_NAME in script
            return response

    host = Scheduler()
    if error is None:
        host.start_compaction()
    else:
        with pytest.raises(error) as result:
            host.start_compaction()
        assert type(result.value) is error


@pytest.mark.parametrize("problem", ["docker-shutdown", "windows-recovery"])
def test_preflight_failure_leaves_ubuntu_running(tmp_path: Path, problem: str) -> None:
    host = RecordingHost(tmp_path / "diskpart.jsonl", problem=problem)
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    state, summary = runtime.execute_maintenance(host, journal)

    assert state == "failed"
    assert summary["compaction_ok"] is False
    assert "shutdown" not in host.calls
    assert read_events(journal.path)[-1]["phase"] == "preflight"


def test_docker_uses_graceful_native_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    host = object.__new__(runtime.WindowsHost)
    running = [TARGET["distro"], "docker-desktop", "docker-desktop-data"]
    commands: list[tuple[str, ...]] = []
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.setattr(host, "running_distros", lambda: running[:])
    monkeypatch.setattr(host, "docker_running", lambda: len(running) > 1)

    def command(*argv: str | Path, timeout: float = 15) -> str:
        commands.append(tuple(str(arg) for arg in argv))
        running[:] = [TARGET["distro"]]
        return ""

    monkeypatch.setattr(host, "command", command)
    journal = runtime.Journal(tmp_path / "jobs", str(uuid4()))

    host.stop_docker(TARGET, journal)
    host.stop_docker(TARGET, journal)

    assert commands == [(
        str(tmp_path / "Docker/Docker/resources/bin/docker.exe"),
        "desktop", "stop", "--timeout", "90",
    )]
    assert [event["stage"] for event in read_events(journal.path)] == [
        "docker-stop-started", "docker-stopped", "docker-stopped",
    ]
