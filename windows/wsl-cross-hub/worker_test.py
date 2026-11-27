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
    request: worker.ProbeRequest = {"job_id": job_id, "operation": "probe"}
    worker.write_request(inbox, request)

    log_dir = tmp_path / "logs"
    with (
        worker.worker_log(log_dir) as log,
        closing(worker.open_database(db_path)) as db,
    ):
        worker.initialize(db)
        assert worker.claim_probe(db, path, log) == job_id
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
