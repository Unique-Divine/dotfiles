"""Collect and inspect the Windows desktop status without changing WSL."""

import argparse
import json
import os
import sqlite3
import stat
import subprocess
import sys
import time
from collections.abc import Callable, Generator, Sequence
from contextlib import ExitStack, closing, contextmanager
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import uuid4

from maintenance_plan import expect_mapping, parse_snapshot, plan_maintenance
from worker import (
    ACK_TIMEOUT,
    default_state_dir,
    job_status,
    open_database,
    parse_job_id,
    timestamp,
    worker_lock,
    worker_status,
    write_request,
)

Json = dict[str, object]
InventoryReader = Callable[[], Json]
WINDOW = timedelta(hours=24)
STALE_AGE = timedelta(minutes=10)
MAX_SAMPLES = 288
MAX_GUEST_REPORT_BYTES = 512 * 1024
MAX_GUEST_REPORT_ENTRIES = 128
GUEST_REPORT_AGE = timedelta(hours=24)
DOCKER_DISTROS = {"docker-desktop", "docker-desktop-data"}
STATUS_FAILURES = (OSError, RuntimeError, ValueError, TypeError, sqlite3.Error)
INVENTORY_FIELDS = (
    "cFreeBytes",
    "dockerDesktopRunning",
    "runningDistros",
    "distributions",
)


def observed(value: object) -> datetime:
    if not isinstance(value, str):
        raise TypeError("inventory observation time is missing")
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("inventory observation time has no timezone")
    return result


def inventory_sample(value: object) -> Json:
    fields = expect_mapping(value, "inventory")
    parse_snapshot(fields)
    observed(fields.get("observedAt"))
    if not isinstance(fields.get("errors"), list):
        raise TypeError("inventory errors must be a list")
    return fields


def collect_inventory() -> Json:
    root = Path(os.environ["SystemRoot"])
    powershell = root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    script = Path(__file__).with_name("inventory.ps1")
    result = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
        ],
        check=False,
        capture_output=True,
        encoding="utf-8-sig",
        errors="replace",
        timeout=20,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError(
            result.stderr.strip() or f"inventory exited with code {result.returncode}"
        )
    return inventory_sample(json.loads(result.stdout))


@contextmanager
def status_lock(state_dir: Path) -> Generator[None]:
    state_dir.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 3
    with ExitStack() as stack:
        while True:
            try:
                stack.enter_context(worker_lock(state_dir / "status.lock"))
                break
            except RuntimeError as error:
                if time.monotonic() >= deadline:
                    raise RuntimeError("desktop status is busy") from error
                time.sleep(0.025)
        yield


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_json(path: Path, value: object) -> None:
    staging = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as file:
            staging = Path(file.name)
            json.dump(value, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        staging.replace(path)
    finally:
        if staging is not None:
            staging.unlink(missing_ok=True)


def read_history(state_dir: Path) -> tuple[list[Json], str | None]:
    value = read_json(state_dir / "status-history.json")
    if value is None:
        return [], None
    fields = expect_mapping(value, "desktop inventory history")
    samples = fields.get("samples")
    error = fields.get("inventoryError")
    if not isinstance(samples, list) or len(samples) > MAX_SAMPLES:
        raise ValueError("desktop inventory history is invalid")
    if error is not None and not isinstance(error, str):
        raise TypeError("desktop inventory error must be a string")
    return [inventory_sample(item) for item in samples], error


def trim_history(samples: list[Json], now: datetime) -> list[Json]:
    # Retain one last reading even after a long outage so it can be shown as stale.
    if not samples:
        return []
    by_time = {observed(item["observedAt"]): item for item in samples}
    ordered = sorted(by_time)
    retained = [date for date in ordered if date >= now - WINDOW] or ordered[-1:]
    return [by_time[date] for date in retained[-MAX_SAMPLES:]]


def display_history(samples: list[Json]) -> list[Json]:
    points = []
    for sample in samples:
        distros = sample["distributions"]
        points.append(
            {
                "observedAt": sample["observedAt"],
                "cFreeBytes": sample["cFreeBytes"],
                "distributions": [
                    {"name": item["name"], "vhdLengthBytes": item["vhdLengthBytes"]}
                    for item in distros
                ]
                if isinstance(distros, list)
                else None,
            }
        )
    return points


def guest_report_path(state_dir: Path, distro: str) -> Path:
    name = sha256(distro.casefold().encode("utf-8")).hexdigest()
    return state_dir / "guest-reports" / f"{name}.json"


def guest_bytes(fields: Json, name: str) -> int:
    value = fields.get(name)
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        raise ValueError(f"{name} must be a nonnegative byte count")
    return value


def guest_entries(value: object, label: str) -> list[Json]:
    if not isinstance(value, list) or len(value) > MAX_GUEST_REPORT_ENTRIES:
        raise ValueError(
            f"{label} must be a list of at most {MAX_GUEST_REPORT_ENTRIES} entries"
        )
    return [expect_mapping(item, label) for item in value]


def guest_text(fields: Json, name: str) -> str:
    value = fields.get(name)
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{name} is not valid UTF-8 text") from error
    return value


def guest_time(value: object) -> datetime:
    result = observed(value)
    if result.utcoffset() != timedelta(0):
        raise ValueError("guest timestamps must be in UTC")
    return result


def parse_guest_report(raw: bytes, distro: str) -> Json:
    fields = expect_mapping(json.loads(raw.decode("utf-8")), "guest report")
    if type(fields.get("schemaVersion")) is not int or fields["schemaVersion"] != 1:
        raise ValueError("expected guest report schemaVersion 1")
    if guest_text(fields, "distro").casefold() != distro.casefold():
        raise ValueError("guest report distro does not match its registration")

    filesystem = expect_mapping(fields.get("filesystem"), "guest filesystem")
    usage = {
        key: guest_bytes(filesystem, key)
        for key in ("totalBytes", "usedBytes", "availableBytes")
    }
    if usage["usedBytes"] + usage["availableBytes"] > usage["totalBytes"]:
        raise ValueError("guest used and available bytes exceed filesystem capacity")
    if "trim" not in fields:
        raise ValueError("guest report must include TRIM evidence or null")
    trim = fields["trim"]
    if trim is not None:
        trim_fields = expect_mapping(trim, "guest TRIM evidence")
        trim = {
            "observedAt": guest_time(trim_fields.get("observedAt")).isoformat(),
            "bytes": guest_bytes(trim_fields, "bytes"),
            "method": guest_text(trim_fields, "method"),
        }
    return {
        "schemaVersion": 1,
        "distro": distro,
        "observedAt": guest_time(fields.get("observedAt")).isoformat(),
        "filesystem": usage,
        "trim": trim,
        "candidates": [
            {
                "kind": guest_text(item, "kind"),
                "path": guest_text(item, "path"),
                "allocatedBytes": guest_bytes(item, "allocatedBytes"),
                "note": guest_text(item, "note"),
            }
            for item in guest_entries(fields.get("candidates"), "guest candidates")
        ],
        "errors": [
            {key: guest_text(item, key) for key in ("source", "message")}
            for item in guest_entries(fields.get("errors"), "guest errors")
        ],
    }


def guest_report_status(state_dir: Path, distro: str, now: datetime) -> Json:
    path = guest_report_path(state_dir, distro)
    result: Json = {"distro": distro, "report": None, "diagnostic": None}
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError("guest report must be a regular file")
        with path.open("rb") as file:
            raw = file.read(MAX_GUEST_REPORT_BYTES + 1)
        if len(raw) > MAX_GUEST_REPORT_BYTES:
            raise ValueError("guest report exceeds 512 KiB")
        report = parse_guest_report(raw, distro)
    except FileNotFoundError:
        return {
            **result,
            "state": "missing",
            "diagnostic": "No report published from inside this distro.",
        }
    except (OSError, ValueError, TypeError, RecursionError) as error:
        return {**result, "state": "invalid", "diagnostic": str(error)}

    age = now - guest_time(report["observedAt"])
    diagnostic = None
    if age < timedelta(0):
        diagnostic = "Guest measurement is ahead of the Windows clock."
    elif age > GUEST_REPORT_AGE:
        diagnostic = "Guest measurement is more than 24 hours old."
    return {
        **result,
        "state": "fresh" if diagnostic is None else "stale",
        "report": report,
        "diagnostic": diagnostic,
    }


def tracked_probe(state_dir: Path) -> Json | None:
    value = read_json(state_dir / "probe-state.json")
    if value is None:
        return None
    return expect_mapping(value, "probe state")


def probe_result(state_dir: Path, job_id: str, tracked: Json | None = None) -> Json:
    job_id = parse_job_id(job_id)
    inbox = state_dir / "requests"
    queued = (inbox / f"{job_id}.json").is_file()
    result = job_status(state_dir / "jobs.sqlite3", job_id)
    if result is not None:
        return result
    if tracked is not None and tracked.get("job_id") == job_id:
        # Worker commits its acknowledgment before removing the request file.
        return {**tracked, "state": "queued" if queued else "unavailable"}
    raise ValueError(f"job {job_id} was not found")


def latest_probe(state_dir: Path) -> Json | None:
    with status_lock(state_dir):
        tracked = tracked_probe(state_dir)
        if tracked is None:
            return None
        job_id = tracked.get("job_id")
        if not isinstance(job_id, str):
            raise TypeError("tracked probe has no job ID")
        return probe_result(state_dir, job_id, tracked)


def latest_maintenance(state_dir: Path) -> Json | None:
    database = state_dir / "jobs.sqlite3"
    if not database.is_file():
        return None
    with closing(open_database(database, read_only=True)) as db:
        columns = db.execute("PRAGMA table_info(jobs)").fetchall()
        if not any(column["name"] == "operation" for column in columns):
            return None
        row = db.execute(
            "SELECT job_id FROM jobs WHERE operation = 'compact' "
            "ORDER BY accepted_at DESC, job_id DESC LIMIT 1"
        ).fetchone()
    if row is None:
        return None
    return maintenance_detail(state_dir, row["job_id"])


def maintenance_detail(state_dir: Path, job_id: str) -> Json | None:
    job_id = parse_job_id(job_id)
    job = job_status(state_dir / "jobs.sqlite3", job_id)
    if job is not None and job.get("operation") != "compact":
        return job
    if job is None:
        return None

    journal = state_dir / "maintenance" / f"{job_id}.jsonl"
    milestones = {}
    milestone_stages = {
        "accepted-on-windows",
        "windows-services-started",
        "windows-tailscale-warning",
        "windows-access-ready",
        "docker-stop-started",
        "docker-stopped",
        "preflight-passed",
        "trim-started",
        "trim-completed",
        "shutdown-requested",
        "shutdown-observed",
        "compaction-started",
        "detach-observed",
        "windows-result",
        "restart-requested",
        "ubuntu-started",
        "recovery-waiting",
        "recovery-ready",
        "phase-failed",
        "recovery-failed",
        "recovery-deferred",
        "job-finished",
    }
    page_size = 65536
    try:
        with journal.open("rb") as handle:
            end = handle.seek(0, os.SEEK_END)
            handle.seek(0)
            if end <= 2 * page_size:
                lines = handle.read(2 * page_size).split(b"\n")[:-1]
            else:
                lines = handle.read(page_size).split(b"\n")[:-1]
                handle.seek(end - page_size)
                lines.extend(handle.read(page_size).split(b"\n")[1:-1])
    except FileNotFoundError:
        return job
    for line in lines:
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict) or event.get("job_id") != job_id:
            continue
        stage = event.get("stage")
        if isinstance(event.get("at"), str):
            job["last_event_at"] = event["at"]
        if isinstance(stage, str) and stage != "compaction-heartbeat":
            job["stage"] = stage
            if stage in milestone_stages and isinstance(event.get("at"), str):
                note = next(
                    (
                        event[key]
                        for key in ("error", "message", "output")
                        if isinstance(event.get(key), str) and event[key]
                    ),
                    None,
                )
                milestones[stage] = {
                    "stage": stage,
                    "at": event["at"],
                    "note": note[:500] if note else None,
                    "verified": event.get("verified") is True,
                }
        percent = event.get("percent")
        if type(percent) is int and 0 <= percent <= 100:
            job["percent"] = percent
    job["milestones"] = sorted(milestones.values(), key=lambda event: str(event["at"]))
    return job


def run_probe(state_dir: Path, *, timeout: float = ACK_TIMEOUT) -> Json:
    with status_lock(state_dir):
        if worker_status(state_dir / "jobs.sqlite3")["state"] != "ready":
            raise RuntimeError("worker is offline or its heartbeat is stale")
        tracked = tracked_probe(state_dir)
        if tracked is not None and isinstance(
            previous_id := tracked.get("job_id"), str
        ):
            previous = probe_result(state_dir, previous_id, tracked)
            if previous["state"] in {"queued", "accepted"}:
                raise RuntimeError(f"probe {previous_id} is still pending")
        job_id = str(uuid4())
        write_json(
            state_dir / "probe-state.json",
            {
                "job_id": job_id,
                "state": "queued",
                "submitted_at": timestamp(),
                "accepted_at": None,
                "finished_at": None,
                "result": None,
            },
        )
        write_request(state_dir / "requests", {"job_id": job_id, "operation": "probe"})

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = job_status(state_dir / "jobs.sqlite3", job_id)
        if result is not None:
            return result
        time.sleep(0.05)
    raise RuntimeError(
        f"worker did not acknowledge job {job_id} within {timeout:g}s; "
        "check status before retrying"
    )


def status(
    state_dir: Path,
    worker: Json,
    *,
    refresh: bool,
    read_inventory: InventoryReader = collect_inventory,
    now: datetime | None = None,
) -> Json:
    fixed_now = now
    now = now or datetime.now(UTC)
    errors = []
    try:
        with status_lock(state_dir):
            samples, inventory_error = read_history(state_dir)
    except STATUS_FAILURES as error:
        samples, inventory_error = [], None
        errors.append({"source": "history", "message": str(error)})
    if refresh or not samples:
        sample = None
        try:
            sample = read_inventory()
        except (*STATUS_FAILURES, subprocess.SubprocessError) as error:
            inventory_error = str(error)
        else:
            inventory_error = None
        try:
            with status_lock(state_dir):
                # Merge observations collected concurrently by another client.
                try:
                    samples, _ = read_history(state_dir)
                except STATUS_FAILURES:
                    pass
                if sample is not None:
                    samples = trim_history([*samples, sample], now)
                write_json(
                    state_dir / "status-history.json",
                    {"samples": samples, "inventoryError": inventory_error},
                )
        except STATUS_FAILURES as error:
            if sample is not None:
                samples = [*samples, sample]
            errors.append({"source": "history", "message": str(error)})
    if inventory_error is not None:
        errors.append({"source": "inventory", "message": inventory_error})
    samples = trim_history(samples, now)
    blank = dict.fromkeys(INVENTORY_FIELDS)
    inventory = samples[-1] if samples else {**blank, "errors": []}
    try:
        probe = latest_probe(state_dir)
    except STATUS_FAILURES as error:
        probe = None
        errors.append({"source": "probe", "message": str(error)})
    if worker.get("error"):
        errors.append({"source": "worker", "message": str(worker["error"])})
    registrations = parse_snapshot(inventory).distributions if samples else None
    guest_now = fixed_now or datetime.now(UTC)
    return {
        "schemaVersion": 1,
        "observedAt": inventory.get("observedAt"),
        "inventory": inventory,
        "inventoryStale": inventory_error is not None
        or not samples
        or now - observed(inventory["observedAt"]) > STALE_AGE,
        "worker": worker,
        "previousInventory": samples[-2] if len(samples) > 1 else None,
        "latestProbe": probe,
        "history": display_history(samples),
        "guestReports": [
            guest_report_status(state_dir, distro.name, guest_now)
            for distro in registrations or ()
            if distro.name.casefold() not in DOCKER_DISTROS
        ],
        "errors": errors,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation",
        choices=["collect", "latest", "preview", "probe", "job", "maintenance", "job-detail", "latest-doctor"],
    )
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--distro")
    parser.add_argument("--job-id")
    args = parser.parse_args(argv)
    state_dir = (args.state_dir or default_state_dir()).resolve()

    try:
        match args.operation:
            case "collect" | "latest":
                worker = expect_mapping(json.load(sys.stdin), "worker")
                result = status(state_dir, worker, refresh=args.operation == "collect")
            case "preview":
                result = plan_maintenance(
                    parse_snapshot(collect_inventory()), args.distro
                )
            case "probe":
                result = run_probe(state_dir)
            case "maintenance":
                result = {"job": latest_maintenance(state_dir)}
            case "job-detail":
                result = maintenance_detail(state_dir, args.job_id)
                if result is None:
                    raise ValueError(f"Job {args.job_id} was not found.")
            case "latest-doctor":
                from worker import latest_doctor_job

                result = {"job": latest_doctor_job(state_dir)}
            case "job":
                with status_lock(state_dir):
                    result = probe_result(
                        state_dir, args.job_id, tracked_probe(state_dir)
                    )
        print(json.dumps(result))
        return 0
    except (*STATUS_FAILURES, subprocess.SubprocessError) as error:
        print(f"WSL Cross Hub status: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
