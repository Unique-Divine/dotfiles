import json
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from status_core import (
    MAX_GUEST_REPORT_BYTES,
    MAX_SAMPLES,
    guest_report_path,
    latest_probe,
    read_history,
    run_probe,
    status,
    trim_history,
)
from worker import heartbeat, initialize, open_database, run_worker

NOW = datetime(2026, 11, 21, 14, 0, tzinfo=UTC)
GUEST_DISTRO = "Ubuntu-24.04"


def sample(when: datetime, free: int = 1024) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "observedAt": when.isoformat(),
        "cFreeBytes": free,
        "dockerDesktopRunning": False,
        "runningDistros": [],
        "distributions": [
            {
                "name": "Ubuntu-24.04",
                "version": 2,
                "vhdPath": r"C:\Users\user\Ubuntu\ext4.vhdx",
                "vhdExists": True,
                "vhdLengthBytes": 4096,
                "vhdSparse": False,
            }
        ],
        "errors": [],
    }


def test_collect_and_latest_track_two_samples(tmp_path: Path) -> None:
    first = sample(NOW - timedelta(minutes=5), free=1024)
    second = sample(NOW, free=2048)
    status(
        tmp_path,
        {"state": "offline"},
        refresh=True,
        read_inventory=lambda: first,
        now=NOW,
    )
    status(
        tmp_path,
        {"state": "ready"},
        refresh=True,
        read_inventory=lambda: second,
        now=NOW,
    )

    def should_not_collect() -> dict[str, object]:
        pytest.fail("latest should reuse the cached inventory")

    result = status(
        tmp_path,
        {"state": "stale"},
        refresh=False,
        read_inventory=should_not_collect,
        now=NOW,
    )
    assert result["observedAt"] == second["observedAt"]
    assert result["inventory"] == second
    assert result["previousInventory"] == first
    assert result["worker"] == {"state": "stale"}
    assert result["inventoryStale"] is False
    assert result["history"] == [
        {
            "observedAt": entry["observedAt"],
            "cFreeBytes": entry["cFreeBytes"],
            "distributions": [{"name": "Ubuntu-24.04", "vhdLengthBytes": 4096}],
        }
        for entry in [first, second]
    ]


def test_failed_collect_keeps_last_good_and_reports_error(tmp_path: Path) -> None:
    good = sample(NOW)
    status(tmp_path, {}, refresh=True, read_inventory=lambda: good, now=NOW)

    def failed() -> dict[str, object]:
        raise OSError("inventory timed out")

    result = status(tmp_path, {}, refresh=True, read_inventory=failed, now=NOW)
    assert result["inventory"] == good
    assert result["inventoryStale"] is True
    assert result["errors"] == [
        {"source": "inventory", "message": "inventory timed out"}
    ]
    assert read_history(tmp_path) == ([good], "inventory timed out")

    cached = status(tmp_path, {}, refresh=False, now=NOW)
    assert cached["inventoryStale"] is True
    assert cached["errors"] == result["errors"]

    latest = status(tmp_path, {}, refresh=False, now=NOW + timedelta(minutes=11))
    assert latest["inventory"] == good
    assert latest["inventoryStale"] is True


def guest_sample(when: datetime, distro: str = GUEST_DISTRO) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "distro": distro,
        "observedAt": when.isoformat(),
        "filesystem": {"totalBytes": 100, "usedBytes": 40, "availableBytes": 55},
        "trim": {"observedAt": when.isoformat(), "bytes": 20, "method": "fstrim"},
        "candidates": [
            {
                "kind": "trash",
                "path": "/home/user/.local/share/Trash",
                "allocatedBytes": 4,
                "note": "Check retention before emptying trash.",
            }
        ],
        "errors": [{"source": "du", "message": "inaccessible directory"}],
    }


@pytest.mark.parametrize(
    ("age", "state", "diagnostic"),
    [
        (timedelta(hours=24), "fresh", None),
        (timedelta(hours=25), "stale", "Guest measurement is more than 24 hours old."),
        (
            timedelta(seconds=-1),
            "stale",
            "Guest measurement is ahead of the Windows clock.",
        ),
    ],
)
def test_guest_report_for_stopped_distro(
    tmp_path: Path, age: timedelta, state: str, diagnostic: str | None
) -> None:
    report = guest_sample(NOW - age)
    path = guest_report_path(tmp_path, GUEST_DISTRO.lower())
    path.parent.mkdir()
    path.write_text(json.dumps(report), encoding="utf-8")
    result = status(
        tmp_path, {}, refresh=True, read_inventory=lambda: sample(NOW), now=NOW
    )
    expected = {
        "distro": GUEST_DISTRO,
        "state": state,
        "report": report,
        "diagnostic": diagnostic,
    }
    assert result["guestReports"] == [expected]


def test_missing_guest_report_keeps_windows_status(tmp_path: Path) -> None:
    result = status(
        tmp_path, {}, refresh=True, read_inventory=lambda: sample(NOW), now=NOW
    )
    assert result["inventory"] == sample(NOW)
    assert result["guestReports"] == [
        {
            "distro": GUEST_DISTRO,
            "state": "missing",
            "report": None,
            "diagnostic": "No report published from inside this distro.",
        }
    ]
    assert not (tmp_path / "guest-reports").exists()


@pytest.mark.parametrize(
    ("payload", "diagnostic"),
    [
        (b"{", "Expecting property name"),
        (b" " * (MAX_GUEST_REPORT_BYTES + 1), "exceeds 512 KiB"),
        (json.dumps(guest_sample(NOW, "Different")).encode(), "registration"),
        (
            json.dumps(guest_sample(NOW)).encode().replace(
                b'"availableBytes": 55', b'"availableBytes": 65'
            ),
            "exceed filesystem capacity",
        ),
        (
            json.dumps(guest_sample(NOW)).encode().replace(b"/Trash", b"/Trash\\udcff"),
            "path is not valid UTF-8 text",
        ),
    ],
)
def test_invalid_guest_report_keeps_windows_status(
    tmp_path: Path, payload: bytes, diagnostic: str
) -> None:
    path = guest_report_path(tmp_path, GUEST_DISTRO)
    path.parent.mkdir()
    path.write_bytes(payload)
    result = status(
        tmp_path, {}, refresh=True, read_inventory=lambda: sample(NOW), now=NOW
    )
    assert result["inventory"] == sample(NOW)
    guests = result["guestReports"]
    assert isinstance(guests, list) and len(guests) == 1
    assert guests[0]["distro"] == GUEST_DISTRO
    assert guests[0]["state"] == "invalid"
    assert guests[0]["report"] is None
    assert diagnostic in guests[0]["diagnostic"]


def test_guest_reports_skip_docker_distros(tmp_path: Path) -> None:
    inventory = sample(NOW)
    registrations = inventory["distributions"]
    assert isinstance(registrations, list)
    for name in ("docker-desktop", "Docker-Desktop-Data"):
        registrations.append({**registrations[0], "name": name})
    result = status(
        tmp_path, {}, refresh=True, read_inventory=lambda: inventory, now=NOW
    )
    assert result["inventory"] == inventory
    guests = result["guestReports"]
    assert isinstance(guests, list)
    assert [guest["distro"] for guest in guests] == [GUEST_DISTRO]


def test_trim_history_bounds_age_and_count() -> None:
    expired = sample(NOW - timedelta(days=2))
    sole = trim_history([expired], NOW)
    assert sole == [expired]

    recent = [sample(NOW - timedelta(minutes=4 * index)) for index in range(300)]
    retained = trim_history([expired, *recent], NOW)
    assert retained == list(reversed(recent[:MAX_SAMPLES]))


def test_offline_probe_creates_no_request(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="offline"):
        run_probe(tmp_path, timeout=0)
    assert not (tmp_path / "requests").exists()
    assert latest_probe(tmp_path) is None


def test_timed_out_probe_tracks_same_job_until_complete(tmp_path: Path) -> None:
    with closing(open_database(tmp_path / "jobs.sqlite3")) as db:
        initialize(db)
        heartbeat(db)

    with pytest.raises(RuntimeError, match="check status before retrying"):
        run_probe(tmp_path, timeout=0)
    queued = latest_probe(tmp_path)
    assert queued is not None
    assert queued["state"] == "queued"

    with pytest.raises(RuntimeError, match="still pending"):
        run_probe(tmp_path, timeout=0)
    requests = list((tmp_path / "requests").glob("*.json"))
    assert [request.stem for request in requests] == [queued["job_id"]]

    run_worker(tmp_path, once=True)
    completed = latest_probe(tmp_path)
    assert completed is not None
    assert completed["job_id"] == queued["job_id"]
    assert completed["state"] == "completed"
