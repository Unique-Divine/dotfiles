"""Serve the Windows recovery queue on native IPv4 loopback."""

import argparse
from contextlib import closing
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BufferedReader, RawIOBase
import json
import re
from secrets import token_hex
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
from threading import BoundedSemaphore
import time
from typing import cast

if sys.flags.isolated:
    bootstrap = argparse.ArgumentParser(add_help=False)
    bootstrap.add_argument("--worker-root", type=Path)
    worker_options, _ = bootstrap.parse_known_args()
    sys.path.insert(
        0, str(worker_options.worker_root or Path(__file__).resolve().parent)
    )

import maintenance_runtime
import worker

OPERATIONS = ("compact", *worker.RECOVERY_OPERATIONS)
JOB_PREFIX = "/v1/jobs/"

REQUEST_PREFIX = b"Cross Hub request v1\n"
RESPONSE_PREFIX = b"Cross Hub response v1\n"
SIGNATURE_HEADER = "X-Cross-Hub-Signature"
SIGNATURE_WINDOW_SECONDS = 90
AUTHORIZATION = re.compile(r"CrossHub ([0-9]{10})\.([0-9a-f]{32})\.([0-9a-f]{64})")


def request_signature(
    token: bytes, created: str, nonce: str, method: str, path: str, job_id: str
) -> str:
    fields = "\n".join((created, nonce, method, path, job_id)).encode("ascii")
    return hmac.digest(token, REQUEST_PREFIX + fields, "sha256").hex()


def signed_headers(
    token: bytes, method: str, path: str, job_id: str = ""
) -> dict[str, str]:
    created, nonce = str(int(time.time())), token_hex(16)
    signature = request_signature(token, created, nonce, method, path, job_id)
    headers = {"Authorization": f"CrossHub {created}.{nonce}.{signature}"}
    if job_id:
        headers["Idempotency-Key"] = job_id
    return headers


def response_signature(token: bytes, request_mac: str, status: int, body: bytes) -> str:
    fields = f"{request_mac}\n{status}\n".encode("ascii")
    return hmac.digest(token, RESPONSE_PREFIX + fields + body, "sha256").hex()


def read_token(path: Path) -> bytes:
    token = path.read_bytes().strip()
    if len(token) < 32 or not token.isascii() or any(char <= 32 for char in token):
        raise ValueError("Provide an ASCII credential of at least 32 characters without whitespace.")
    return token


class Recovery:
    def __init__(self, state: Path, host: maintenance_runtime.WindowsHost) -> None:
        self.state = state
        self.database = state / "jobs.sqlite3"
        self.host = host
        self.inbox = state / "requests"
        self.inventory_slot = BoundedSemaphore()
        self.replay_database = state / "adapter-replays.sqlite3"

    def status(self) -> dict[str, object]:
        heartbeat = worker.worker_status(self.database)
        distro, running = self.distro_status()
        return {
            "hostname": socket.gethostname(),
            "platform": sys.platform,
            "windows_free_bytes": shutil.disk_usage("C:\\").free,
            "worker_state": heartbeat["state"],
            "heartbeat_at": heartbeat.get("heartbeat_at"),
            "recovery_protocol": heartbeat.get("recovery_protocol"),
            "distro": distro,
            "distro_running": running,
        }

    def distro_status(self) -> tuple[str | None, bool | None]:
        try:
            distro = maintenance_runtime.read_target_manifest(self.host.install_root)["distro"]
        except (OSError, ValueError):
            return None, None
        if not self.inventory_slot.acquire(blocking=False):
            return distro, None
        try:
            running = {name.casefold() for name in self.host.running_distros()}
            return distro, distro.casefold() in running
        except (OSError, RuntimeError, subprocess.SubprocessError):
            return distro, None
        finally:
            self.inventory_slot.release()

    def consume_nonce(self, nonce: str, created: int) -> bool:
        # These receipts include authenticated attempts rejected before enqueue.
        # Keep them across adapter restarts for the full signature window.
        with closing(worker.open_database(self.replay_database)) as db, db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS nonces ("
                "nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)"
            )
            # A writer may have waited on SQLite past the initial MAC check.
            db.execute("BEGIN IMMEDIATE")
            now = time.time()
            if abs(now - created) > SIGNATURE_WINDOW_SECONDS:
                raise worker.MaintenanceConflict(
                    "This signed request expired. Sign a new request with the same job ID."
                )
            db.execute("DELETE FROM nonces WHERE expires_at < ?", (now,))
            row = db.execute(
                "INSERT OR IGNORE INTO nonces VALUES (?, ?)",
                (nonce, created + SIGNATURE_WINDOW_SECONDS),
            )
            return row.rowcount == 1

    def lookup(self, job_id: str) -> dict[str, object] | None:
        if job := worker.job_status(self.database, job_id):
            return job
        try:
            request = worker.read_request(self.inbox / f"{job_id}.json")
        except (FileNotFoundError, ValueError):
            # The claim can commit and remove the inbox entry after the first
            # read. Check SQLite again before returning a missing job.
            return worker.job_status(self.database, job_id)
        return {"job_id": job_id, "operation": request["operation"], "state": "queued"}

    def job(self, job_id: str) -> dict[str, object] | None:
        row = self.lookup(job_id)
        if row is None or row["operation"] not in OPERATIONS:
            return None
        return self.public_job(row)

    def public_job(self, job: dict[str, object]) -> dict[str, object]:
        snapshot = {key: job[key] for key in (
            "job_id", "operation", "state", "accepted_at", "finished_at"
        ) if key in job}
        if job["operation"] in worker.RECOVERY_OPERATIONS and job["state"] == "completed":
            snapshot["result"] = job["result"]
        if job["operation"] == "compact":
            if progress := self.compaction_progress(str(job["job_id"])):
                snapshot["progress"] = progress
            result = job.get("result")
            if isinstance(result, dict):
                snapshot["result"] = {key: result[key] for key in (
                    "compaction_ok", "detach_verified", "recovery_ok",
                    "vhdx_reduction_bytes", "c_free_delta_bytes",
                ) if isinstance(result.get(key), (bool, int))}
        return snapshot

    def compaction_progress(self, job_id: str) -> dict[str, object] | None:
        journal = self.state / "maintenance" / f"{job_id}.jsonl"
        try:
            with journal.open("rb") as file:
                end = file.seek(0, 2)
                file.seek(max(0, end - 8192))
                lines = file.read(8192).splitlines()
        except FileNotFoundError:
            return None
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and entry.get("job_id") == job_id and "stage" in entry:
                return {
                    key: entry[key] for key in ("stage", "phase", "percent", "at")
                    if key in entry
                }
        return None

    def submit(self, operation: worker.Operation, job_id: str) -> dict[str, object]:
        with worker.worker_lock(self.state / "compact-submit.lock"):
            if existing := self.lookup(job_id):
                if existing["operation"] != operation:
                    raise worker.MaintenanceConflict("Job ID is already in use.")
                return self.public_job(existing)
            heartbeat = worker.worker_status(self.database)
            if (
                heartbeat["state"] != "ready"
                or heartbeat.get("recovery_protocol") != worker.RECOVERY_PROTOCOL
            ):
                raise RuntimeError("The Windows recovery worker needs setup or an upgrade.")
            worker.require_maintenance_slot(self.state)
            worker.write_request(self.inbox, {"job_id": job_id, "operation": operation})
            return {"job_id": job_id, "operation": operation, "state": "queued"}


class HeaderReader(RawIOBase):
    def __init__(self, connection: socket.socket, seconds: float) -> None:
        super().__init__()
        self.connection = connection
        self.deadline = time.monotonic() + seconds
        self.complete = False
        self.trailing = b""

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("HTTP request headers expired")
        self.connection.settimeout(remaining)
        size = self.connection.recv_into(buffer)
        if not self.complete:
            if not size:
                raise ConnectionError("Socket closed before HTTP headers ended")
            received = self.trailing + bytes(memoryview(buffer)[:size])
            self.complete = b"\n\r\n" in received or b"\n\n" in received
            self.trailing = received[-3:]
        return size


class RecoveryServer(ThreadingHTTPServer):
    request_queue_size = 16

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler]):
        self.slots = BoundedSemaphore(16)
        super().__init__(address, handler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(
        self, request: socket.socket, client_address: tuple[str, int]
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def handler(recovery: Recovery, token: bytes) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        timeout = 5
        header_deadline = 5.0

        def setup(self) -> None:
            super().setup()
            self.rfile.close()
            self.header_reader = HeaderReader(self.connection, self.header_deadline)
            self.rfile = BufferedReader(self.header_reader)

        def handle(self) -> None:
            try:
                super().handle()
            except ConnectionError:
                # A client may close or abort while reading or sending headers.
                pass

        def parse_request(self) -> bool:
            parsed = super().parse_request()
            if (
                parsed and self.header_reader.complete
                and time.monotonic() < self.header_reader.deadline
            ):
                self.connection.settimeout(self.timeout)
                return True
            return False

        def reply(
            self, status: HTTPStatus, body: dict[str, object], request_mac: str | None = None,
        ) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            if request_mac:
                self.send_header(SIGNATURE_HEADER, response_signature(token, request_mac, status, payload))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

        def request_mac(self) -> tuple[str, str, int] | None:
            authorization = self.headers.get_all("Authorization", [])
            keys = self.headers.get_all("Idempotency-Key", [])
            if len(authorization) != 1 or len(keys) > 1 or not self.path.isascii():
                return None
            match = AUTHORIZATION.fullmatch(authorization[0])
            if not match:
                return None
            created, nonce, received = match.groups()
            if abs(time.time() - int(created)) > SIGNATURE_WINDOW_SECONDS:
                return None
            job_id = keys[0] if keys else ""
            if not job_id.isascii():
                return None
            expected = request_signature(token, created, nonce, self.command, self.path, job_id)
            if hmac.compare_digest(expected, received):
                return received, nonce, int(created)
            return None

        def read(self) -> tuple[HTTPStatus, dict[str, object]]:
            if self.path == "/healthz":
                return HTTPStatus.OK, {"hostname": socket.gethostname(), "platform": sys.platform}
            if self.path == "/v1/status":
                return HTTPStatus.OK, recovery.status()
            if self.path.startswith(JOB_PREFIX):
                job_id = worker.parse_job_id(self.path.removeprefix(JOB_PREFIX))
                if job := recovery.job(job_id):
                    return HTTPStatus.OK, job
            return HTTPStatus.NOT_FOUND, {"error": "unknown route or job"}

        def submit(self) -> tuple[HTTPStatus, dict[str, object]]:
            operation = self.path.removeprefix(JOB_PREFIX)
            if not self.path.startswith(JOB_PREFIX) or operation not in OPERATIONS:
                return HTTPStatus.NOT_FOUND, {"error": "unknown operation"}
            if (
                self.headers.get("Transfer-Encoding")
                or self.headers.get("Content-Length", "0") != "0"
            ):
                return HTTPStatus.BAD_REQUEST, {"error": "POST requests require an empty body"}
            job_id = worker.parse_job_id(self.headers.get("Idempotency-Key", ""))
            job = recovery.submit(cast(worker.Operation, operation), job_id)
            code = HTTPStatus.ACCEPTED if job["state"] in ("queued", "accepted") else HTTPStatus.OK
            return code, job

        def handle_request(self, *, submit: bool) -> None:
            credential = self.request_mac()
            if credential is None:
                self.reply(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            request_mac, nonce, created = credential
            try:
                if submit and not recovery.consume_nonce(nonce, created):
                    raise worker.MaintenanceConflict(
                        "This signed request was already used. Sign a new request with the same job ID."
                    )
                status, body = self.submit() if submit else self.read()
            except ValueError:
                status, body = HTTPStatus.BAD_REQUEST, {"error": "invalid request"}
            except (worker.MaintenanceConflict, worker.WorkerBusy) as error:
                status, body = HTTPStatus.CONFLICT, {"error": str(error)}
            except (OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
                status, body = HTTPStatus.SERVICE_UNAVAILABLE, {
                    "error": "Cross Hub is unavailable, check Windows diagnostics"
                }
            self.reply(status, body, request_mac)

        def do_GET(self) -> None:
            self.handle_request(submit=False)

        def do_POST(self) -> None:
            self.handle_request(submit=True)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-root", type=Path)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        token = read_token(args.token_file)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    recovery = Recovery(args.state_dir, maintenance_runtime.WindowsHost())
    with RecoveryServer(("127.0.0.1", args.port), handler(recovery, token)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
