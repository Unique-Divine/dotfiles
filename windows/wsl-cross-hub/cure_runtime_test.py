import json
from collections.abc import Iterator
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import cure_runtime as runtime
import pytest


def read_events(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_agent_transcript_excludes_raw_credentials() -> None:
    item = {
        "type": "item.completed",
        "item": {
            "type": "agent_message",
            "text": '{"diagnosis":"token=sk-test-credential-1234", "action":"none"}',
        },
    }
    projected, value = runtime.project_event(item)

    assert projected == {"type": "item.completed", "item_type": "agent_message"}
    assert runtime.parse_answer(value, "investigate") == ("[redacted]", "none")


@pytest.mark.parametrize(
    "event",
    [
        {"type": "item.started", "item": {"type": "command_execution"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use"}]}},
    ],
)
def test_agent_tool_event_is_rejected(event: dict[str, object]) -> None:
    with pytest.raises(RuntimeError, match="unsupported tool"):
        runtime.project_event(event)


def test_investigation_cannot_propose_start() -> None:
    with pytest.raises(ValueError, match="outside its scope"):
        runtime.parse_answer(
            {"diagnosis": "Stopped.", "action": "start"}, "investigate"
        )


class Offline:
    def running_distros(self) -> list[str]:
        return []

    def command(self, *args: object, **kwargs: object) -> str:
        raise AssertionError("Doctor must not start Ubuntu to inspect it.")


def test_offline_ubuntu_has_no_runners(tmp_path: Path) -> None:
    host = Offline()
    assert runtime.available(host, "ubuntu", tmp_path, tmp_path) == []
    assert runtime.observe(host, "ubuntu-herdr")[0] == "unavailable"


def test_inventory_probes_checks_and_host_runners_concurrently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    barrier = Barrier(len(runtime.CHECKS) + 2, timeout=2)

    def observe(host: object, check: str) -> tuple[str, str]:
        barrier.wait()
        return "healthy", check

    def available(
        host: object, system: str, root: Path, cwd: Path
    ) -> list[runtime.Runner]:
        barrier.wait()
        assert root == tmp_path
        return [runtime.Runner(system, "codex", "codex", ".codex")]

    monkeypatch.setattr(runtime, "WindowsHost", object)
    monkeypatch.setattr(runtime, "observe", observe)
    monkeypatch.setattr(runtime, "available", available)

    checks = runtime.doctor_checks(tmp_path)["checks"]

    assert [check["id"] for check in checks] == list(runtime.CHECKS)
    assert all(check["runners"] == ["codex"] for check in checks)


@pytest.mark.parametrize("state", ["healthy", "unavailable"])
def test_auto_check_skips_authentication_without_a_failure(
    state: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected(*args: object) -> list[runtime.Runner]:
        raise AssertionError(
            "A non-failing check must not query provider authentication."
        )

    monkeypatch.setattr(runtime, "WindowsHost", object)
    monkeypatch.setattr(runtime, "observe", lambda host, check: (state, "Observed."))
    monkeypatch.setattr(runtime, "available", unexpected)

    check = runtime.doctor_check("windows-ssh", tmp_path)

    assert check["state"] == state
    assert check["runners"] == []


def configure_job(
    monkeypatch: pytest.MonkeyPatch,
    states: Iterator[tuple[str, str]],
    *,
    response: tuple[str, str] = ("Stopped.", "start"),
    login_ok: bool = True,
) -> list[str]:
    actions: list[str] = []
    runner = runtime.Runner("windows", "codex", "codex", ".codex")
    monkeypatch.setattr(runtime, "WindowsHost", object)
    monkeypatch.setattr(runtime, "observe", lambda host, check: next(states))
    monkeypatch.setattr(runtime, "candidates", lambda host, system, root: [runner])
    monkeypatch.setattr(runtime, "authenticated", lambda *args: login_ok)
    monkeypatch.setattr(runtime, "run_agent", lambda *args: response)
    monkeypatch.setattr(
        runtime, "run_fixed_action", lambda host, check: actions.append(check)
    )
    return actions


def request_for(operation: str = "cure") -> dict[str, str]:
    return {
        "operation": operation,
        "check": "windows-ssh",
        "runner": "codex",
        "job_id": str(uuid4()),
    }


def test_cure_only_starts_the_failed_host_action_and_verifies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = request_for()
    actions = configure_job(
        monkeypatch,
        iter(
            [
                ("failed", "Stopped."),
                ("failed", "Still stopped."),
                ("healthy", "Responds."),
            ]
        ),
    )

    result = runtime.execute_doctor(tmp_path, request)

    assert result == {"outcome": "cured", "detail": "Responds."}
    assert actions == ["windows-ssh"]
    journal = tmp_path / "maintenance" / f"{request['job_id']}.jsonl"
    events = read_events(journal)
    assert [event["stage"] for event in events][-3:] == [
        "doctor-action",
        "doctor-verified",
        "doctor-finished",
    ]
    assert events[-2]["state"] == "healthy"


def test_self_resolution_wins_over_proposed_action(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    actions = configure_job(
        monkeypatch, iter([("failed", "Stopped."), ("healthy", "Responds.")])
    )

    assert runtime.execute_doctor(tmp_path, request_for())["outcome"] == "healthy"
    assert not actions


def test_unavailable_runner_cannot_cure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    actions = configure_job(monkeypatch, iter([("failed", "Stopped.")]), login_ok=False)

    assert runtime.execute_doctor(tmp_path, request_for())["outcome"] == "unavailable"
    assert not actions


def test_investigate_never_calls_cure_broker_even_if_runner_errs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    actions = configure_job(monkeypatch, iter([("failed", "Stopped.")]))

    result = runtime.execute_doctor(tmp_path, request_for("investigate"))

    assert result["outcome"] == "investigated"
    assert not actions


def test_claude_structured_output_protocol_is_accepted() -> None:
    tool = {"type": "tool_use", "name": "StructuredOutput", "id": "output"}
    initial = {"type": "assistant", "message": {"content": [tool]}}
    ack = {
        "type": "user",
        "message": {
            "content": [
                {"type": "tool_result", "tool_use_id": "output"},
            ]
        },
    }
    pending: set[str] = set()

    result, _ = runtime.project_event(initial, pending)
    assert result["protocol_event"] == "structured_output"
    assert pending == {"output"}
    result, _ = runtime.project_event(ack, pending)
    assert result["protocol_event"] == "structured_output_acknowledged"
    assert not pending
    with pytest.raises(RuntimeError, match="unsupported tool"):
        runtime.project_event(ack, pending)
