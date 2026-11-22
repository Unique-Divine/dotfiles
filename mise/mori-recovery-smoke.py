"""Exercise the pinned Mori recovery commands in a temporary home."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import tomllib
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
MORI_PACKAGE = "github:Unique-Divine/jiyuu"
GRAPH_PROJECT = "recovery-probe"
GRAPH_SYMBOL = "recovery_probe"


def run(
    command: Sequence[str | Path],
    cwd: Path,
    env: dict[str, str],
    *,
    timeout: int = 60,
    payload: str | None = None,
) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        input=payload,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if result.returncode:
        operation = " ".join(str(part) for part in command[:3])
        raise RuntimeError(
            f"{operation} exited {result.returncode}\n"
            f"{result.stdout[-1500:]}\n{result.stderr[-1500:]}"
        )
    return result.stdout.strip()


def tool_path(name: str, mise: Path | None = None) -> Path:
    native_bun = Path.home() / ".bun/bin/bun"
    if name == "bun" and os.access(native_bun, os.X_OK):
        return native_bun.resolve()
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(f"Install {name} before running the recovery smoke test")
    executable = Path(found)
    if mise is not None and executable.parent.name == "shims":
        return Path(run([mise, "which", name], REPO, dict(os.environ))).resolve()
    return executable.resolve()


def isolated_environment(home: Path, tools: dict[str, Path]) -> dict[str, str]:
    bin_dir = home / "bin"
    bin_dir.mkdir()
    for name, source in tools.items():
        (bin_dir / name).symlink_to(source)
    for name in (
        "cargo",
        "rustc",
        "make",
        "cmake",
        "ninja",
        "cc",
        "gcc",
        "clang",
        "sudo",
        "systemctl",
        "apt",
        "brew",
    ):
        guard = bin_dir / name
        guard.write_text(
            '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MORI_RECOVERY_GUARD"\nexit 2\n',
            encoding="utf-8",
        )
        guard.chmod(0o700)
    return {
        **{
            key: value
            for key, value in os.environ.items()
            if key.lower()
            in {
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "no_proxy",
                "ssl_cert_file",
                "ssl_cert_dir",
            }
        },
        "HOME": str(home),
        "PATH": f"{bin_dir}{os.pathsep}{os.defpath}",
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "BOKU_RUNLOG": "0",
        "MORI_RECOVERY_GUARD": str(home / "unexpected-commands"),
    }


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def fingerprint(path: Path) -> tuple[int, int, int, str]:
    info = path.stat()
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return info.st_ino, info.st_size, info.st_mtime_ns, digest


def verify_mcp(entry: dict[str, Any], cwd: Path, env: dict[str, str]) -> None:
    initialize = {
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "recovery-probe", "version": "1"},
        },
    }
    query = {
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "search_graph",
            "arguments": {
                "project": GRAPH_PROJECT,
                "name_pattern": f"^{GRAPH_SYMBOL}$",
            },
        },
    }
    messages = (initialize, {"method": "notifications/initialized"}, query)
    payload = "".join(
        json.dumps({"jsonrpc": "2.0", **message}) + "\n" for message in messages
    )
    command = [entry["command"], *entry.get("args", [])]
    output = run(
        command, cwd, {**env, **entry.get("env", {})}, timeout=15, payload=payload
    )
    responses = {
        message.get("id"): message for message in map(json.loads, output.splitlines())
    }
    assert "result" in responses.get(1, {}), "Recovered Mori MCP did not initialize"
    result = responses.get(2, {}).get("result")
    assert result and not result.get("isError"), (
        "Recovered Mori MCP did not execute search_graph"
    )
    assert GRAPH_SYMBOL in json.dumps(result), (
        "Recovered Mori MCP missed fixture symbol"
    )


def exercise_clients(
    home: Path, mori: Path, env: dict[str, str], fixture: Path
) -> None:
    codex_config = home / ".codex/config.toml"
    codex_hooks = home / ".codex/hooks.json"
    claude_config = home / ".claude.json"
    claude_hooks = home / ".claude/settings.json"
    cursor_config = home / ".cursor/mcp.json"
    for path in (codex_config, claude_hooks, cursor_config):
        path.parent.mkdir()
    codex_config.write_text(
        f"""model = "fixture-model"

[hooks.state."fixture-stamp"]
trusted_hash = "sha256:unchanged"

[mcp_servers.mori-graph]
command = {json.dumps(str(mori))}

[mcp_servers.mori-graph.env]
CBM_CACHE_DIR = {json.dumps(env["CBM_CACHE_DIR"])}
CBM_RUNTIME_DIR = {json.dumps(env["CBM_RUNTIME_DIR"])}

[mcp_servers.unrelated]
url = "https://codex.example/mcp"
""",
        encoding="utf-8",
    )
    for path in (codex_hooks, claude_hooks):
        write_json(
            path,
            {
                "hooks": {
                    "SessionStart": [
                        {
                            "matcher": "startup",
                            "hooks": [
                                {"type": "command", "command": f"{mori} hook-augment"},
                                {
                                    "type": "command",
                                    "command": "fixture unrelated hook",
                                },
                            ],
                        }
                    ]
                }
            },
        )
    write_json(
        claude_config,
        {
            "mcpServers": {
                "unrelated": {"type": "http", "url": "https://claude.example/mcp"}
            },
            "fixtureSetting": True,
        },
    )
    write_json(cursor_config, {"mcpServers": {}})

    files = [codex_config, codex_hooks, claude_config, claude_hooks, cursor_config]
    preserved = {path: path.read_bytes() for path in (codex_hooks, claude_hooks)}
    after_first = None
    for attempt in (1, 2):
        run(["mise", "install", "--locked", MORI_PACKAGE], home, env)
        run(["just", "mcp-sync", "--run"], REPO, env)
        assert all(
            path.read_bytes() == initial for path, initial in preserved.items()
        ), "MCP sync changed hook settings"
        codex = tomllib.loads(codex_config.read_text(encoding="utf-8"))
        claude = json.loads(claude_config.read_text(encoding="utf-8"))
        cursor = json.loads(cursor_config.read_text(encoding="utf-8"))
        assert codex["hooks"]["state"] == {
            "fixture-stamp": {"trusted_hash": "sha256:unchanged"}
        }
        assert codex["model"] == "fixture-model"
        assert claude["fixtureSetting"] is True
        servers = [codex["mcp_servers"], claude["mcpServers"], cursor["mcpServers"]]
        assert servers[0]["unrelated"]["url"] == "https://codex.example/mcp"
        assert servers[1]["unrelated"]["url"] == "https://claude.example/mcp"
        for client, entries in zip(("Codex", "Claude", "Cursor"), servers, strict=True):
            verify_mcp(entries["mori-graph"], fixture, env)
            print(f"Pass {attempt}: {client} queried the recovered graph", flush=True)
        current = [path.read_bytes() for path in files]
        if after_first is not None:
            assert after_first == current, "Second recovery rewrote client settings"
        after_first = current


def exercise(home: Path, tools: dict[str, Path]) -> None:
    mise_config = home / ".config/mise"
    mise_config.mkdir(parents=True)
    for filename in ("config.toml", "mise.lock"):
        shutil.copy2(REPO / "mise" / filename, mise_config)
    lock = tomllib.loads((mise_config / "mise.lock").read_text(encoding="utf-8"))
    version = lock["tools"][MORI_PACKAGE][0]["version"]
    env = isolated_environment(home, tools)
    guard = Path(env["MORI_RECOVERY_GUARD"])
    install = ["mise", "install", "--locked", MORI_PACKAGE]

    run(install, home, env, timeout=180)
    mori = Path(run(["mise", "which", "mori"], home, env)).resolve()
    assert mori.is_relative_to(Path(env["XDG_DATA_HOME"]) / "mise/installs"), (
        "Mori resolved outside the temporary mise installation"
    )
    assert run([mori, "--version"], home, env) == f"mori {version}"
    binary_before = fingerprint(mori)

    # Restart recovery after installation completed but before any registration.
    run(install, home, env)
    run(["just", "mcp-sync", "--run"], REPO, env)
    assert fingerprint(mori) == binary_before, "Retry replaced the pinned binary"
    assert not any(
        (home / path).exists()
        for path in (".codex", ".claude", ".claude.json", ".cursor")
    ), "Recovery created client settings without a configured Mori registration"
    assert not guard.exists(), "Recovery invoked a build or system command"
    print(f"Resumed the {version} install before client registration", flush=True)

    cache = home / ".cache/mori/cache"
    runtime = home / "runtime"
    fixture = home / "fixture"
    cache.mkdir(parents=True, mode=0o700)
    runtime.mkdir(mode=0o700)
    fixture.mkdir()
    (fixture / "fixture.py").write_text(
        f"def {GRAPH_SYMBOL}():\n    return 42\n", encoding="utf-8"
    )
    env.update(CBM_CACHE_DIR=str(cache), CBM_RUNTIME_DIR=str(runtime))
    run([mori, "daemon", "start"], fixture, env)
    try:
        run(
            [
                mori,
                "cli",
                "index_repository",
                "--repo-path",
                fixture,
                "--name",
                GRAPH_PROJECT,
                "--mode",
                "fast",
            ],
            fixture,
            env,
        )
        databases = list(cache.rglob(f"{GRAPH_PROJECT}.db"))
        assert len(databases) == 1, "Expected one fixture graph database"
        graph = databases[0]
        graph_before = fingerprint(graph)
        exercise_clients(home, mori, env, fixture)
        assert fingerprint(graph) == graph_before, "Recovery changed the graph database"
        assert fingerprint(mori) == binary_before, "Recovery replaced the pinned binary"
        assert not guard.exists(), "Recovery invoked a build or system command"
    finally:
        run([mori, "daemon", "stop"], fixture, env)


def main() -> None:
    mise = tool_path("mise")
    tools = {
        "mise": mise,
        **{name: tool_path(name, mise) for name in ("just", "bun", "claude")},
    }
    # Keep the private daemon socket under the Unix-domain socket path limit.
    with tempfile.TemporaryDirectory(prefix="mrr-", dir="/tmp") as temporary:
        exercise(Path(temporary).resolve(), tools)


if __name__ == "__main__":
    main()
