from contextlib import closing
from http.client import HTTPConnection
import json
from threading import Event, Thread
from uuid import uuid4

import pytest

import tailnet_api
import worker

TOKEN = b"test-recovery-token"
def auth(path):
    return tailnet_api.signed_headers(TOKEN, "GET", path)


@pytest.fixture
def recovery(tmp_path, monkeypatch):
    class Host:
        install_root = tmp_path

        def installed_target(self):
            pytest.fail("Status must avoid the compaction preflight")

        def running_distros(self):
            return ["Ubuntu-22.04"]

    (tmp_path / "target.json").write_text(json.dumps({
        "owner_sid": "S-1-5-21-42",
        "distro": "Ubuntu-24.04",
        "registration": "{9aa9a259-fa28-47c6-98d1-3989ff98b971}",
        "vhdx": "C:/Users/test/ext4.vhdx",
        "volume_serial": "01234567",
        "file_id": "0000000000000001",
    }))
    database = tmp_path / "jobs.sqlite3"
    observed = worker.timestamp()
    with closing(worker.open_database(database)) as db:
        worker.initialize(db)
        with db:
            db.execute("INSERT INTO worker VALUES (1, 9, 'python.exe', 'win32', ?)", (observed,))
            db.execute(
                "INSERT INTO recovery_capabilities VALUES (1, 9, ?, ?)",
                (observed, worker.RECOVERY_PROTOCOL),
            )
    return tailnet_api.Recovery(tmp_path, Host())


def test_status_reports_stopped_distro(recovery, monkeypatch):
    monkeypatch.setattr(tailnet_api.shutil, "disk_usage", lambda _: type(
        "Measurement", (), {"free": 4096},
    )())
    assert recovery.status()["distro_running"] is False
    assert recovery.status()["windows_free_bytes"] == 4096


def test_recovery_protocol_required(recovery):
    with closing(worker.open_database(recovery.database)) as db, db:
        db.execute("DELETE FROM recovery_capabilities")
    with pytest.raises(RuntimeError, match="needs setup or an upgrade"):
        recovery.submit("start-ubuntu", str(uuid4()))


def test_compaction_retry_preserves_existing_job(recovery):
    job_id = str(uuid4())
    first = recovery.submit("compact", job_id)
    assert first["state"] == "queued"
    assert recovery.submit("compact", job_id) == first
    with pytest.raises(worker.MaintenanceConflict):
        recovery.submit("start-ubuntu", job_id)


def test_read_during_claim_reconciles_database_and_inbox(recovery, monkeypatch):
    job_id = str(uuid4())
    recovery.submit("start-ubuntu", job_id)

    def claim_while_reading(path):
        with closing(worker.open_database(recovery.database)) as db, db:
            db.execute(
                "INSERT INTO jobs (job_id, state, accepted_at, operation) "
                "VALUES (?, 'accepted', ?, 'start-ubuntu')", (job_id, worker.timestamp()),
            )
        path.unlink()
        raise FileNotFoundError(path)

    monkeypatch.setattr(worker, "read_request", claim_while_reading)
    assert recovery.submit("start-ubuntu", job_id)["state"] == "accepted"
    assert recovery.job(job_id)["state"] == "accepted"


def test_hold_after_enqueue_prevents_guest_start(recovery):
    job_id = str(uuid4())
    recovery.submit("start-ubuntu", job_id)

    def unexpected_host():
        pytest.fail("A compaction hold must prevent entering the guest.")

    with closing(worker.open_database(recovery.database)) as db, db:
        db.execute(
            "INSERT INTO jobs (job_id, state, accepted_at, operation) "
            "VALUES (?, 'interrupted', ?, 'compact')", (str(uuid4()), worker.timestamp()),
        )
    worker.run_worker(recovery.state, once=True, host_factory=unexpected_host)
    assert recovery.job(job_id)["state"] == "failed"


def test_status_wait_does_not_block_health_and_authentication(recovery, monkeypatch):
    inventory_started = Event()
    inventory_done = Event()

    def pending_inventory():
        inventory_started.set()
        assert inventory_done.wait(5)
        return []

    monkeypatch.setattr(recovery.host, "running_distros", pending_inventory)
    monkeypatch.setattr(tailnet_api.shutil, "disk_usage", lambda _: type(
        "Measurement", (), {"free": 4096},
    )())
    handler = tailnet_api.handler(recovery, TOKEN)
    with tailnet_api.RecoveryServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        pending = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            pending.request("GET", "/v1/status", headers=auth("/v1/status"))
            assert inventory_started.wait(2)
            client.request("GET", "/healthz", headers={"Tailscale-User-Login": "operator"})
            denied = client.getresponse()
            assert denied.status == 401
            denied.read()
            client.request("GET", "/healthz", headers=auth("/healthz"))
            allowed = client.getresponse()
            assert allowed.status == 200
            allowed.read()
            inventory_done.set()
            assert pending.getresponse().status == 200
        finally:
            inventory_done.set()
            pending.close()
            client.close()
            server.shutdown()
            thread.join()


def test_local_compaction_sees_queued_remote_job(recovery):
    job_id = str(uuid4())
    recovery.submit("start-ubuntu", job_id)
    with closing(worker.open_database(recovery.database)) as db, db:
        db.execute(
            "INSERT INTO worker_capabilities SELECT id, pid, heartbeat_at, ? FROM worker",
            (worker.MAINTENANCE_PROTOCOL,),
        )
    with pytest.raises(worker.MaintenanceConflict, match=f"{job_id} is queued"):
        worker.submit(recovery.state, "compact")


def test_worker_restart_preserves_unclaimed_recovery_request(recovery):
    job_id = str(uuid4())
    recovery.submit("start-ubuntu", job_id)

    class Host:
        def run_recovery_operation(self, operation, journal):
            assert operation == "start-ubuntu"
            assert journal.job_id == job_id
            return {"pid1_start_ticks": 12}

    worker.run_worker(recovery.state, once=True, host_factory=Host)
    assert recovery.job(job_id)["result"] == {"pid1_start_ticks": 12}
    assert recovery.submit("start-ubuntu", job_id)["state"] == "completed"
    assert not list(recovery.inbox.glob("*.json"))


def test_failed_windows_inventory_keeps_native_health(recovery, monkeypatch):
    def failed_inventory():
        raise RuntimeError("Windows inventory unavailable")

    monkeypatch.setattr(recovery.host, "running_distros", failed_inventory)
    monkeypatch.setattr(tailnet_api.shutil, "disk_usage", lambda _: type(
        "Measurement", (), {"free": 4096},
    )())
    inventory = recovery.status()
    assert inventory["distro"] == "Ubuntu-24.04"
    assert inventory["distro_running"] is None
    assert inventory["worker_state"] == "ready"
    assert inventory["recovery_protocol"] == worker.RECOVERY_PROTOCOL


def test_incomplete_headers_release_server_slots(recovery, monkeypatch):
    import socket
    import time

    handler = tailnet_api.handler(recovery, TOKEN)
    monkeypatch.setattr(handler, "header_deadline", 0.15)
    with tailnet_api.RecoveryServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        slow = [
            socket.create_connection(("127.0.0.1", server.server_port), timeout=3)
            for _ in range(16)
        ]
        try:
            for connection in slow:
                connection.sendall(b"GET /healthz HTTP/1.0\r\nX-Partial: ")
            for _ in range(4):
                time.sleep(0.025)
                for connection in slow:
                    try:
                        connection.sendall(b"x")
                    except OSError:
                        pass
            for connection in slow:
                try:
                    assert connection.recv(1) == b""
                except ConnectionResetError:
                    pass
            # On Windows a closed socket can signal EOF before its handler returns.
            for _ in slow:
                assert server.slots.acquire(timeout=2)
            for _ in slow:
                server.slots.release()
            with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as client:
                client.request("GET", "/healthz", headers=auth("/healthz"))
                assert client.getresponse().status == 200
        finally:
            for connection in slow:
                connection.close()
            server.shutdown()
            thread.join()


def test_signed_route_rejects_a_changed_job_and_authenticates_responses(recovery):
    headers = tailnet_api.signed_headers(TOKEN, "GET", "/healthz")
    signature = headers["Authorization"].rsplit(".", 1)[1]
    assert TOKEN.decode() not in headers["Authorization"]
    handler = tailnet_api.handler(recovery, TOKEN)
    with tailnet_api.RecoveryServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as client:
                client.request("GET", "/v1/status", headers=headers)
                rejected = client.getresponse()
                assert rejected.status == 401
                rejected.read()
                client.request("GET", "/healthz", headers=headers)
                accepted = client.getresponse()
                body = accepted.read()
                expected = tailnet_api.response_signature(TOKEN, signature, accepted.status, body)
                assert accepted.getheader(tailnet_api.SIGNATURE_HEADER) == expected
        finally:
            server.shutdown()
            thread.join()


def test_compaction_reports_separate_outcomes_without_internal_error(recovery):
    job_id = str(uuid4())
    result = {"compaction_ok": True, "detach_verified": True, "recovery_ok": False,
              "c_free_delta_bytes": 1024, "error": "private Windows path"}
    with closing(worker.open_database(recovery.database)) as db, db:
        db.execute(
            "INSERT INTO jobs (job_id, state, accepted_at, operation, result) "
            "VALUES (?, 'failed', ?, 'compact', ?)",
            (job_id, worker.timestamp(), json.dumps(result)),
        )
    public = recovery.job(job_id)
    assert public["state"] == "failed"
    assert public["result"] == {key: value for key, value in result.items() if key != "error"}



def test_authenticated_rejection_consumes_signed_attempt_across_restart(recovery):
    from uuid import uuid4

    blocked = str(uuid4())
    recovery.submit("compact", blocked)
    job_id = str(uuid4())
    path = "/v1/jobs/start-ubuntu"
    signed = tailnet_api.signed_headers(TOKEN, "POST", path, job_id)

    def post(instance, headers):
        with tailnet_api.RecoveryServer(("127.0.0.1", 0), tailnet_api.handler(instance, TOKEN)) as server:
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as client:
                    client.request("POST", path, headers=headers)
                    response = client.getresponse()
                    response.read()
                    return response.status
            finally:
                server.shutdown()
                thread.join()

    assert post(recovery, signed) == 409
    (recovery.inbox / f"{blocked}.json").unlink()
    restarted = tailnet_api.Recovery(recovery.state, recovery.host)
    assert post(restarted, signed) == 409
    assert restarted.job(job_id) is None
    assert post(restarted, tailnet_api.signed_headers(TOKEN, "POST", path, job_id)) == 202
