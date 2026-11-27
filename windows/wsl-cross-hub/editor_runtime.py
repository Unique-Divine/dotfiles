"""Stage, check, and restore the dotfiles-managed Neovim installation."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import tomllib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from uuid import uuid4
from zipfile import ZipFile

from maintenance_runtime import Journal, WindowsHost

VERSION = "0.12.6"
ASSETS = {
    "arm64": (
        "nvim-win-arm64",
        "2e58d259ffcc6145e5112ea02330126c6b57da09087bb9265fb2fa9aa10b485c",
    ),
    "x64": (
        "nvim-win64",
        "4e12b7103b601ffc8f25954b4da100f339faa73dccb69a5b135e897fa3d893ed",
    ),
}
CHECKS = ("windows-neovim", "ubuntu-neovim")
MARKER = ".dotfiles-neovim.json"
TOOL = "aqua:neovim/neovim"
ERRORS = (OSError, ValueError, RuntimeError, subprocess.SubprocessError)


def linked(path: Path) -> bool:
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if (
            stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0)
            & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            return True
    return False


def digest_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fingerprint(files: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def write_json(path: Path, value: object) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, sort_keys=True)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def stage_config(checkout: Path, windows_dotfiles: Path) -> dict:
    for name in ("config.toml", "mise.lock"):
        settings = tomllib.loads((checkout / "mise" / name).read_text(encoding="utf-8"))
        pin = settings["tools"][TOOL]
        if (pin if name == "config.toml" else pin[0]["version"]) != VERSION:
            raise ValueError(
                "Update the Windows Neovim release checksums to match mise."
            )
    listing = subprocess.check_output(
        ["git", "-C", str(checkout), "ls-files", "-z", "--", "nvim/"], timeout=10
    ).decode("utf-8")
    source = checkout / "nvim"
    files: dict[str, str] = {}
    for entry in listing.split("\0"):
        if entry:
            name = entry.removeprefix("nvim/")
            item = source / name
            if linked(item) or not item.is_file():
                raise ValueError(
                    f"Expected a regular tracked Neovim config file: {name}"
                )
            files[name] = digest_file(item)
    if "init.lua" not in files or "lazy-lock.json" not in files:
        raise ValueError("Expected init.lua and lazy-lock.json in the dotfiles config.")
    root = windows_dotfiles / "nvim-sources"
    if linked(root):
        raise ValueError("The Windows Neovim staging directory is linked.")
    root.mkdir(parents=True, exist_ok=True)
    release = {
        "version": VERSION,
        "fingerprint": fingerprint(files),
        "files": files,
        "checkout": str(checkout.resolve()),
    }
    target = root / release["fingerprint"]
    if not target.exists():
        with tempfile.TemporaryDirectory(dir=root) as temp:
            staging = Path(temp) / "config"
            staging.mkdir()
            for name in files:
                item = staging / name
                item.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, item)
            if not matches(staging, files):
                raise RuntimeError(
                    "Neovim config changed during sync. Run win-sync again."
                )
            staging.rename(target)
    if not matches(target, files):
        raise ValueError("The staged Neovim snapshot differs from the sync manifest.")
    write_json(root / "current.json", release)
    return release


def safe_relative(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        bool(path.parts)
        and not path.is_absolute()
        and ".." not in path.parts
        and not any(char in name for char in ("\\", ":"))
    )


def matches(root: Path, files: dict[str, str]) -> bool:
    return not linked(root) and all(
        (root / name).is_file()
        and not linked(root / name)
        and digest_file(root / name) == expected
        for name, expected in files.items()
    )


def staged_config() -> tuple[Path, dict]:
    root = Path(os.environ["USERPROFILE"]) / "dotfiles" / "nvim-sources"
    release = json.loads((root / "current.json").read_text(encoding="utf-8"))
    files = release["files"]
    if (
        release["version"] != VERSION
        or "init.lua" not in files
        or "lazy-lock.json" not in files
        or any(not safe_relative(name) for name in files)
        or release["fingerprint"] != fingerprint(files)
    ):
        raise ValueError("Sync the Neovim config again with just win-sync.")
    return root / release["fingerprint"], release


def architecture(machine: str) -> str:
    name = machine.lower()
    if name in {"amd64", "x86_64"}:
        return "x64"
    if name in {"arm64", "aarch64"}:
        return "arm64"
    raise ValueError(f"No managed Windows Neovim release for {machine}.")


def windows_executable(local: Path, machine: str) -> Path:
    arch = architecture(machine)
    return (
        local
        / "Programs"
        / "Dotfiles"
        / "Neovim"
        / f"{VERSION}-{arch}"
        / "bin"
        / "nvim.exe"
    )


def windows_machine() -> str:
    return os.environ.get("PROCESSOR_ARCHITEW6432") or platform.machine()


def windows_config(local: Path) -> Path:
    appname = os.environ.get("NVIM_APPNAME") or "nvim"
    root = Path(os.environ.get("XDG_CONFIG_HOME") or local)
    if not root.is_absolute() or not safe_relative(appname):
        raise ValueError(
            "Expected an absolute Neovim config root and a relative NVIM_APPNAME."
        )
    return root / appname


def is_managed(config: Path) -> bool:
    marker = config / MARKER
    if linked(config) or linked(marker):
        return False
    try:
        return json.loads(marker.read_text(encoding="utf-8")).get("owner") == "dotfiles"
    except (OSError, ValueError, AttributeError):
        return False


def config_can_update(config: Path) -> bool:
    if linked(config):
        return False
    return not config.exists() or (
        config.is_dir() and (is_managed(config) or not any(config.iterdir()))
    )


@contextmanager
def publication_directory(parent: Path):
    # Windows Python gives TemporaryDirectory a private ACL. Files moved from
    # there can retain the scheduled worker's logon-only permissions.
    path = parent / f".dotfiles-neovim-{uuid4().hex}"
    path.mkdir(mode=0o777)
    try:
        yield path
    finally:
        shutil.rmtree(path)


def version_from(output: str) -> str | None:
    match = re.search(r"^NVIM v([^\s]+)", output, re.MULTILINE)
    return match[1] if match else None


def version_of(executable: Path) -> str | None:
    if not executable.is_file():
        return None
    process = subprocess.run(
        [executable, "--version"],
        capture_output=True,
        text=True,
        timeout=4,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return version_from(process.stdout) if process.returncode == 0 else None


def apply_config(config: Path, source: Path, release: dict) -> None:
    if not config_can_update(config):
        raise RuntimeError(
            f"Existing unmanaged Neovim config at {config}. Move it before applying dotfiles."
        )
    if not matches(source, release["files"]):
        raise RuntimeError(
            "The staged config is missing or changed. Run just win-sync."
        )
    if is_managed(config) and matches(config, release["files"]):
        return
    config.parent.mkdir(parents=True, exist_ok=True)
    with publication_directory(config.parent) as temp:
        staging = temp / "config"
        shutil.copytree(source, staging)
        write_json(
            staging / MARKER,
            {"owner": "dotfiles", "fingerprint": release["fingerprint"]},
        )
        if not matches(staging, release["files"]) or not config_can_update(config):
            raise RuntimeError(
                "Neovim config changed during installation. Retry after checking it."
            )
        backups = config.parent / ".dotfiles-neovim-backups"
        backup = backups / f"{config.name}-{datetime.now(UTC):%Y%m%d-%H%M%S-%f}"
        if config.exists():
            if linked(backups):
                raise ValueError("The Neovim config backup directory is linked.")
            backups.mkdir(exist_ok=True)
            config.rename(backup)
        try:
            staging.rename(config)
        except OSError:
            if backup.exists():
                backup.rename(config)
            raise


def install_binary(executable: Path, machine: str) -> None:
    if version_of(executable) == VERSION:
        return
    asset, checksum = ASSETS[architecture(machine)]
    target = executable.parent.parent
    target.parent.mkdir(parents=True, exist_ok=True)
    with publication_directory(target.parent) as staging:
        archive = staging / f"{asset}.zip"
        url = (
            f"https://github.com/neovim/neovim/releases/download/v{VERSION}/{asset}.zip"
        )
        with (
            urllib.request.urlopen(url, timeout=20) as response,
            archive.open("wb") as sink,
        ):
            shutil.copyfileobj(response, sink)
        if digest_file(archive) != checksum:
            raise RuntimeError("The Neovim release ZIP failed SHA-256 verification.")
        with ZipFile(archive) as package:
            if any(
                not safe_relative(name) or not name.startswith(asset + "/")
                for name in package.namelist()
            ):
                raise ValueError("The Neovim release ZIP has an unexpected layout.")
            package.extractall(staging)
        contents = staging / asset
        if version_of(contents / "bin" / "nvim.exe") != VERSION:
            raise RuntimeError(
                "The extracted Neovim executable reports the wrong version."
            )
        backup = staging / "previous"
        if target.exists():
            if linked(target):
                raise RuntimeError("The managed Neovim directory is linked.")
            target.rename(backup)
        try:
            contents.rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise


def windows_install() -> dict:
    local = Path(os.environ["LOCALAPPDATA"])
    config = windows_config(local)
    source, release = staged_config()
    if not config_can_update(config):
        raise RuntimeError(
            f"Existing unmanaged Neovim config at {config}. Move it before applying dotfiles."
        )
    if not matches(source, release["files"]):
        raise RuntimeError(
            "The staged Neovim config is missing or invalid. Run just win-sync."
        )
    machine = windows_machine()
    executable = windows_executable(local, machine)
    install_binary(executable, machine)
    apply_config(config, source, release)
    return windows_check()


def windows_launch() -> dict:
    local = Path(os.environ["LOCALAPPDATA"])
    executable = windows_executable(local, windows_machine())
    if (
        version_of(executable) != VERSION
        or not (windows_config(local) / "init.lua").is_file()
    ):
        raise RuntimeError(
            "Managed Windows Neovim or its config is missing. Run just win-neovim-install."
        )
    return {"executable": str(executable)}


def windows_check() -> dict:
    local = Path(os.environ["LOCALAPPDATA"])
    executable = windows_executable(local, windows_machine())
    config = windows_config(local)
    observed = version_of(executable)
    release = None
    try:
        source, release = staged_config()
        staged = matches(source, release["files"])
    except ERRORS + (KeyError, TypeError):
        staged = False
    synced = bool(staged and release and matches(config, release["files"]))
    conflict = not config_can_update(config)
    if not staged:
        detail = "Run just win-sync to stage the shared config."
    elif conflict and not synced:
        detail = f"Existing unmanaged config at {config}."
    else:
        detail = f"{executable} · {config}"
    return report(CHECKS[0], observed, synced, detail, staged and not conflict)


def report(
    check: str, version: str | None, synced: bool, detail: str, can_cure: bool
) -> dict:
    ready = version == VERSION and synced
    return {
        "id": check,
        "host": check.split("-", 1)[0],
        "state": "healthy" if ready else "failed",
        "expectedVersion": VERSION,
        "version": version,
        "configMatches": synced,
        "canCure": can_cure and not ready,
        "detail": detail,
    }


# Run only in the configured, already-running Ubuntu distro, as its default user.
GUEST_SCRIPT = r"""
import hashlib, json, os, pathlib, subprocess, sys, uuid
home = pathlib.Path.home()
if os.getuid() == 0:
    raise SystemExit('Ubuntu must use the configured non-root dotfiles account.')
root = pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config')
config = root / (os.environ.get('NVIM_APPNAME') or 'nvim')
mise = home / '.local/bin/mise'
mise_config = root / 'mise'
files = json.loads(sys.argv[3])

def matches(directory):
    return bool(files) and all((path := directory / name).is_file() and
        hashlib.sha256(path.read_bytes()).hexdigest() == expected for name, expected in files.items())

def dotfiles_config(directory):
    checkout = directory.parent
    return (directory.name == 'nvim' and (checkout / '.git').exists()
        and (checkout / 'mise/mise.lock').is_file() and (directory / 'init.lua').is_file())

checkouts = [pathlib.Path(sys.argv[4]), mise_config.resolve().parent, home / 'boku/dotfiles']
source = next((path / 'nvim' for path in checkouts
               if path.is_absolute() and dotfiles_config(path / 'nvim') and matches(path / 'nvim')), None)

def conflict():
    if config.is_symlink():
        return not dotfiles_config(config.resolve())
    return config.exists()

can_cure = mise.is_file() and source is not None and not conflict() and (mise_config / 'mise.lock').is_file()
env = dict(os.environ, MISE_AUTO_INSTALL='0')
def run(*args, timeout=8):
    return subprocess.run(args, capture_output=True, text=True, env=env, cwd=home, check=True, timeout=timeout).stdout.strip()
if sys.argv[1] == 'cure':
    if not can_cure:
        raise SystemExit('Resolve the config conflict or run the dotfiles setup first.')
    run(str(mise), 'install', '--locked', 'aqua:neovim/neovim@' + sys.argv[2], timeout=120)
    if not matches(config):
        config.parent.mkdir(parents=True, exist_ok=True)
        pending = config.with_name('.dotfiles-neovim-' + uuid.uuid4().hex)
        pending.symlink_to(source, target_is_directory=True)
        try:
            if conflict():
                raise SystemExit('The local Neovim config changed. Resolve the conflict before curing.')
            pending.replace(config)
        finally:
            pending.unlink(missing_ok=True)
exe = version = None
if mise.is_file():
    try:
        exe = run(str(mise), 'which', 'nvim')
        version = run(exe, '--version').splitlines()[0].split()[1].removeprefix('v')
    except (OSError, subprocess.SubprocessError, IndexError):
        pass
detail = f'{exe or "Neovim missing"} · {config}'
if conflict() and not matches(config):
    detail = f'Existing unmanaged config at {config}.'
elif source is None:
    detail += ' · Sync the same dotfiles revision in WSL and Windows.'
print(json.dumps({'version': version, 'synced': matches(config), 'can_cure': can_cure, 'detail': detail}))
"""


def ubuntu_check(host: WindowsHost, *, cure: bool = False) -> dict:
    distro = "Ubuntu-24.04"
    if distro.casefold() not in {item.casefold() for item in host.running_distros()}:
        return unavailable(CHECKS[1], "Ubuntu is offline.")
    try:
        _, release = staged_config()
        files = release["files"]
        checkout = release.get("checkout", "")
    except ERRORS + (KeyError, TypeError):
        files, checkout = {}, ""
    data = json.loads(
        host.command(
            host.wsl,
            "-d",
            distro,
            "--exec",
            "/usr/bin/python3",
            "-c",
            GUEST_SCRIPT,
            "cure" if cure else "check",
            VERSION,
            json.dumps(files),
            checkout,
            timeout=145 if cure else 10,
        )
    )
    return report(
        CHECKS[1],
        data["version"],
        data["synced"],
        data["detail"],
        bool(files and data["can_cure"]),
    )


def unavailable(check: str, detail: str) -> dict:
    return {**report(check, None, False, detail, False), "state": "unavailable"}


def editor_checks() -> list[dict]:
    def probe(check: str) -> dict:
        try:
            return (
                windows_check() if check == CHECKS[0] else ubuntu_check(WindowsHost())
            )
        except ERRORS + (KeyError, TypeError) as error:
            return unavailable(check, str(error).splitlines()[0][:280])

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(probe, CHECKS))


def execute_cure(state: Path, request: dict) -> dict:
    check, job_id = request["check"], request["job_id"]
    journal = Journal(state / "maintenance", job_id)
    journal("doctor-started", check_id=check, operation="cure", runner="managed")
    try:
        current = windows_check() if check == CHECKS[0] else ubuntu_check(WindowsHost())
        journal("doctor-observed", check=current)
        if current["state"] == "healthy":
            result = {"outcome": "healthy", "detail": current["detail"]}
        elif not current["canCure"]:
            result = {"outcome": "unavailable", "detail": current["detail"]}
        else:
            journal(
                "doctor-action",
                check_id=check,
                action="install-pinned-neovim-and-sync-config",
            )
            observed = (
                windows_install()
                if check == CHECKS[0]
                else ubuntu_check(WindowsHost(), cure=True)
            )
            journal("doctor-verified", state=observed["state"], check=observed)
            result = {
                "outcome": "cured" if observed["state"] == "healthy" else "unresolved",
                "detail": observed["detail"],
            }
    except ERRORS + (KeyError, TypeError) as error:
        result = {"outcome": "failed", "detail": str(error)[:480]}
    journal("doctor-finished", **result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("windows_dotfiles", type=Path)
    args = parser.parse_args()
    result = stage_config(args.checkout, args.windows_dotfiles)
    print(f"Staged Neovim {result['version']} config ({result['fingerprint'][:12]}).")
