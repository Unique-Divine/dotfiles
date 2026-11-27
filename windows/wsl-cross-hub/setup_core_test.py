from pathlib import Path

import pytest
from setup_core import publish_worker


@pytest.fixture
def worker_source(tmp_path: Path) -> Path:
    source = tmp_path / "worker.py"
    source.write_bytes(b"worker contents\r\n")
    return source


def test_publish_and_reuse_worker(worker_source: Path, tmp_path: Path) -> None:
    app = tmp_path / "state with spaces" / "app"
    publish_worker(worker_source, app)
    publish_worker(worker_source, app)
    worker = app / "worker.py"
    assert worker.read_bytes() == worker_source.read_bytes()
    assert list(app.iterdir()) == [worker]


def test_refuse_to_overwrite_existing_worker(
    worker_source: Path, tmp_path: Path
) -> None:
    app = tmp_path / "app"
    app.mkdir()
    worker = app / "worker.py"
    worker.write_bytes(b"a different worker")
    with pytest.raises(ValueError, match="A different worker is already installed"):
        publish_worker(worker_source, app)
    assert worker.read_bytes() == b"a different worker"
    assert list(app.iterdir()) == [worker]


def test_refuse_linked_app(worker_source: Path, tmp_path: Path) -> None:
    app = tmp_path / "app"
    target = tmp_path / "different"
    target.mkdir()
    try:
        app.symlink_to(target, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Cannot create a symlink for this test: {error}")
    with pytest.raises(ValueError, match="stable app directory"):
        publish_worker(worker_source, app)
    assert not list(target.iterdir())


def test_refuse_linked_worker(worker_source: Path, tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.mkdir()
    worker = app / "worker.py"
    try:
        worker.symlink_to(worker_source)
    except OSError as error:
        pytest.skip(f"Cannot create a symlink for this test: {error}")
    with pytest.raises(ValueError, match="A different worker is already installed"):
        publish_worker(worker_source, app)
    assert worker.is_symlink()


def test_publish_worker_with_runtime(worker_source: Path, tmp_path: Path) -> None:
    app = tmp_path / "app"
    runtime = tmp_path / "maintenance_runtime.py"
    runtime.write_bytes(b"runtime contents\r\n")
    publish_worker(worker_source, app, companions=(runtime,))
    publish_worker(worker_source, app, companions=(runtime,))
    assert {file.name for file in app.iterdir()} == {"worker.py", runtime.name}
    assert (app / runtime.name).read_bytes() == runtime.read_bytes()
