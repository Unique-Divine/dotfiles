import json
import subprocess
import sys
from pathlib import Path

import pytest
from maintenance_plan import Distribution, Plan, Snapshot, plan_maintenance
from maintenance_rehearsal import parse_plan, rehearse

DISTRO = "Ubuntu-24.04"


def make_plan(*, running: bool = True, docker: bool = False) -> Plan:
    return plan_maintenance(
        Snapshot(
            c_free_bytes=40_000_000_000,
            docker_desktop_running=docker,
            running_distros=(DISTRO,) if running else (),
            distributions=(
                Distribution(DISTRO, 2, r"C:\Linux\ext4.vhdx", True, 50_000_000_000),
            ),
        ),
        DISTRO,
    )


def test_success_journals_each_planned_step_in_order() -> None:
    plan = parse_plan(make_plan())
    result = rehearse(plan, free_before=20, free_after=35)
    journal = result["journal"]
    assert result["simulated"] is True
    assert result["state"] == "completed"
    assert result["compaction"] == result["recovery"] == "succeeded"
    assert result["currentStep"] is None
    assert [event["sequence"] for event in journal] == list(range(1, len(journal) + 1))
    assert journal[0]["state"] == "accepted" and journal[-1]["state"] == "completed"
    assert [event["step"] for event in journal if event["state"] == "started"] == plan[
        "steps"
    ]
    assert result["windowsSpace"] == {
        "beforeFreeBytes": 20,
        "afterFreeBytes": 35,
        "freeBytesDelta": 15,
    }


def test_blocked_plan_never_starts_a_step() -> None:
    result = rehearse(parse_plan(make_plan(docker=True)), free_before=20, free_after=35)
    assert result["state"] == "blocked"
    assert [event["state"] for event in result["journal"]] == ["accepted", "blocked"]
    assert [blocker["code"] for blocker in result["blockers"]] == ["docker-running"]
    assert all(value is None for value in result["windowsSpace"].values())


def test_drift_defers_before_the_first_mutation() -> None:
    result = rehearse(make_plan(), "state-changed")
    assert result["state"] == "deferred"
    assert result["recovery"] == "not-needed"
    assert result["compaction"] == "not-attempted"
    assert all(event["step"] != "shutdown-wsl" for event in result["journal"])


def test_busy_disk_exhausts_bounded_verification_attempts() -> None:
    result = rehearse(make_plan(), "busy-vhdx")
    assert result["state"] == "deferred"
    assert result["currentStep"] == "verify-vhdx-available"
    assert result["recovery"] == "not-attempted"
    assert [
        event["attempt"]
        for event in result["journal"]
        if event["step"] == result["currentStep"] and event["state"] == "started"
    ] == [1, 2, 3]
    assert all(event["step"] != "compact-vhdx-offline" for event in result["journal"])


def test_compaction_error_is_terminal_without_a_second_attempt() -> None:
    result = rehearse(make_plan(), "compact-failed", free_before=20, free_after=35)
    assert result["state"] == "failed"
    assert result["compaction"] == "failed"
    assert result["windowsSpace"]["beforeFreeBytes"] == 20
    assert result["windowsSpace"]["afterFreeBytes"] is None
    assert result["journal"][-1]["attempt"] == 1
    assert all(event["step"] != "restart-target" for event in result["journal"])


def test_restart_error_retains_compaction_and_windows_measurements() -> None:
    result = rehearse(make_plan(), "restart-failed", free_before=20, free_after=35)
    assert result["state"] == "partial"
    assert result["compaction"] == "succeeded" and result["recovery"] == "failed"
    assert result["windowsSpace"]["freeBytesDelta"] == 15
    assert result["journal"][-1]["attempt"] == 1
    assert all(event["step"] != "verify-target-services" for event in result["journal"])


def test_interrupted_compaction_requires_reconciliation_and_stops() -> None:
    result = rehearse(
        make_plan(), "interrupted-compaction", free_before=20, free_after=35
    )
    assert result["state"] == "interrupted"
    assert result["currentStep"] == "compact-vhdx-offline"
    assert result["compaction"] == "unverified"
    assert result["requiresReconciliation"] is True
    assert result["windowsSpace"]["afterFreeBytes"] is None
    assert result["journal"][-1]["attempt"] == 1
    assert all(event["step"] != "verify-vhdx-detached" for event in result["journal"])


def test_stopped_target_preserves_its_original_state() -> None:
    plan = parse_plan(make_plan(running=False))
    result = rehearse(plan)
    assert result["state"] == "completed"
    assert result["recovery"] == "not-needed"
    assert all(event["step"] != "restart-target" for event in result["journal"])
    with pytest.raises(ValueError, match="requires step restart-target"):
        rehearse(plan, "restart-failed")


def test_incomplete_plan_is_rejected() -> None:
    invalid = {**make_plan(), "steps": ["compact-vhdx-offline"]}
    with pytest.raises(ValueError, match="steps must match"):
        parse_plan(invalid)


def test_cli_reads_planner_json_from_standard_input() -> None:
    script = Path(__file__).with_name("maintenance_rehearsal.py")
    result = subprocess.run(
        [sys.executable, str(script), "--scenario", "services-unready"],
        input=json.dumps(make_plan()).encode("utf-8-sig"),
        capture_output=True,
        check=True,
        timeout=15,
    )
    report = json.loads(result.stdout)
    assert report["state"] == "partial"
    assert report["compaction"] == "succeeded" and report["recovery"] == "failed"
    assert report["currentStep"] == "verify-target-services"
    assert report["journal"][-1]["attempt"] == 3
