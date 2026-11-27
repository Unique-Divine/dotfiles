import json
from pathlib import Path

import pytest
from maintenance_plan import main, parse_snapshot, plan_maintenance


def inventory(*running: str, docker: bool | None = False) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "cFreeBytes": 20_000_000_000,
        "runningDistros": list(running),
        "dockerDesktopRunning": docker,
        "distributions": [
            {
                "name": "Ubuntu-24.04",
                "version": 2,
                "vhdPath": r"C:\Users\test\Ubuntu\ext4.vhdx",
                "vhdExists": True,
                "vhdLengthBytes": 15_000_000_000,
            }
        ],
    }


def test_stopped_target_stays_stopped() -> None:
    plan = plan_maintenance(parse_snapshot(inventory()), "Ubuntu-24.04")
    assert plan["decision"] == "eligible"
    assert plan["trim"] == "skip"
    assert plan["steps"] == [
        "record-host-baseline",
        "recheck-docker-and-running-distros",
        "verify-target-stopped",
        "verify-vhdx-available",
        "compact-vhdx-offline",
        "verify-vhdx-detached",
        "record-host-result",
    ]


def test_running_target_shuts_down_before_compaction_and_restarts_after() -> None:
    snapshot = parse_snapshot(inventory("Ubuntu-24.04"))
    plan = plan_maintenance(snapshot, "ubuntu-24.04")
    assert plan["decision"] == "eligible"
    assert plan["steps"] == [
        "record-host-baseline",
        "recheck-docker-and-running-distros",
        "shutdown-wsl",
        "verify-target-stopped",
        "verify-vhdx-available",
        "compact-vhdx-offline",
        "verify-vhdx-detached",
        "record-host-result",
        "restart-target",
        "verify-target-services",
    ]


def test_docker_shutdown_is_planned_even_without_running_docker_distro() -> None:
    snapshot = parse_snapshot(inventory("Ubuntu-24.04", docker=True))
    plan = plan_maintenance(snapshot, "Ubuntu-24.04")
    assert plan["decision"] == "eligible"
    assert plan["blockers"] == []
    assert plan["steps"][0] == "stop-docker-desktop"


def test_global_shutdown_impact_blocks() -> None:
    snapshot = parse_snapshot(inventory("Ubuntu-24.04", "Debian"))
    plan = plan_maintenance(snapshot, "Ubuntu-24.04")
    assert plan["decision"] == "blocked"
    assert plan["blockers"][0]["code"] == "other-running-distros"
    assert "Debian" in plan["blockers"][0]["message"]
    assert plan["steps"] == []


def test_unknown_states_block_and_keep_all_reasons() -> None:
    fields = inventory(docker=None)
    fields.update(cFreeBytes=None, runningDistros=None, distributions=None)
    plan = plan_maintenance(parse_snapshot(fields), "Ubuntu-24.04")
    assert plan["decision"] == "blocked"
    assert [blocker["code"] for blocker in plan["blockers"]] == [
        "unknown-registrations",
        "unknown-host-space",
        "unknown-docker-state",
        "unknown-running-distros",
    ]
    assert plan["steps"] == []


def test_docker_target_is_excluded() -> None:
    plan = plan_maintenance(parse_snapshot(inventory()), "docker-desktop")
    assert plan["decision"] == "blocked"
    assert [blocker["code"] for blocker in plan["blockers"]] == [
        "docker-target",
        "missing-distro",
    ]


@pytest.mark.parametrize(
    ("override", "reason"),
    [
        ({"version": 1}, "requires-wsl2"),
        ({"version": None}, "requires-wsl2"),
        ({"vhdPath": None}, "unknown-vhd-path"),
        ({"vhdPath": "ext4.vhdx"}, "invalid-vhd-path"),
        ({"vhdExists": False, "vhdLengthBytes": None}, "missing-vhd"),
        ({"vhdExists": None, "vhdLengthBytes": None}, "unknown-vhd-size"),
        ({"vhdLengthBytes": 0}, "unknown-vhd-size"),
    ],
)
def test_invalid_target_blocks(override: dict[str, object], reason: str) -> None:
    fields = inventory()
    registrations = fields["distributions"]
    assert isinstance(registrations, list)
    registrations[0].update(override)
    plan = plan_maintenance(parse_snapshot(fields), "Ubuntu-24.04")
    assert plan["decision"] == "blocked"
    assert [blocker["code"] for blocker in plan["blockers"]] == [reason]
    assert plan["steps"] == []


def test_ambiguous_target_blocks() -> None:
    fields = inventory()
    registrations = fields["distributions"]
    assert isinstance(registrations, list)
    registrations.append(registrations[0] | {"name": "ubuntu-24.04"})
    plan = plan_maintenance(parse_snapshot(fields), "Ubuntu-24.04")
    assert plan["blockers"][0]["code"] == "ambiguous-distro"


@pytest.mark.parametrize(
    ("key", "bad_value"),
    [
        ("schemaVersion", True),
        ("schemaVersion", 2),
        ("runningDistros", ["Ubuntu-24.04", 2]),
        ("dockerDesktopRunning", 1),
        ("cFreeBytes", -1),
    ],
)
def test_bad_snapshot_fields_are_rejected(key: str, bad_value: object) -> None:
    fields = inventory()
    fields[key] = bad_value
    with pytest.raises(ValueError):
        parse_snapshot(fields)


def test_cli_reports_blocked_plan(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text(json.dumps(inventory("Ubuntu-24.04", "Debian")), encoding="utf-8")
    assert main(["--distro", "Ubuntu-24.04", "--snapshot", str(snapshot)]) == 0
    assert json.loads(capsys.readouterr().out)["decision"] == "blocked"


def test_cli_rejects_invalid_input(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text("{", encoding="utf-8")
    with pytest.raises(SystemExit) as error:
        main(["--distro", "Ubuntu-24.04", "--snapshot", str(snapshot)])
    assert error.value.code == 2
