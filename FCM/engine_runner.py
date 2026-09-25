"""Isolated bridge to the server-owned Node FCM rules engine."""

import json
import os
import shutil
import subprocess
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent / "mcp-server"
ENGINE_WORKER = ENGINE_ROOT / "engine-worker.mjs"
ENGINE_HOOK = ENGINE_ROOT / "register-hook.mjs"


class AuthoritativeEngineError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run_authoritative_engine(command, *, timeout=15):
    """Run exactly one command in a fresh process; no account credentials are passed."""
    node = shutil.which("node")
    if not node:
        raise AuthoritativeEngineError("ENGINE_UNAVAILABLE", "Node.js is not installed")

    try:
        completed = subprocess.run(
            [node, "--import", str(ENGINE_HOOK), str(ENGINE_WORKER)],
            input=json.dumps(command, separators=(",", ":")),
            text=True,
            capture_output=True,
            cwd=ENGINE_ROOT,
            env={"PATH": os.environ.get("PATH", ""), "NODE_ENV": "production"},
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AuthoritativeEngineError("ENGINE_TIMEOUT", "FCM engine timed out") from exc
    except OSError as exc:
        raise AuthoritativeEngineError("ENGINE_UNAVAILABLE", "FCM engine could not start") from exc

    try:
        payload = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise AuthoritativeEngineError(
            "ENGINE_FAILURE", "FCM engine returned an invalid response"
        ) from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        raise AuthoritativeEngineError(
            error.get("code", "ENGINE_FAILURE"),
            error.get("message", "FCM engine failed"),
        )
    if completed.returncode != 0 or not isinstance(payload.get("result"), dict):
        raise AuthoritativeEngineError("ENGINE_FAILURE", "FCM engine failed")
    return payload["result"]
