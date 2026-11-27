import json
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
import worker

SCRIPT = Path(worker.__file__)


def test_probe_outlives_client(tmp_path: Path) -> None:
    interpreter = Path(sys.executable)
    if sys.platform == "win32":
        # A Windows venv launcher has a different PID from its Python child.
        interpreter = Path(sys.base_prefix) / "python.exe"
    base = [str(interpreter), str(SCRIPT), "--state-dir", str(tmp_path)]
    with subprocess.Popen(
        [*base, "worker"], stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ) as process:
        try:
            request = subprocess.run(
                [*base, "probe"], capture_output=True, check=True, timeout=10
            )
            client_exited_at = datetime.now(UTC)
            ack = json.loads(request.stdout)
            assert ack["state"] == "accepted"
            for _ in range(50):
                time.sleep(0.1)
                status = worker.job_status(tmp_path / "jobs.sqlite3", ack["job_id"])
                if status and status["state"] == "completed":
                    break
            else:
                pytest.fail("worker did not complete the accepted probe")
            assert status["accepted_at"] == ack["accepted_at"]
            assert datetime.fromisoformat(str(status["finished_at"])) > client_exited_at
            result = status["result"]
            assert isinstance(result, dict)
            assert result["message"] == "WSL Cross Hub probe completed"
            assert result["pid"] == process.pid
            assert Path(result["executable"]).resolve() == interpreter.resolve()
            assert result["platform"] == sys.platform

            duplicate = subprocess.run(
                [*base, "worker"], capture_output=True, check=False, timeout=5
            )
            assert duplicate.returncode == 1
            assert b"already running" in duplicate.stderr
            log = (tmp_path / "logs" / "worker.log").read_text(encoding="utf-8")
            assert log.count("worker_started") == 1
            assert f"job_accepted job_id={ack['job_id']}" in log
            assert f"job_completed job_id={ack['job_id']}" in log
        finally:
            process.terminate()
            process.wait(timeout=5)


def test_restart_preserves_interrupted_job_and_rejects_duplicate(
    tmp_path: Path,
) -> None:
    job_id = str(uuid4())
    inbox = tmp_path / "requests"
    path = inbox / f"{job_id}.json"
    db_path = tmp_path / "jobs.sqlite3"
    request: worker.Request = {"job_id": job_id, "operation": "probe"}
    worker.write_request(inbox, request)

    log_dir = tmp_path / "logs"
    with (
        worker.worker_log(log_dir) as log,
        closing(worker.open_database(db_path)) as db,
    ):
        worker.initialize(db)
        assert worker.claim_request(db, path, log) == request
    worker.write_request(inbox, request)
    worker.run_worker(tmp_path, once=True)

    status = worker.job_status(db_path, job_id)
    assert status is not None
    assert status["state"] == "interrupted"
    assert status["result"] is None
    assert worker.worker_status(db_path)["state"] == "ready"
    assert not path.exists()
    log_contents = (log_dir / "worker.log").read_text(encoding="utf-8")
    assert log_contents.count(f"job_accepted job_id={job_id}") == 1
    assert log_contents.count(f"job_interrupted job_id={job_id}") == 1


@pytest.mark.parametrize(
    "body",
    [
        '{ "job_id": "other", "operation": "probe" }',
        '{"operation": "shutdown"}',
        "{" * 1025,
        "malformed",
    ],
)
def test_worker_discards_invalid_requests(tmp_path: Path, body: str) -> None:
    inbox = tmp_path / "requests"
    inbox.mkdir()
    job_id = str(uuid4())
    path = inbox / f"{job_id}.json"
    path.write_text(body, encoding="utf-8")

    worker.run_worker(tmp_path, once=True)

    assert not path.exists()
    assert worker.job_status(tmp_path / "jobs.sqlite3", job_id) is None
    log = (tmp_path / "logs" / "worker.log").read_text(encoding="utf-8")
    assert "request_rejected" in log
    assert body not in log
    assert job_id not in log


def test_worker_logs_database_startup_failure(tmp_path: Path) -> None:
    (tmp_path / "jobs.sqlite3").mkdir()

    with pytest.raises(sqlite3.OperationalError):
        worker.run_worker(tmp_path, once=True)

    log = (tmp_path / "logs" / "worker.log").read_text(encoding="utf-8")
    assert "worker_started" in log
    assert "worker_failed error_type=OperationalError" in log


def test_worker_log_rotates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker, "LOG_MAX_BYTES", 128)

    for _ in range(10):
        worker.run_worker(tmp_path, once=True)

    logs = sorted((tmp_path / "logs").glob("worker.log*"))
    assert [log.name for log in logs] == [
        "worker.log",
        "worker.log.1",
        "worker.log.2",
        "worker.log.3",
    ]
    for log in logs:
        assert log.stat().st_size < 128
        assert log.read_text(encoding="utf-8").count("worker_started") == 2


def test_offline_status_does_not_create_state(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    state_dir = tmp_path / "state"

    assert worker.main(["--state-dir", str(state_dir), "status"]) == 0

    output = capsys.readouterr()
    assert json.loads(output.out) == {"state": "offline"}
    assert output.err == ""
    assert not state_dir.exists()


@pytest.mark.parametrize("job_id", ["../job", str(uuid4()).upper(), "0" * 32])
def test_rejects_noncanonical_id(job_id: str) -> None:
    with pytest.raises(ValueError, match="lowercase UUIDv4"):
        worker.parse_job_id(job_id)


def test_legacy_windows_heartbeat_does_not_report_compaction(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.sqlite3"
    with closing(worker.open_database(db_path)) as db:
        worker.initialize(db)
        with db:
            db.execute(
                "INSERT OR REPLACE INTO worker VALUES (1, ?, ?, ?, ?)",
                (42, "python.exe", "win32", worker.timestamp()),
            )
            db.execute(
                "INSERT INTO worker_capabilities VALUES (1, ?, ?, ?)",
                (42, "old-timestamp", worker.MAINTENANCE_PROTOCOL),
            )

    status = worker.worker_status(db_path)
    assert status["state"] == "ready"
    assert "maintenance_protocol" not in status
    with pytest.raises(RuntimeError, match="updated, running Windows worker"):
        worker.submit(tmp_path, "compact")
    assert not (tmp_path / "requests").exists()


def test_expired_compaction_request_is_discarded(tmp_path: Path) -> None:
    import os

    job_id = str(uuid4())
    inbox = tmp_path / "requests"
    worker.write_request(inbox, {"job_id": job_id, "operation": "compact"})
    request = inbox / f"{job_id}.json"
    old_time = time.time() - worker.ACK_TIMEOUT - 1
    os.utime(request, (old_time, old_time))

    worker.run_worker(tmp_path, once=True)

    assert not request.exists()
    assert worker.job_status(tmp_path / "jobs.sqlite3", job_id) is None
    log = (tmp_path / "logs" / "worker.log").read_text(encoding="utf-8")
    assert "compaction_request_expired" in log


def test_worker_keeps_heartbeat_during_compaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.sqlite3"
    job_id = str(uuid4())
    monkeypatch.setattr(worker, "HEARTBEAT_INTERVAL", 0.01)

    def active_job(*_args: object) -> tuple[str, dict[str, bool]]:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if worker.worker_status(db_path).get("heartbeat_at") != initial:
                return "completed", {"compaction_ok": True}
            time.sleep(0.01)
        pytest.fail("The worker stopped publishing its heartbeat during compaction.")

    monkeypatch.setattr(worker, "run_compaction", active_job)
    with closing(worker.open_database(db_path)) as db:
        worker.initialize(db)
        with db:
            db.execute(
                "INSERT INTO jobs (job_id, state, accepted_at, operation) "
                "VALUES (?, 'accepted', ?, 'compact')",
                (job_id, worker.timestamp()),
            )
        worker.heartbeat(db)
        initial = worker.worker_status(db_path)["heartbeat_at"]
        assert (
            worker.process_compaction(
                db, tmp_path, job_id, worker.maintenance_runtime.WindowsHost
            )
            == "completed"
        )
    assert worker.job_status(db_path, job_id)["state"] == "completed"


def test_hold_acknowledgment_requires_verified_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.sqlite3"
    job_id = str(uuid4())
    with closing(worker.open_database(db_path)) as db:
        worker.initialize(db)
        with db:
            db.execute(
                "INSERT INTO jobs (job_id, state, accepted_at, operation, result) "
                "VALUES (?, 'attention', ?, 'compact', ?)",
                (job_id, worker.timestamp(), '{"compaction_ok": false}'),
            )

    class Host:
        released = False

        def installed_target(self) -> dict[str, str]:
            return {"vhdx": "target"}

        def verify_released(self, target: dict[str, str]) -> None:
            assert target["vhdx"] == "target"
            if not self.released:
                raise RuntimeError("Disk is locked.")

    host = Host()
    monkeypatch.setattr(worker.maintenance_runtime, "WindowsHost", lambda: host)
    with pytest.raises(RuntimeError, match="locked"):
        worker.acknowledge_hold(tmp_path, job_id)
    with closing(worker.open_database(db_path, read_only=True)) as db:
        assert worker.pending_hold(db) == job_id

    host.released = True
    status = worker.acknowledge_hold(tmp_path, job_id)
    assert status["state"] == "acknowledged"
    assert status["result"]["compaction_ok"] is False
    assert "hold_acknowledged_at" in status["result"]
    with closing(worker.open_database(db_path, read_only=True)) as db:
        assert worker.pending_hold(db) is None

def test_worker_upgrade_refuses_unacknowledged_request(tmp_path: Path, capsys) -> None:
    worker.write_request(tmp_path / "requests", {
        "job_id": str(uuid4()), "operation": "compact",
    })
    assert worker.main(["--state-dir", str(tmp_path), "require-idle"]) == 1
    assert "queued Cross Hub requests" in capsys.readouterr().err
