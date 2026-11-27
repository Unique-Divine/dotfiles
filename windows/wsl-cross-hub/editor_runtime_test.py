import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import editor_runtime as editor
import pytest
import worker


def config_snapshot(root: Path, initial: str) -> dict:
    root.mkdir()
    (root / "init.lua").write_text(initial, encoding="utf-8")
    (root / "lazy-lock.json").write_text("{}", encoding="utf-8")
    files = {path.name: editor.digest_file(path) for path in root.iterdir()}
    return {"files": files, "fingerprint": editor.fingerprint(files)}


@pytest.mark.parametrize(("machine", "suffix"), [("ARM64", "arm64"), ("AMD64", "x64")])
def test_selects_pinned_native_release(
    tmp_path: Path, machine: str, suffix: str
) -> None:
    executable = editor.windows_executable(tmp_path, machine)
    assert executable.parts[-3] == f"{editor.VERSION}-{suffix}"
    assert len(editor.ASSETS[suffix][1]) == 64


def test_install_rejects_digest_before_extracting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import io

    monkeypatch.setattr(
        editor.urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(b"bad")
    )
    executable = editor.windows_executable(tmp_path, "ARM64")
    with pytest.raises(RuntimeError, match="SHA-256"):
        editor.install_binary(executable, "ARM64")
    assert not executable.exists()


def test_config_apply_is_repeatable_and_preserves_previous_managed_copy(
    tmp_path: Path,
) -> None:
    first, second, config = [tmp_path / name for name in ("first", "second", "nvim")]
    one = config_snapshot(first, "-- first")
    two = config_snapshot(second, "-- second")
    editor.apply_config(config, first, one)
    editor.apply_config(config, first, one)
    assert editor.matches(config, one["files"])
    assert not (tmp_path / ".dotfiles-neovim-backups").exists()
    (config / "local.lua").write_text("-- personal", encoding="utf-8")
    editor.apply_config(config, second, two)
    [backup] = list((tmp_path / ".dotfiles-neovim-backups").iterdir())
    assert (backup / "local.lua").read_text(encoding="utf-8") == "-- personal"
    assert editor.matches(config, two["files"])


def test_unmanaged_config_is_preserved(tmp_path: Path) -> None:
    source, config = tmp_path / "source", tmp_path / "nvim"
    release = config_snapshot(source, "-- dotfiles")
    original = config_snapshot(config, "-- personal")
    with pytest.raises(RuntimeError, match="unmanaged"):
        editor.apply_config(config, source, release)
    assert editor.matches(config, original["files"])


def test_offline_wsl_never_invokes_a_guest_command() -> None:
    def unexpected(*args, **kwargs):
        pytest.fail("Doctor attempted to start WSL")

    host = SimpleNamespace(running_distros=list, command=unexpected)
    result = editor.ubuntu_check(host)
    assert result["state"] == "unavailable"
    assert not result["canCure"]


@pytest.mark.parametrize(
    ("mode", "runner"),
    [("auto", "codex"), ("investigate", "managed"), ("cure", "claude")],
)
def test_editor_actions_reject_agent_and_automatic_dispatch(
    tmp_path: Path, mode: str, runner: str
) -> None:
    with pytest.raises(ValueError, match="Invalid Doctor"):
        worker.submit_doctor(tmp_path, mode, "windows-neovim", runner)


def test_editor_cure_journals_verified_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        editor,
        "windows_check",
        lambda: editor.report("windows-neovim", None, False, "missing", True),
    )
    monkeypatch.setattr(
        editor,
        "windows_install",
        lambda: editor.report(
            "windows-neovim", editor.VERSION, True, "Neovim 0.12.6", False
        ),
    )
    job_id = str(uuid4())
    result = editor.execute_cure(
        tmp_path, {"check": "windows-neovim", "job_id": job_id}
    )
    assert result["outcome"] == "cured"
    lines = (
        (tmp_path / "maintenance" / f"{job_id}.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    )
    entries = [json.loads(line) for line in lines]
    assert [entry["stage"] for entry in entries] == [
        "doctor-started",
        "doctor-observed",
        "doctor-action",
        "doctor-verified",
        "doctor-finished",
    ]
    assert entries[3]["state"] == "healthy"
