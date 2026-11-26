import os
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

HERDR = Path(__file__).resolve().parents[1]
SOURCE = """
fn main() {
    print!("{}|{}|{}", env!("HERDR_SOURCE_COMMIT"),
        env!("HERDR_UPSTREAM_VERSION"), env!("HERDR_UPSTREAM_COMMIT"));
}
"""


def command(path: Path, *args: str, **env: str) -> str:
    inherited = os.environ.copy()
    for name in ("HERDR_BUILD_COMMIT", "HERDR_SOURCE_COMMIT", "CARGO_TARGET_DIR"):
        inherited.pop(name, None)
    return subprocess.check_output(
        args, cwd=path, env=inherited | env, text=True
    ).strip()


def crate(root: Path) -> Path:
    path = root / "herdr"
    (path / "src").mkdir(parents=True)
    (path / ".gitignore").write_text("/target\n")
    (path / "Cargo.toml").write_text(
        '[package]\nname = "herdr-probe"\nversion = "0.0.0"\nedition = "2021"\n'
    )
    (path / "src/main.rs").write_text(SOURCE)
    shutil.copyfile(HERDR / "build.rs", path / "build.rs")
    shutil.copyfile(HERDR / "UPSTREAM.md", path / "UPSTREAM.md")
    command(path, "cargo", "generate-lockfile", "--offline")
    return path


def read_stamp(path: Path, **env: str) -> list[str]:
    return command(path, "cargo", "run", "--quiet", "--offline", **env).split("|")


class BuildProvenanceTest(unittest.TestCase):
    def test_checkout_tracks_source_changes_and_reverts(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = crate(root)
            command(root, "git", "init", "-q")
            command(root, "git", "add", ".")
            command(
                root,
                "git",
                "-c",
                "user.email=herdr-test@example.invalid",
                "-c",
                "user.name=Herdr Test",
                "commit",
                "-qm",
                "fixture",
            )
            commit = command(root, "git", "rev-parse", "HEAD")
            committed_stamp = read_stamp(path, HERDR_BUILD_COMMIT=commit)
            self.assertEqual(committed_stamp[0], commit)

            source = path / "src/main.rs"
            source.write_text(SOURCE + "\n// changed after commit\n")
            self.assertEqual(read_stamp(path, HERDR_BUILD_COMMIT=commit)[0], "")
            source.write_text(SOURCE)
            self.assertEqual(
                read_stamp(path, HERDR_BUILD_COMMIT=commit), committed_stamp
            )

            upstream = path / "UPSTREAM.md"
            upstream.write_text(
                upstream.read_text()
                .replace(
                    f"- Upstream version: `{committed_stamp[1]}`",
                    "- Upstream version: `v9.8.7`",
                )
                .replace(
                    f"- Upstream commit: `{committed_stamp[2]}`",
                    f"- Upstream commit: `{'b' * 40}`",
                )
            )
            self.assertEqual(read_stamp(path), ["", "v9.8.7", "b" * 40])

    def test_archive_ignores_ambient_internal_stamp(self) -> None:
        with TemporaryDirectory() as tmp:
            path = crate(Path(tmp))
            self.assertEqual(read_stamp(path, HERDR_SOURCE_COMMIT="ambient")[0], "")
            self.assertEqual(
                read_stamp(path, HERDR_BUILD_COMMIT="a" * 40)[0],
                "a" * 40,
            )
