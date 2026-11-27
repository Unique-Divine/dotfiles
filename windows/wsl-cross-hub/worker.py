"""Run the WSL Cross Hub's local, unprivileged probe."""

import argparse
import errno
import json
import logging
import os
import sqlite3
import sys
import time
from collections.abc import Generator, Sequence
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal, TypedDict, cast
from uuid import UUID, uuid4

ACK_TIMEOUT = 15.0
PROBE_DELAY = 2.0
POLL_INTERVAL = 0.25
HEARTBEAT_INTERVAL = 5.0
MAX_REQUEST_BYTES = 1024
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3


class ProbeRequest(TypedDict):
    job_id: str
    operation: Literal["probe"]


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


def write_request(inbox: Path, request: ProbeRequest) -> None:
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


def read_request(path: Path) -> ProbeRequest:
    job_id = parse_job_id(path.stem)
    if path.is_symlink() or not path.is_file():
        raise ValueError("request must be a regular file")
    with path.open("rb") as file:
        encoded = file.read(MAX_REQUEST_BYTES + 1)
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds size limit")
    request: object = json.loads(encoded)
    if request != {"job_id": job_id, "operation": "probe"}:
        raise ValueError("request must have a matching job_id and operation probe")
    return cast(ProbeRequest, request)


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
            result TEXT
        );
        CREATE TABLE IF NOT EXISTS worker (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            executable TEXT NOT NULL,
            platform TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL
        );
        """)
    with db:
        interrupted = db.execute(
            "UPDATE jobs SET state = 'interrupted', finished_at = ? "
            "WHERE state = 'accepted' RETURNING job_id",
            (timestamp(),),
        ).fetchall()
    return [row["job_id"] for row in interrupted]


def heartbeat(db: sqlite3.Connection) -> None:
    with db:
        db.execute(
            "INSERT OR REPLACE INTO worker VALUES (1, ?, ?, ?, ?)",
            (os.getpid(), sys.executable, sys.platform, timestamp()),
        )


def claim_probe(db: sqlite3.Connection, path: Path, log: logging.Logger) -> str | None:
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
    with db:
        cursor = db.execute(
            "INSERT OR IGNORE INTO jobs (job_id, state, accepted_at) "
            "VALUES (?, 'accepted', ?)",
            (job_id, timestamp()),
        )
    claimed = cursor.rowcount == 1
    if claimed:
        log.info("job_accepted job_id=%s", job_id)
    path.unlink(missing_ok=True)
    return job_id if claimed else None


def run_probe(db: sqlite3.Connection, job_id: str) -> None:
    # The delay leaves time for the acknowledging client to exit.
    time.sleep(PROBE_DELAY)
    result = {
        "message": "WSL Cross Hub probe completed",
        "pid": os.getpid(),
        "executable": sys.executable,
        "platform": sys.platform,
    }
    with db:
        db.execute(
            "UPDATE jobs SET state = 'completed', finished_at = ?, result = ? "
            "WHERE job_id = ?",
            (timestamp(), json.dumps(result), job_id),
        )


def run_worker(state_dir: Path, *, once: bool = False) -> None:
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
                job_id = claim_probe(db, path, log)
                if job_id is not None:
                    run_probe(db, job_id)
                    log.info("job_completed job_id=%s", job_id)
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
                    return {
                        "state": "ready" if 0 <= age < 15 else "stale",
                        **dict(row),
                    }
    return {"state": "offline"}


def submit_probe(state_dir: Path) -> dict[str, object]:
    job_id = str(uuid4())
    write_request(state_dir / "requests", {"job_id": job_id, "operation": "probe"})
    deadline = time.monotonic() + ACK_TIMEOUT
    while time.monotonic() < deadline:
        if result := job_status(state_dir / "jobs.sqlite3", job_id):
            return result
        time.sleep(0.05)
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
                result = submit_probe(state_dir)
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
