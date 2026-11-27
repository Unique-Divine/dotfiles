"""Run the WSL Cross Hub's local probe and Windows-owned maintenance queue."""

import argparse
import errno
import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
from collections.abc import Callable, Generator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal, NotRequired, TypedDict, TypeVar, cast
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


Operation = Literal[
    "probe", "compact", "investigate", "cure", "start-ubuntu", "audit-storage"
]
RECOVERY_OPERATIONS = ("start-ubuntu", "audit-storage")
RECOVERY_PROTOCOL = 1
DoctorMode = Literal["investigate", "cure", "auto"]
DOCTOR_CHECKS = ("windows-ssh", "windows-herdr", "ubuntu-herdr")
DOCTOR_RUNNERS = ("codex", "claude")
EDITOR_CHECKS = ("windows-neovim", "ubuntu-neovim")
DOCTOR_OPERATIONS = ("investigate", "cure")
MAINTENANCE_PROTOCOL = 1
DOCTOR_PROTOCOL = 1
EDITOR_PROTOCOL = 2
AUTO_MIN_INTERVAL = 45
AUTO_MAX_INTERVAL = 180
RunResult = TypeVar("RunResult")


class Request(TypedDict):
    job_id: str
    operation: Operation
    check: NotRequired[str]
    runner: NotRequired[str]


class WorkerBusy(RuntimeError):
    pass


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
            message = (
                "a WSL Cross Hub worker is already running"
                if path.name == "worker.lock"
                else "Cross Hub is busy checking or submitting maintenance. Retry shortly."
            )
            raise WorkerBusy(message) from error
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
    if not isinstance(request, dict) or request.get("job_id") != job_id:
        raise ValueError("request must have a matching job_id and supported operation")
    operation = request.get("operation")
    if operation in ("probe", "compact", *RECOVERY_OPERATIONS) and set(request) == {
        "job_id", "operation"
    }:
        return cast(Request, request)
    if (
        operation not in DOCTOR_OPERATIONS
        or set(request) != {"job_id", "operation", "check", "runner"}
        or not doctor_target(operation, request["check"], request["runner"])
    ):
        raise ValueError("invalid Doctor operation, check, or runner")
    return cast(Request, request)


def doctor_target(mode: object, check: object, runner: object) -> bool:
    if check in EDITOR_CHECKS:
        return mode == "cure" and runner == "managed"
    return check in DOCTOR_CHECKS and runner in DOCTOR_RUNNERS


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
            operation TEXT NOT NULL DEFAULT 'probe',
            check_id TEXT,
            runner TEXT
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
        CREATE TABLE IF NOT EXISTS recovery_capabilities (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            heartbeat_at TEXT NOT NULL,
            protocol INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS doctor_capabilities (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            heartbeat_at TEXT NOT NULL,
            protocol INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS doctor_observations (
            check_id TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            failed_at REAL NOT NULL,
            dispatched INTEGER NOT NULL
        );
        """)
    with db:
        job_columns = {row["name"] for row in db.execute("PRAGMA table_info(jobs)")}
        if "operation" not in job_columns:
            db.execute(
                "ALTER TABLE jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'probe'"
            )
        if "check_id" not in job_columns:
            db.execute("ALTER TABLE jobs ADD COLUMN check_id TEXT")
        if "runner" not in job_columns:
            db.execute("ALTER TABLE jobs ADD COLUMN runner TEXT")
        interrupted = db.execute(
            "UPDATE jobs SET state = 'interrupted', finished_at = ? "
            "WHERE state = 'accepted' RETURNING job_id",
            (timestamp(),),
        ).fetchall()
    return [row["job_id"] for row in interrupted]


def has_doctor_protocol(db: sqlite3.Connection) -> bool:
    return (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'doctor_capabilities'"
        ).fetchone()
        is not None
    )


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
        db.execute(
            "INSERT OR REPLACE INTO recovery_capabilities VALUES (1, ?, ?, ?)",
            (os.getpid(), observed, RECOVERY_PROTOCOL),
        )
        db.execute(
            "INSERT OR REPLACE INTO doctor_capabilities VALUES (1, ?, ?, ?)",
            (os.getpid(), observed, EDITOR_PROTOCOL),
        )
    if sys.platform == "win32":
        database = db.execute("PRAGMA database_list").fetchone()[2]
        if database:
            write_heartbeat_receipt(Path(database).parent, observed)


def write_heartbeat_receipt(state_dir: Path, observed: str) -> None:
    # The native installer reads this receipt without loading SQLite as admin.
    staging = None
    try:
        with NamedTemporaryFile(dir=state_dir, delete=False, mode="w", encoding="utf-8") as file:
            staging = Path(file.name)
            json.dump({
                "pid": os.getpid(), "heartbeat_at": observed,
                "platform": "win32", "recovery_protocol": RECOVERY_PROTOCOL,
            }, file)
        staging.replace(state_dir / "worker-heartbeat.json")
    except OSError:
        # The SQLite heartbeat remains authoritative for normal work.
        pass
    finally:
        if staging is not None:
            try:
                staging.unlink(missing_ok=True)
            except OSError:
                pass


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
    if request["operation"] not in ("probe", *RECOVERY_OPERATIONS):
        try:
            if time.time() - path.stat().st_mtime >= ACK_TIMEOUT:
                operation = request["operation"]
                event = (
                    "compaction_request_expired"
                    if operation == "compact"
                    else "doctor_request_expired"
                )
                if operation == "compact":
                    expired_at = timestamp()
                    with db:
                        db.execute(
                            "INSERT OR IGNORE INTO jobs "
                            "(job_id, state, accepted_at, finished_at, operation, result) "
                            "VALUES (?, 'failed', ?, ?, ?, ?)",
                            (job_id, expired_at, expired_at, operation,
                             json.dumps({"error": "Compaction request expired before acknowledgment."})),
                        )
                log.warning("%s job_id=%s", event, job_id)
                path.unlink(missing_ok=True)
                return None
        except FileNotFoundError:
            return None
    with db:
        cursor = db.execute(
            "INSERT OR IGNORE INTO jobs "
            "(job_id, state, accepted_at, operation, check_id, runner) "
            "VALUES (?, 'accepted', ?, ?, ?, ?)",
            (
                job_id,
                timestamp(),
                request["operation"],
                request.get("check"),
                request.get("runner"),
            ),
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

    state, result = run_with_heartbeat(
        db, lambda: run_compaction(state_dir, job_id, host_factory)
    )
    finish_job(db, job_id, state, result)
    return state


def run_with_heartbeat(
    db: sqlite3.Connection, run: Callable[[], RunResult]
) -> RunResult:
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run)
        while not future.done():
            try:
                return future.result(timeout=HEARTBEAT_INTERVAL)
            except TimeoutError:
                if not future.done():
                    heartbeat(db)
        return future.result()


def process_doctor(
    db: sqlite3.Connection,
    state_dir: Path,
    request: Request,
    log: logging.Logger,
) -> str:
    job_id = request["job_id"]
    try:
        if pending := pending_hold(db):
            raise RuntimeError(hold_message(pending))
        if request.get("check") in EDITOR_CHECKS:
            from editor_runtime import execute_cure as execute
        else:
            from cure_runtime import execute_doctor as execute
        result = run_with_heartbeat(db, lambda: execute(state_dir, request))
        state = "failed" if result.get("outcome") == "failed" else "completed"
    except Exception as error:  # noqa: BLE001 - A runner crash cannot kill the worker.
        # Agent output can be part of an exception. Log its type only.
        log.error("doctor_failed job_id=%s error_type=%s", job_id, type(error).__name__)
        state = "failed"
        result = {
            "outcome": "failed",
            "error": "Doctor job could not finish. Check its journal.",
        }
        try:
            append_doctor_terminal(state_dir, job_id, state, error=result["error"])
        except OSError:
            result["error"] = "Doctor job could not finish or write its journal."
    finish_job(db, job_id, state, result)
    return state


def append_doctor_terminal(
    state_dir: Path, job_id: str, state: str, **details: object
) -> None:
    directory = state_dir / "maintenance"
    directory.mkdir(parents=True, exist_ok=True)
    event = {
        "at": timestamp(),
        "job_id": job_id,
        "stage": "job-finished",
        "state": state,
        **details,
    }
    path = directory / f"{job_id}.jsonl"
    if maintenance_runtime.has_link(directory) or path.is_symlink():
        raise OSError("Doctor journal cannot be linked")
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(event) + "\n")
        file.flush()
        os.fsync(file.fileno())


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
            interrupted = db.execute(
                "SELECT operation, check_id, runner FROM jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if interrupted["operation"] in DOCTOR_OPERATIONS:
                try:
                    append_doctor_terminal(
                        state_dir,
                        job_id,
                        "interrupted",
                        check=interrupted["check_id"],
                        runner=interrupted["runner"],
                    )
                except OSError:
                    log.warning("doctor_journal_unavailable job_id=%s", job_id)
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
                elif request["operation"] in DOCTOR_OPERATIONS:
                    state = process_doctor(db, state_dir, request, log)
                elif request["operation"] in RECOVERY_OPERATIONS:
                    state = process_recovery(db, state_dir, request, host_factory, log)
                else:
                    run_probe(db, job_id)
                    state = "completed"
                log.info("job_%s job_id=%s", state, job_id)
                break
            if once:
                return
            time.sleep(POLL_INTERVAL)


def process_recovery(
    db: sqlite3.Connection, state_dir: Path, request: Request,
    host_factory: Callable[[], maintenance_runtime.WindowsHost], log: logging.Logger,
) -> str:
    job_id = request["job_id"]
    if held := pending_hold(db):
        finish_job(db, job_id, "failed", {"error": hold_message(held)})
        return "failed"
    try:
        journal = maintenance_runtime.Journal(state_dir / "recovery", job_id)
        result = run_with_heartbeat(
            db, lambda: host_factory().run_recovery_operation(request["operation"], journal),
        )
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        log.warning(
            "recovery_operation_failed job_id=%s error_type=%s", job_id, type(error).__name__
        )
        finish_job(db, job_id, "failed", {"error": str(error)})
        return "failed"
    finish_job(db, job_id, "completed", result)
    return "completed"


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
        if check := result.pop("check_id", None):
            result["check"] = check
        if result.get("runner") is None:
            result.pop("runner", None)
        if row["result"] is not None:
            result["result"] = json.loads(row["result"])
        return result


def worker_status(db_path: Path) -> dict[str, object]:
    if db_path.exists():
        with closing(open_database(db_path, read_only=True)) as db:
            # Read the heartbeat and its capability records from one snapshot.
            db.execute("BEGIN")
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
                            doctor = None
                            if has_doctor_protocol(db):
                                doctor = db.execute(
                                    "SELECT protocol FROM doctor_capabilities "
                                    "WHERE id = 1 AND pid = ? AND heartbeat_at = ?",
                                    (row["pid"], row["heartbeat_at"]),
                                ).fetchone()
                            if doctor and doctor["protocol"] in (DOCTOR_PROTOCOL, EDITOR_PROTOCOL):
                                result["doctor_protocol"] = doctor["protocol"]
                                result["capabilities"].extend(DOCTOR_OPERATIONS)
                    if row["platform"] == "win32" and db.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                        "AND name = 'recovery_capabilities'"
                    ).fetchone():
                        recovery = db.execute(
                            "SELECT protocol FROM recovery_capabilities "
                            "WHERE id = 1 AND pid = ? AND heartbeat_at = ?",
                            (row["pid"], row["heartbeat_at"]),
                        ).fetchone()
                        if recovery:
                            result["recovery_protocol"] = recovery["protocol"]
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
        require_maintenance_slot(state_dir)
        return submit_request(state_dir, operation)


class MaintenanceConflict(RuntimeError):
    pass


def require_maintenance_slot(state_dir: Path) -> None:
    # Check the inbox first. The worker commits the row before unlinking
    # the request, so a concurrent claim remains visible in one place.
    for path in (state_dir / "requests").glob("*.json"):
        try:
            request = read_request(path)
        except (FileNotFoundError, ValueError):
            continue
        if request["operation"] != "probe":
            raise MaintenanceConflict(f"Maintenance job {request['job_id']} is queued.")
    with closing(open_database(state_dir / "jobs.sqlite3", read_only=True)) as db:
        if held := pending_hold(db):
            raise MaintenanceConflict(hold_message(held))
        if active := active_maintenance(db):
            raise MaintenanceConflict(f"Maintenance job {active['job_id']} is already running.")


def active_maintenance(db: sqlite3.Connection) -> sqlite3.Row | None:
    return db.execute(
        "SELECT job_id, operation FROM jobs WHERE operation IN "
        "('compact', 'investigate', 'cure', 'start-ubuntu', 'audit-storage') "
        "AND state = 'accepted' LIMIT 1"
    ).fetchone()


def doctor_compaction_blocked(state_dir: Path) -> bool:
    # Submission can crash after writing a request but before acknowledgement.
    # Claiming a request adds its database row before removing the file.
    if any((state_dir / "requests").glob("*.json")):
        return True
    db_path = state_dir / "jobs.sqlite3"
    if not db_path.exists():
        return False
    with closing(open_database(db_path, read_only=True)) as db:
        columns = db.execute("PRAGMA table_info(jobs)")
        if not any(row["name"] == "operation" for row in columns):
            return False
        return (
            pending_hold(db) is not None
            or db.execute(
                "SELECT 1 FROM jobs WHERE operation = 'compact' AND state = 'accepted'"
            ).fetchone()
            is not None
        )


def auto_observation(
    db: sqlite3.Connection,
    check: str,
    observation: dict[str, object],
    runner: str,
    now: float,
) -> str:
    row = db.execute(
        "SELECT count, failed_at, dispatched FROM doctor_observations WHERE check_id = ?",
        (check,),
    ).fetchone()
    state = observation.get("state")
    if state == "healthy" or (state != "failed" and row and not row["dispatched"]):
        db.execute("DELETE FROM doctor_observations WHERE check_id = ?", (check,))
    if state != "failed" or (row and row["dispatched"]):
        return "suppressed"

    elapsed = now - row["failed_at"] if row else None
    if elapsed is not None and 0 <= elapsed < AUTO_MIN_INTERVAL:
        return "observed"
    count = 1
    if (
        row
        and elapsed is not None
        and AUTO_MIN_INTERVAL <= elapsed <= AUTO_MAX_INTERVAL
    ):
        count = min(2, row["count"] + 1)
    runners = observation.get("runners")
    dispatch = (
        count >= 2
        and isinstance(runners, list)
        and runner in runners
        and not active_maintenance(db)
        and not pending_hold(db)
    )
    db.execute(
        "INSERT OR REPLACE INTO doctor_observations VALUES (?, ?, ?, ?)",
        (check, count, now, 0),
    )
    if dispatch:
        return "dispatch"
    return "observed" if count == 1 else "suppressed"


def submit_doctor(
    state_dir: Path, mode: DoctorMode, check: str, runner: str
) -> dict[str, object]:
    import cure_runtime

    if not doctor_target(mode, check, runner):
        raise ValueError("Invalid Doctor operation, check, or runner.")
    editor = check in EDITOR_CHECKS
    db_path = state_dir / "jobs.sqlite3"
    status = worker_status(db_path)
    if status["state"] != "ready" or status.get("doctor_protocol") not in (
        (EDITOR_PROTOCOL,) if editor else (DOCTOR_PROTOCOL, EDITOR_PROTOCOL)
    ):
        raise RuntimeError("An updated Windows worker is required for Doctor jobs.")

    with worker_lock(state_dir / "compact-submit.lock"):
        if mode == "auto":
            if doctor_compaction_blocked(state_dir):
                return {"state": "suppressed", "check": check}
            observation = cure_runtime.doctor_check(check, state_dir)
            with closing(open_database(db_path)) as db, db:
                decision = auto_observation(db, check, observation, runner, time.time())
            if decision != "dispatch":
                return {"state": decision, "check": check}
        require_maintenance_slot(state_dir)
        operation = "investigate" if mode == "auto" else mode
        result = submit_request(state_dir, operation, check=check, runner=runner)
        if mode == "auto":
            # Submission returns only after Windows records the job. A failed
            # publication must leave this incident eligible for another poll.
            with closing(open_database(db_path)) as db, db:
                db.execute(
                    "UPDATE doctor_observations SET dispatched = 1 WHERE check_id = ?",
                    (check,),
                )
        return result


def latest_doctor_job(state_dir: Path) -> dict[str, object] | None:
    database = state_dir / "jobs.sqlite3"
    if not database.exists():
        return None
    with closing(open_database(database, read_only=True)) as db:
        if not has_doctor_protocol(db):
            return None
        latest = db.execute(
            "SELECT job_id FROM jobs WHERE operation IN ('investigate', 'cure') "
            "ORDER BY accepted_at DESC, rowid DESC LIMIT 1"
        ).fetchone()
    return job_status(database, latest["job_id"]) if latest else None


def doctor_checks(state_dir: Path) -> dict[str, object]:
    import cure_runtime
    import editor_runtime

    state_dir.mkdir(parents=True, exist_ok=True)
    # Even a WSL status command can start a distro after shutdown. Keep live
    # observations out of the compaction window, including while submitting.
    checks = None
    editors = None
    try:
        with worker_lock(state_dir / "compact-submit.lock"):
            if not doctor_compaction_blocked(state_dir):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    editor_report = pool.submit(editor_runtime.editor_checks)
                    checks = cure_runtime.doctor_checks(state_dir)["checks"]
                    editors = editor_report.result()
    except WorkerBusy:
        pass
    if checks is None:
        checks = [
            {
                "id": check,
                "host": check.split("-", 1)[0],
                "state": "unavailable",
                "detail": "Doctor checks are paused while Cross Hub handles maintenance.",
                "runners": [],
            }
            for check in DOCTOR_CHECKS
        ]
    result: dict[str, object] = {
        "checks": checks,
        "editors": editors if editors is not None else [
            editor_runtime.unavailable(check, "Doctor checks are paused while Cross Hub handles maintenance.")
            for check in EDITOR_CHECKS
        ],
    }
    if latest := latest_doctor_job(state_dir):
        result["latestJob"] = latest
    return result


def submit_request(
    state_dir: Path,
    operation: Operation,
    *,
    check: str | None = None,
    runner: str | None = None,
) -> dict[str, object]:
    job_id = str(uuid4())
    request: Request = {"job_id": job_id, "operation": operation}
    if check is not None and runner is not None:
        request.update(check=check, runner=runner)
    write_request(state_dir / "requests", request)
    return await_acknowledgment(state_dir, job_id, operation)


def await_acknowledgment(state_dir: Path, job_id: str, operation: Operation) -> dict[str, object]:
    deadline = time.monotonic() + ACK_TIMEOUT
    while time.monotonic() < deadline:
        if result := job_status(state_dir / "jobs.sqlite3", job_id):
            return result
        time.sleep(0.05)
    if operation in DOCTOR_OPERATIONS:
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
    doctor = commands.add_parser("submit-doctor")
    doctor.add_argument("mode", choices=("investigate", "cure", "auto"))
    doctor.add_argument("check", choices=DOCTOR_CHECKS + EDITOR_CHECKS)
    doctor.add_argument("runner", choices=DOCTOR_RUNNERS + ("managed",))
    commands.add_parser("doctor-checks")
    commands.add_parser("editor-launch")
    commands.add_parser("editor-install")
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
            case "submit-doctor":
                result = submit_doctor(state_dir, args.mode, args.check, args.runner)
            case "doctor-checks":
                result = doctor_checks(state_dir)
            case "editor-launch":
                from editor_runtime import windows_launch

                result = windows_launch()
            case "editor-install":
                from editor_runtime import windows_install

                state_dir.mkdir(parents=True, exist_ok=True)
                with worker_lock(state_dir / "compact-submit.lock"):
                    db_path = state_dir / "jobs.sqlite3"
                    if db_path.exists():
                        with closing(open_database(db_path, read_only=True)) as db:
                            if active_maintenance(db) or pending_hold(db):
                                raise RuntimeError("Finish maintenance before installing Neovim.")
                    result = windows_install()
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
                            active = active_maintenance(db)
                            if active or pending_hold(db):
                                raise RuntimeError(
                                    "Finish or reconcile maintenance before upgrading Cross Hub."
                                )
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
