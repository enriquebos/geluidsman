from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / ".runtime" / "apple-worker"


def configuration() -> dict[str, str]:
    values = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip()] = value.strip().strip("\"'")
    return values


def health(token: str) -> dict:
    request = urllib.request.Request("http://127.0.0.1:8000/health", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)


def stop_worker(status: dict | None, pid_file: Path) -> None:
    if status:
        if not pid_file.exists() or int(pid_file.read_text()) != status["pid"]:
            message = "The running worker is not managed by this checkout."
            raise RuntimeError(message)
        os.kill(status["pid"], signal.SIGTERM)
        for _ in range(40):
            try:
                os.kill(status["pid"], 0)
            except ProcessLookupError:
                pid_file.unlink(missing_ok=True)
                print("Apple GPU worker stopped.")
                return
            time.sleep(0.25)
        message = "Apple worker is still shutting down; retry status before restarting."
        raise RuntimeError(message)
    return


def start_worker(token: str, pid_file: Path) -> None:
    executable = ROOT / "workers" / "apple" / ".venv" / "bin" / "python"
    if not executable.exists():
        message = "Run just apple-install first."
        raise RuntimeError(message)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment.update(
        TRANSCRIPTION_DEVICE="mlx",
        TRANSCRIPTION_API_TOKEN=token,
        TRANSCRIPTION_MODEL_CACHE=str(ROOT / "data" / "models" / "apple"),
        HOST="0.0.0.0",
        HF_HUB_DISABLE_PROGRESS_BARS="1",
        TOKENIZERS_PARALLELISM="false",
    )
    with (RUNTIME / "worker.log").open("ab") as output:
        process = subprocess.Popen(
            [str(executable), "-m", "app.transcription_worker"],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_file.write_text(str(process.pid), encoding="utf-8")
    for _ in range(40):
        if process.poll() is not None:
            message = "Apple worker failed to start; see .runtime/apple-worker/worker.log."
            raise RuntimeError(message)
        try:
            status = health(token)
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.25)
            continue
        if status["pid"] != process.pid:
            process.terminate()
            message = "Port 8000 belongs to another worker."
            raise RuntimeError(message)
        print("Apple GPU worker started: " + status["phase"])
        return
    process.terminate()
    message = "Apple worker did not start its HTTP service; see .runtime/apple-worker/worker.log."
    raise RuntimeError(message)


def main() -> None:
    values = configuration()
    if "compose.apple.yaml" not in values.get("COMPOSE_FILE", ""):
        return
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        message = "The Apple worker requires native Apple Silicon macOS."
        raise RuntimeError(message)
    token = values.get("TRANSCRIPTION_API_TOKEN", "")
    if not token:
        message = "Set a random TRANSCRIPTION_API_TOKEN in .env before starting the Apple worker."
        raise RuntimeError(message)
    action = sys.argv[1]
    pid_file = RUNTIME / "worker.pid"
    try:
        status = health(token)
    except (urllib.error.URLError, TimeoutError):
        status = None
    if status and status.get("device") != "mlx":
        message = "Port 8000 is occupied by a different transcription backend."
        raise RuntimeError(message)
    if action == "status":
        print(json.dumps(status) if status else "Apple GPU worker is stopped.")
        return
    if action == "stop":
        stop_worker(status, pid_file)
        return
    if action != "start":
        message = "Expected start, stop or status."
        raise ValueError(message)
    if status:
        print("Apple GPU worker is running: " + status["phase"])
        return
    start_worker(token, pid_file)


if __name__ == "__main__":
    main()
