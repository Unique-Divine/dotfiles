"""Read a WSL Cross Hub snapshot and describe coordinated offline compaction."""

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Literal, TypedDict, TypeVar, cast


@dataclass(frozen=True)
class Distribution:
    name: str
    version: int | None
    vhd_path: str | None
    vhd_exists: bool | None
    vhd_length_bytes: int | None


@dataclass(frozen=True)
class Snapshot:
    c_free_bytes: int | None
    docker_desktop_running: bool | None
    running_distros: tuple[str, ...] | None
    distributions: tuple[Distribution, ...] | None


class Blocker(TypedDict):
    code: str
    message: str


class Plan(TypedDict):
    schemaVersion: Literal[1]
    distro: str
    decision: Literal["blocked", "eligible"]
    trim: Literal["skip"]
    blockers: list[Blocker]
    steps: list[str]


T = TypeVar("T")


def expect_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a JSON object")
    return cast(dict[str, object], value)


def nullable_field(fields: dict[str, object], name: str, expected: type[T]) -> T | None:
    if name not in fields:
        raise ValueError(f"missing {name}")
    value = fields[name]
    if value is None:
        return None
    if not isinstance(value, expected) or (expected is int and isinstance(value, bool)):
        raise ValueError(f"{name} must be {expected.__name__} or null")
    return value


def require_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def parse_distribution(value: object) -> Distribution:
    fields = expect_mapping(value, "distribution")
    length = nullable_field(fields, "vhdLengthBytes", int)
    if length is not None and length < 0:
        raise ValueError("vhdLengthBytes must be nonnegative")
    return Distribution(
        name=require_name(fields.get("name"), "distribution name"),
        version=nullable_field(fields, "version", int),
        vhd_path=nullable_field(fields, "vhdPath", str),
        vhd_exists=nullable_field(fields, "vhdExists", bool),
        vhd_length_bytes=length,
    )


def parse_snapshot(value: object) -> Snapshot:
    fields = expect_mapping(value, "snapshot")
    if nullable_field(fields, "schemaVersion", int) != 1:
        raise ValueError("expected schemaVersion 1")
    free = nullable_field(fields, "cFreeBytes", int)
    if free is not None and free < 0:
        raise ValueError("cFreeBytes must be nonnegative")
    running = nullable_field(fields, "runningDistros", list)
    registered = nullable_field(fields, "distributions", list)
    return Snapshot(
        c_free_bytes=free,
        docker_desktop_running=nullable_field(fields, "dockerDesktopRunning", bool),
        running_distros=(
            tuple(require_name(item, "running distribution name") for item in running)
            if running is not None
            else None
        ),
        distributions=(
            tuple(parse_distribution(item) for item in registered)
            if registered is not None
            else None
        ),
    )


def distribution_blocker(
    registrations: tuple[Distribution, ...] | None, target: str
) -> Blocker | None:
    if registrations is None:
        return {
            "code": "unknown-registrations",
            "message": "Windows could not read the distribution registrations.",
        }
    matches = [item for item in registrations if item.name.casefold() == target]
    if not matches:
        return {
            "code": "missing-distro",
            "message": "The selected distribution is absent from Windows registrations.",
        }
    if len(matches) != 1:
        return {
            "code": "ambiguous-distro",
            "message": "Multiple Windows registrations match the selected distribution.",
        }
    distro = matches[0]
    if distro.version != 2:
        return {
            "code": "requires-wsl2",
            "message": "The selected distribution must be registered as WSL 2.",
        }
    if not distro.vhd_path:
        return {
            "code": "unknown-vhd-path",
            "message": "Windows did not report the selected distribution's VHDX path.",
        }
    path = PureWindowsPath(distro.vhd_path)
    if len(path.drive) != 2 or not path.is_absolute() or path.suffix.lower() != ".vhdx":
        return {
            "code": "invalid-vhd-path",
            "message": "The selected VHDX must have an absolute Windows drive path.",
        }
    if distro.vhd_exists is False:
        return {
            "code": "missing-vhd",
            "message": "The selected VHDX was not found as a file.",
        }
    if distro.vhd_exists is None or not distro.vhd_length_bytes:
        return {
            "code": "unknown-vhd-size",
            "message": "Windows could not measure a nonempty VHDX file.",
        }
    return None


def maintenance_steps(target_running: bool, *, stop_docker: bool = False) -> list[str]:
    steps = ["stop-docker-desktop"] if stop_docker else []
    steps.extend(["record-host-baseline", "recheck-docker-and-running-distros"])
    if target_running:
        steps.append("shutdown-wsl")
    steps.extend(
        [
            "verify-target-stopped",
            "verify-vhdx-available",
            "compact-vhdx-offline",
            "verify-vhdx-detached",
            "record-host-result",
        ]
    )
    if target_running:
        steps.extend(["restart-target", "verify-target-services"])
    return steps


def plan_maintenance(snapshot: Snapshot, distro: str) -> Plan:
    target = require_name(distro, "distro").casefold()
    blockers: list[Blocker] = []
    if target.startswith("docker-desktop"):
        blockers.append(
            {
                "code": "docker-target",
                "message": "This plan covers a user distribution and excludes Docker.",
            }
        )
    if blocker := distribution_blocker(snapshot.distributions, target):
        blockers.append(blocker)
    if snapshot.c_free_bytes is None:
        blockers.append(
            {"code": "unknown-host-space", "message": "C: free space is unknown."}
        )
    match snapshot.docker_desktop_running:
        case None:
            blockers.append(
                {
                    "code": "unknown-docker-state",
                    "message": "Windows could not check whether Docker Desktop is running.",
                }
            )
    running = snapshot.running_distros
    target_running = False
    if running is None:
        blockers.append(
            {
                "code": "unknown-running-distros",
                "message": "Windows could not check which WSL distributions are running.",
            }
        )
    else:
        target_running = any(name.casefold() == target for name in running)
        other_running = sorted(name for name in running if name.casefold() not in {target, "docker-desktop", "docker-desktop-data"})
        if other_running:
            blockers.append(
                {
                    "code": "other-running-distros",
                    "message": "Global WSL shutdown would also stop "
                    + ", ".join(other_running)
                    + ".",
                }
            )
    return {
        "schemaVersion": 1,
        "distro": distro,
        "decision": "blocked" if blockers else "eligible",
        "trim": "skip",
        "blockers": blockers,
        "steps": [] if blockers else maintenance_steps(
            target_running, stop_docker=snapshot.docker_desktop_running is True
        ),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--distro", required=True, help="Windows registration name")
    parser.add_argument(
        "--snapshot", default="-", help="Inventory JSON file, or - for standard input"
    )
    args = parser.parse_args(argv)
    try:
        raw = (
            sys.stdin.buffer.read().decode("utf-8-sig")
            if args.snapshot == "-"
            else Path(args.snapshot).read_text(encoding="utf-8-sig")
        )
        print(
            json.dumps(plan_maintenance(parse_snapshot(json.loads(raw)), args.distro))
        )
    except (ValueError, OSError, TypeError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
