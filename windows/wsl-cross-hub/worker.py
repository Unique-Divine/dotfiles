"""Run the WSL Cross Hub's local probe and Windows-owned maintenance queue."""

import argparse
import errno
import json
import logging
import os
import sqlite3
import sys
import time
from collections.abc import Callable, Generator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal, TypedDict, cast
from uuid import UUID, uuid4

# The scheduled worker and Windows client use -I -S. Load the sibling
# runtime from this versioned, unprivileged installation.
if sys.flags.isolated:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import maintenance_runtime

ACK_TIMEOUT = 15.0
PROBE_DELAY = 2.0
POLL_INTERVAL = 0.25
HEARTBEAT_INTERVAL = 5.0
MAX_REQUEST_BYTES = 1024
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3


Operation = Literal["probe", "compact"]
MAINTENANCE_PROTOCOL = 1


class Request(TypedDict):
    job_id: str
    operation: Operation


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def default_state_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ValueError("LOCALAPPDATA is missing; pass --state-dir")
    return Path(local_app_data) / "WslCrossHub"


def parse_job_id(value: str) -> str:
    try:
        valid = str(UUID(value, version=4)) == value
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("expected a canonical lowercase UUIDv4")
    return value


@contextmanager
def worker_lock(path: Path) -> Generator[None]:
    # Both operating systems release this lock if the worker crashes.
    with path.open("a+b") as lock:
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            raise RuntimeError("a WSL Cross Hub worker is already running") from error
        yield


@contextmanager
def worker_log(directory: Path) -> Generator[logging.Logger]:
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        directory / "worker.log",
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    formatter = logging.Formatter(
        "%(asctime)sZ %(levelname)s pid=%(process)d %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    # Each locked worker owns its handler without changing process-wide logging.
    logger = logging.Logger("wsl-cross-hub-worker", logging.INFO)  # noqa: LOG001
    logger.addHandler(handler)
    try:
        logger.info("worker_started")
        yield logger
    except Exception as error:
        logger.error("worker_failed error_type=%s", type(error).__name__)
        raise
    finally:
        logger.removeHandler(handler)
        handler.close()


def write_request(inbox: Path, request: Request) -> None:
    inbox.mkdir(parents=True, exist_ok=True)
    target = inbox / f"{request['job_id']}.json"
    staging = None
    try:
        with NamedTemporaryFile(dir=inbox, delete=False) as file:
            staging = Path(file.name)
            file.write(json.dumps(request).encode("utf-8"))
            file.flush()
            os.fsync(file.fileno())
        staging.replace(target)
    finally:
        if staging is not None:
            staging.unlink(missing_ok=True)


def read_request(path: Path) -> Request:
    job_id = parse_job_id(path.stem)
    if path.is_symlink() or not path.is_file():
        raise ValueError("request must be a regular file")
    with path.open("rb") as file:
        encoded = file.read(MAX_REQUEST_BYTES + 1)
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds size limit")
    request: object = json.loads(encoded)
    if request not in (
        {"job_id": job_id, "operation": "probe"},
        {"job_id": job_id, "operation": "compact"},
    ):
        raise ValueError("request must have a matching job_id and supported operation")
    return cast(Request, request)


def open_database(path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        db = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    else:
        db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    return db


def initialize(db: sqlite3.Connection) -> list[str]:
    db.execute("PRAGMA synchronous = FULL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            accepted_at TEXT NOT NULL,
            finished_at TEXT,
            result TEXT,
            operation TEXT NOT NULL DEFAULT 'probe'
        );
        CREATE TABLE IF NOT EXISTS worker (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            executable TEXT NOT NULL,
            platform TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS worker_capabilities (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            heartbeat_at TEXT NOT NULL,
            maintenance_protocol INTEGER NOT NULL
        );
        """)
    with db:
        if not any(
            row["name"] == "operation" for row in db.execute("PRAGMA table_info(jobs)")
        ):
            db.execute(
                "ALTER TABLE jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'probe'"
            )
        interrupted = db.execute(
            "UPDATE jobs SET state = 'interrupted', finished_at = ? "
            "WHERE state = 'accepted' RETURNING job_id",
            (timestamp(),),
        ).fetchall()
    return [row["job_id"] for row in interrupted]


def heartbeat(db: sqlite3.Connection) -> None:
    observed = timestamp()
    with db:
        db.execute(
            "INSERT OR REPLACE INTO worker VALUES (1, ?, ?, ?, ?)",
            (os.getpid(), sys.executable, sys.platform, observed),
        )
        db.execute(
            "INSERT OR REPLACE INTO worker_capabilities VALUES (1, ?, ?, ?)",
            (os.getpid(), observed, MAINTENANCE_PROTOCOL),
        )


def claim_request(
    db: sqlite3.Connection, path: Path, log: logging.Logger
) -> Request | None:
    if path.is_dir() and not path.is_symlink():
        return None
    try:
        request = read_request(path)
    except FileNotFoundError:
        return None
    except (UnicodeError, ValueError) as error:
        log.warning("request_rejected error_type=%s", type(error).__name__)
        path.unlink(missing_ok=True)
        return None

    job_id = request["job_id"]
    if request["operation"] == "compact":
        try:
            if time.time() - path.stat().st_mtime >= ACK_TIMEOUT:
                log.warning("compaction_request_expired job_id=%s", job_id)
                path.unlink(missing_ok=True)
                return None
        except FileNotFoundError:
            return None
    with db:
        cursor = db.execute(
            "INSERT OR IGNORE INTO jobs (job_id, state, accepted_at, operation) "
            "VALUES (?, 'accepted', ?, ?)",
            (job_id, timestamp(), request["operation"]),
        )
    claimed = cursor.rowcount == 1
    if claimed:
        log.info("job_accepted job_id=%s", job_id)
    path.unlink(missing_ok=True)
    return request if claimed else None


def finish_job(
    db: sqlite3.Connection,
    job_id: str,
    state: str,
    result: object,
) -> None:
    with db:
        db.execute(
            "UPDATE jobs SET state = ?, finished_at = ?, result = ? WHERE job_id = ?",
            (state, timestamp(), json.dumps(result), job_id),
        )


def run_probe(db: sqlite3.Connection, job_id: str) -> None:
    # The delay leaves time for the acknowledging client to exit.
    time.sleep(PROBE_DELAY)
    result = {
        "message": "WSL Cross Hub probe completed",
        "pid": os.getpid(),
        "executable": sys.executable,
        "platform": sys.platform,
    }
    finish_job(db, job_id, "completed", result)


def run_compaction(
    state_dir: Path,
    job_id: str,
    host_factory: Callable[[], maintenance_runtime.WindowsHost],
) -> tuple[str, maintenance_runtime.RunSummary]:
    journal = maintenance_runtime.Journal(state_dir / "maintenance", job_id)
    journal("accepted-on-windows")
    result: maintenance_runtime.RunSummary
    try:
        host = host_factory()
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        journal("phase-failed", phase="preflight", error=str(error))
        state = "failed"
        result = {"error": str(error)}
    else:
        state, result = maintenance_runtime.execute_maintenance(host, journal)
    journal.allow_degraded = True
    journal("job-finished", state=state, **result)
    if journal.error:
        result["journal_error"] = journal.error
    return state, result


def pending_hold(db: sqlite3.Connection) -> str | None:
    row = db.execute(
        "SELECT job_id FROM jobs WHERE operation = 'compact' "
        "AND state IN ('attention', 'interrupted') ORDER BY accepted_at DESC LIMIT 1"
    ).fetchone()
    return row["job_id"] if row else None


def hold_message(job_id: str) -> str:
    return (
        f"Review compaction job {job_id} before trying another run. "
        "Windows could not establish the previous disk or recovery outcome."
    )


def acknowledge_hold(state_dir: Path, job_id: str) -> dict[str, object]:
    db_path = state_dir / "jobs.sqlite3"
    status = job_status(db_path, job_id)
    if (
        status is None
        or status["operation"] != "compact"
        or status["state"] not in {"attention", "interrupted"}
    ):
        raise ValueError("Only a held compaction job can be acknowledged.")
    host = maintenance_runtime.WindowsHost()
    target = host.installed_target()
    journal = state_dir / "maintenance" / f"{job_id}.jsonl"
    if journal.exists():
        for _, event in maintenance_runtime.read_elevated_rows(journal, 0):
            if event.get("stage") == "preflight-passed" and any(
                event.get(key) != target.get(key)
                for key in ("vhdx", "volume_serial", "file_id")
            ):
                raise ValueError(
                    "The held job names a different disk. Inspect it before continuing."
                )
    host.verify_released(target)
    with closing(open_database(db_path)) as db, db:
        result = status["result"]
        updated_result = {**result} if isinstance(result, dict) else {}
        updated_result["hold_acknowledged_at"] = timestamp()
        cursor = db.execute(
            "UPDATE jobs SET state = 'acknowledged', result = ? "
            "WHERE job_id = ? AND state IN ('attention', 'interrupted')",
            (json.dumps(updated_result), job_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("The held job changed while verifying disk release.")
    return {**status, "state": "acknowledged", "result": updated_result}


def process_compaction(
    db: sqlite3.Connection,
    state_dir: Path,
    job_id: str,
    host_factory: Callable[[], maintenance_runtime.WindowsHost],
) -> str:
    if pending := pending_hold(db):
        error = hold_message(pending)
        journal = maintenance_runtime.Journal(state_dir / "maintenance", job_id)
        journal("accepted-on-windows")
        journal("phase-failed", phase="preflight", error=error)
        journal("job-finished", state="failed", error=error)
        finish_job(db, job_id, "failed", {"error": error})
        return "failed"

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_compaction, state_dir, job_id, host_factory)
        while not future.done():
            try:
                future.result(timeout=HEARTBEAT_INTERVAL)
            except TimeoutError:
                if not future.done():
                    heartbeat(db)
        state, result = future.result()
    finish_job(db, job_id, state, result)
    return state


def run_worker(
    state_dir: Path,
    *,
    once: bool = False,
    host_factory: Callable[
        [], maintenance_runtime.WindowsHost
    ] = maintenance_runtime.WindowsHost,
) -> None:
    inbox = state_dir / "requests"
    inbox.mkdir(parents=True, exist_ok=True)
    with (
        worker_lock(state_dir / "worker.lock"),
        worker_log(state_dir / "logs") as log,
        closing(open_database(state_dir / "jobs.sqlite3")) as db,
    ):
        for job_id in initialize(db):
            log.warning("job_interrupted job_id=%s", job_id)
        next_heartbeat = 0.0
        while True:
            if time.monotonic() >= next_heartbeat:
                heartbeat(db)
                next_heartbeat = time.monotonic() + HEARTBEAT_INTERVAL
            for path in sorted(inbox.glob("*.json")):
                request = claim_request(db, path, log)
                if request is None:
                    continue
                job_id = request["job_id"]
                if request["operation"] == "compact":
                    state = process_compaction(db, state_dir, job_id, host_factory)
                else:
                    run_probe(db, job_id)
                    state = "completed"
                log.info("job_%s job_id=%s", state, job_id)
                break
            if once:
                return
            time.sleep(POLL_INTERVAL)


def job_status(db_path: Path, job_id: str) -> dict[str, object] | None:
    if not db_path.exists():
        return None
    with closing(open_database(db_path, read_only=True)) as db:
        # The worker can have created the database but not initialized it yet.
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'"
        ).fetchone():
            return None
        row = db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        result: dict[str, object] = dict(row)
        if row["result"] is not None:
            result["result"] = json.loads(row["result"])
        return result


def worker_status(db_path: Path) -> dict[str, object]:
    if db_path.exists():
        with closing(open_database(db_path, read_only=True)) as db:
            if db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker'"
            ).fetchone():
                row = db.execute("SELECT * FROM worker WHERE id = 1").fetchone()
                if row is not None:
                    heartbeat_at = datetime.fromisoformat(row["heartbeat_at"])
                    age = (datetime.now(UTC) - heartbeat_at).total_seconds()
                    result = {
                        "state": "ready" if 0 <= age < 15 else "stale",
                        **dict(row),
                    }
                    if db.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_capabilities'"
                    ).fetchone():
                        feature = db.execute(
                            "SELECT maintenance_protocol FROM worker_capabilities "
                            "WHERE id = 1 AND pid = ? AND heartbeat_at = ?",
                            (row["pid"], row["heartbeat_at"]),
                        ).fetchone()
                        if feature and row["platform"] == "win32":
                            result["maintenance_protocol"] = feature[
                                "maintenance_protocol"
                            ]
                            result["capabilities"] = ["probe", "compact"]
                    return result
    return {"state": "offline"}


def submit(state_dir: Path, operation: Operation) -> dict[str, object]:
    if operation == "probe":
        return submit_request(state_dir, operation)
    db_path = state_dir / "jobs.sqlite3"
    worker = worker_status(db_path)
    if (
        worker["state"] != "ready"
        or worker.get("maintenance_protocol") != MAINTENANCE_PROTOCOL
    ):
        raise RuntimeError(
            "An updated, running Windows worker is required. Check wsl-cross-hub doctor."
        )
    with worker_lock(state_dir / "compact-submit.lock"):
        with closing(open_database(db_path, read_only=True)) as db:
            if held := pending_hold(db):
                raise RuntimeError(hold_message(held))
            active = db.execute(
                "SELECT job_id FROM jobs WHERE operation = 'compact' AND state = 'accepted' LIMIT 1"
            ).fetchone()
        if active:
            raise RuntimeError(f"Compaction job {active['job_id']} is already running.")
        return submit_request(state_dir, operation)


def submit_request(state_dir: Path, operation: Operation) -> dict[str, object]:
    job_id = str(uuid4())
    write_request(state_dir / "requests", {"job_id": job_id, "operation": operation})
    deadline = time.monotonic() + ACK_TIMEOUT
    while time.monotonic() < deadline:
        if result := job_status(state_dir / "jobs.sqlite3", job_id):
            return result
        time.sleep(0.05)
    if operation == "compact":
        (state_dir / "requests" / f"{job_id}.json").unlink(missing_ok=True)
        if result := job_status(state_dir / "jobs.sqlite3", job_id):
            return result
    raise RuntimeError(
        f"worker did not acknowledge job {job_id} within {ACK_TIMEOUT:g}s; "
        "check status before retrying"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("worker")
    commands.add_parser("probe")
    commands.add_parser("submit-compact")
    commands.add_parser("require-idle")
    commands.add_parser("maintenance-health")
    acknowledge = commands.add_parser("acknowledge-hold")
    acknowledge.add_argument("job_id")
    status = commands.add_parser("status")
    status.add_argument("job_id", nargs="?")
    args = parser.parse_args(argv)

    try:
        state_dir = (args.state_dir or default_state_dir()).resolve()
        match args.command:
            case "worker":
                run_worker(state_dir)
                return 0
            case "probe":
                result = submit(state_dir, "probe")
            case "submit-compact":
                result = submit(state_dir, "compact")
            case "require-idle":
                # The setup caller holds the submit lock. The worker writes its
                # accepted row before removing the request, so check the inbox first.
                if any((state_dir / "requests").glob("*.json")):
                    raise RuntimeError("Wait for queued Cross Hub requests before upgrading.")
                db_path = state_dir / "jobs.sqlite3"
                if db_path.exists():
                    with closing(open_database(db_path, read_only=True)) as db:
                        columns = db.execute("PRAGMA table_info(jobs)").fetchall()
                        if any(row["name"] == "operation" for row in columns):
                            active = db.execute(
                                "SELECT job_id FROM jobs WHERE operation = 'compact' "
                                "AND state = 'accepted' LIMIT 1"
                            ).fetchone()
                            if active or pending_hold(db):
                                raise RuntimeError("Finish or reconcile compaction before upgrading Cross Hub.")
                result = {"state": "idle"}
            case "maintenance-health":
                result = maintenance_runtime.maintenance_health()
                if result["state"] == "ready":
                    db_path = state_dir / "jobs.sqlite3"
                    if db_path.exists():
                        with closing(open_database(db_path, read_only=True)) as db:
                            columns = db.execute("PRAGMA table_info(jobs)").fetchall()
                            if any(row["name"] == "operation" for row in columns) and (
                                held := pending_hold(db)
                            ):
                                result = {
                                    **result,
                                    "state": "blocked",
                                    "message": hold_message(held),
                                    "job_id": held,
                                }
            case "acknowledge-hold":
                result = acknowledge_hold(state_dir, parse_job_id(args.job_id))
            case "status":
                db_path = state_dir / "jobs.sqlite3"
                if args.job_id is None:
                    result = worker_status(db_path)
                else:
                    job_id = parse_job_id(args.job_id)
                    result = job_status(db_path, job_id)
                    if result is None:
                        raise ValueError(f"job {job_id} was not found")
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(f"WSL Cross Hub: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
