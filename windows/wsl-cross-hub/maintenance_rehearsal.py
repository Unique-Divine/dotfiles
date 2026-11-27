"""Rehearse an offline WSL maintenance plan using simulated outcomes."""

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, TypedDict

from maintenance_plan import (
    Blocker,
    Plan,
    expect_mapping,
    maintenance_steps,
    nullable_field,
    require_name,
)

TerminalState = Literal[
    "blocked", "deferred", "completed", "failed", "partial", "interrupted"
]
EventState = Literal["accepted", "started", "succeeded", "retry"] | TerminalState
OperationState = Literal[
    "not-needed", "not-attempted", "succeeded", "failed", "unverified"
]


class Event(TypedDict):
    sequence: int
    state: EventState
    step: str | None
    attempt: int | None
    reason: str | None


class WindowsSpace(TypedDict):
    beforeFreeBytes: int | None
    afterFreeBytes: int | None
    freeBytesDelta: int | None


class Rehearsal(TypedDict):
    schemaVersion: Literal[1]
    simulated: Literal[True]
    distro: str
    scenario: str
    state: TerminalState
    currentStep: str | None
    requiresReconciliation: bool
    compaction: OperationState
    recovery: OperationState
    windowsSpace: WindowsSpace
    blockers: list[Blocker]
    journal: list[Event]


@dataclass(frozen=True)
class Failure:
    step: str
    state: TerminalState
    reason: str
    attempts: int = 1


SCENARIOS: dict[str, Failure | None] = {
    "success": None,
    "state-changed": Failure(
        "recheck-docker-and-running-distros", "deferred", "host-state-changed"
    ),
    "busy-vhdx": Failure("verify-vhdx-available", "deferred", "vhdx-busy", 3),
    "compact-failed": Failure("compact-vhdx-offline", "failed", "compaction-error"),
    "restart-failed": Failure("restart-target", "partial", "restart-error"),
    "services-unready": Failure(
        "verify-target-services", "partial", "services-not-ready", 3
    ),
    "interrupted-compaction": Failure(
        "compact-vhdx-offline", "interrupted", "compaction-outcome-unknown"
    ),
}


def parse_plan(value: object) -> Plan:
    fields = expect_mapping(value, "maintenance plan")
    if nullable_field(fields, "schemaVersion", int) != 1:
        raise ValueError("expected maintenance plan schemaVersion 1")
    distro = require_name(fields.get("distro"), "distribution name")
    decision = fields.get("decision")
    if decision not in ("blocked", "eligible") or fields.get("trim") != "skip":
        raise ValueError("expected the offline compaction plan")
    raw_steps = nullable_field(fields, "steps", list)
    raw_blockers = nullable_field(fields, "blockers", list)
    if raw_steps is None or raw_blockers is None:
        raise ValueError("steps and blockers must be arrays")
    blockers = []
    for item in raw_blockers:
        blocker = expect_mapping(item, "blocker")
        blockers.append(
            Blocker(
                code=require_name(blocker.get("code"), "blocker code"),
                message=require_name(blocker.get("message"), "blocker message"),
            )
        )
    steps = [require_name(step, "step") for step in raw_steps]
    if decision == "blocked":
        if steps or not blockers:
            raise ValueError("a blocked plan needs blockers and no steps")
    elif blockers or steps not in (
        maintenance_steps(False), maintenance_steps(True),
        maintenance_steps(False, stop_docker=True), maintenance_steps(True, stop_docker=True),
    ):
        raise ValueError("eligible plan steps must match the offline planner order")
    return {
        "schemaVersion": 1,
        "distro": distro,
        "decision": "blocked" if decision == "blocked" else "eligible",
        "trim": "skip",
        "blockers": blockers,
        "steps": steps,
    }


def rehearse(
    plan: Plan,
    scenario: str = "success",
    *,
    free_before: int | None = None,
    free_after: int | None = None,
) -> Rehearsal:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario}")
    if any(value is not None and value < 0 for value in (free_before, free_after)):
        raise ValueError("fixture free space must be nonnegative")
    failure = SCENARIOS[scenario]
    eligible = plan["decision"] == "eligible"
    if eligible and failure is not None and failure.step not in plan["steps"]:
        raise ValueError(f"scenario {scenario} requires step {failure.step}")

    journal: list[Event] = []

    def record(
        state: EventState,
        step: str | None = None,
        attempt: int | None = None,
        reason: str | None = None,
    ) -> None:
        journal.append(
            {
                "sequence": len(journal) + 1,
                "state": state,
                "step": step,
                "attempt": attempt,
                "reason": reason,
            }
        )

    record("accepted")
    terminal: TerminalState = "completed" if eligible else "blocked"
    compaction: OperationState = "not-attempted"
    recovery: OperationState = "not-needed"
    before = after = None
    current_step = None
    for step in plan["steps"] if eligible else ():
        record("started", step, 1)
        if failure is not None and step == failure.step:
            for attempt in range(1, failure.attempts):
                record("retry", step, attempt, failure.reason)
                record("started", step, attempt + 1)
            terminal, current_step = failure.state, step
            if step == "compact-vhdx-offline":
                compaction = "unverified" if terminal == "interrupted" else "failed"
            if step in ("restart-target", "verify-target-services"):
                recovery = "failed"
            record(terminal, step, failure.attempts, failure.reason)
            break

        record("succeeded", step, 1)
        match step:
            case "record-host-baseline":
                before = free_before
            case "shutdown-wsl":
                recovery = "not-attempted"
            case "compact-vhdx-offline":
                compaction = "succeeded"
            case "record-host-result":
                after = free_after
            case "verify-target-services":
                recovery = "succeeded"
    else:
        record(terminal)

    return {
        "schemaVersion": 1,
        "simulated": True,
        "distro": plan["distro"],
        "scenario": scenario,
        "state": terminal,
        "currentStep": current_step,
        "requiresReconciliation": terminal == "interrupted",
        "compaction": compaction,
        "recovery": recovery,
        "windowsSpace": {
            "beforeFreeBytes": before,
            "afterFreeBytes": after,
            "freeBytesDelta": after - before
            if before is not None and after is not None
            else None,
        },
        "blockers": plan["blockers"],
        "journal": journal,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=SCENARIOS, default="success")
    parser.add_argument("--free-before-bytes", type=int, help="fixture C: free bytes")
    parser.add_argument("--free-after-bytes", type=int, help="fixture C: free bytes")
    options = parser.parse_args(argv)
    try:
        plan = parse_plan(json.loads(sys.stdin.buffer.read().decode("utf-8-sig")))
        result = rehearse(
            plan,
            options.scenario,
            free_before=options.free_before_bytes,
            free_after=options.free_after_bytes,
        )
    except (ValueError, OSError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
