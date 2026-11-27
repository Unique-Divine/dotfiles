import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("doctor-from-wsl.sh")
pytestmark = pytest.mark.skipif(
    os.name != "posix" or not os.access("/bin/bash", os.X_OK),
    reason="requires POSIX /bin/bash for the WSL wrapper and PowerShell stub",
)


def invoke(
    tmp_path: Path, stub_script: str, *args: str
) -> subprocess.CompletedProcess[str]:
    powershell = tmp_path / "powershell.exe"
    powershell.write_text("#!/bin/bash\n" + stub_script, encoding="utf-8")
    powershell.chmod(0o755)
    return subprocess.run(
        ["/bin/bash", str(SCRIPT), *args],
        env=os.environ | {"PATH": str(tmp_path), "WSL_INTEROP": "keep-me"},
        input="caller input\n",
        capture_output=True,
        check=False,
        text=True,
        timeout=5,
    )


@pytest.mark.parametrize(
    ("args", "action"), [((), "& $hub"), (("--setup-preview",), "& $hub -Setup")]
)
def test_passes_only_the_selected_read_only_action(
    tmp_path: Path, args: tuple[str, ...], action: str
) -> None:
    result = invoke(
        tmp_path,
        f"""
        [[ "$WSL_INTEROP" == "keep-me" ]] || exit 10
        [[ "${{@: -1}}" == *$'\n''{action}'$'\n''exit $LASTEXITCODE' ]] || exit 11
        if IFS= read -r caller_input; then exit 12; fi
        printf 'WSL_CROSS_HUB_READY\r\n{{"worker":"offline"}}\r\n'
        exit 23
        """,
        *args,
    )
    assert result.returncode == 23
    assert result.stdout == '{"worker":"offline"}\n'
    assert result.stderr == ""


def test_missing_windows_copy_keeps_the_native_error(tmp_path: Path) -> None:
    result = invoke(
        tmp_path,
        "printf 'WSL_CROSS_HUB_READY\r\n'; printf 'Run just win-sync\n' >&2; exit 66",
    )
    assert result.returncode == 66
    assert result.stdout == ""
    assert result.stderr == "Run just win-sync\n"


def test_interop_failure_is_distinct_from_missing_copy(tmp_path: Path) -> None:
    result = invoke(tmp_path, "exit 126")
    assert result.returncode == 126
    assert "did not start through WSL interop" in result.stderr


def test_rejects_apply_without_launching_powershell(tmp_path: Path) -> None:
    result = invoke(tmp_path, "printf 'unexpected invocation\n' >&2", "--apply")
    assert result.returncode == 2
    assert "Usage:" in result.stderr
    assert "unexpected invocation" not in result.stderr
