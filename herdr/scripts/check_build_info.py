"""Compare a native package's provenance with the release inputs."""

import json
import os
import subprocess
import sys
from pathlib import Path


def main(executable: str) -> None:
    upstream = {}
    path = Path(__file__).resolve().parents[1] / "UPSTREAM.md"
    for line in path.read_text(encoding="utf-8").splitlines():
        label, _, value = line.partition(": ")
        if label in ("- Upstream version", "- Upstream commit"):
            upstream[label] = value.strip("`")
    expected = {
        "source": "Unique-Divine/dotfiles",
        "commit": os.environ["HERDR_BUILD_COMMIT"],
        "update_provider": "dotfiles",
        "upstream_baseline": upstream["- Upstream version"],
        "upstream_commit": upstream["- Upstream commit"],
    }
    output = subprocess.check_output([executable, "build-info", "--json"], text=True)
    actual = json.loads(output)
    for key, value in expected.items():
        if actual.get(key) != value:
            raise SystemExit(f"Expected {key}={value!r}, got {actual.get(key)!r}")


if __name__ == "__main__":
    main(sys.argv[1])
