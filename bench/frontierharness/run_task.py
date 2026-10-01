#!/usr/bin/env python3
"""Run one FrontierHarness task through the zagent adapter.

Terminal-Bench tasks go through Harbor, DeepSWE (datacurve/*) tasks through Pier —
the same split the published baselines and the mcode profile use. This is the
--cmd hook of run-local-trials.sh; it does not score. Native runner results stay
intact; a top-level jobs/result.json exposes the verifier reward for the official
extractor, as the mcode profile does.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from zagent_common import DEFAULT_ROOT

HERE = Path(__file__).resolve().parent


def configuration(root: Path, suite: str, task: str, model: str, jobs: Path,
                  model_lite: str, bundle: Path, key_file: Path) -> tuple[str, dict]:
    if Path(task).name != task:
        raise ValueError("task must be a bare task name")
    if suite == "terminal-bench":
        task_path, runner, import_path = root / "terminal-bench-2" / task, "harbor", "zagent_harbor:ZagentAgent"
    elif suite == "datacurve":
        task_path, runner, import_path = root / "deep-swe" / "tasks" / task, "pier", "zagent_pier:ZagentAgent"
    else:
        raise ValueError(f"unknown suite {suite!r}")
    if not (task_path / "task.toml").is_file():
        raise FileNotFoundError(task_path / "task.toml")
    agent = {
        "import_path": import_path,
        "model_name": model,
        "kwargs": {
            "bundle_path": str(bundle),
            "zai_key_file": str(key_file),
            "model_main": model,
            "model_lite": model_lite,
        },
    }
    config = {
        "job_name": task,
        "jobs_dir": str(jobs),
        "tasks": [{"path": str(task_path)}],
        "agents": [agent],
        "n_concurrent_trials": 1,
        "n_attempts": 1,
        "retry": {"max_retries": 0},
        "environment": {"type": "docker", "delete": True},
    }
    return runner, config


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--suite", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--model", default="zai/glm-5.3")
    ap.add_argument("--model-lite", default="zai/glm-5.3-flash")
    ap.add_argument("--jobs", type=Path, required=True)
    ap.add_argument("--bundle", type=Path, default=DEFAULT_ROOT / "zagent-runtime.tar.gz")
    ap.add_argument("--key-file", type=Path, default=DEFAULT_ROOT / ".zai_key")
    ap.add_argument("--print-config", action="store_true")
    a = ap.parse_args()
    runner, config = configuration(a.root, a.suite, a.task, a.model, a.jobs, a.model_lite, a.bundle, a.key_file)
    if a.print_config:
        print(json.dumps({"runner": runner, "config": config}, indent=2))
        return
    if (a.jobs / a.task).exists():
        raise SystemExit("This task already has a job; preserve its first attempt.")
    a.jobs.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(config, fh)
        config_path = fh.name
    env = {**os.environ, "PYTHONPATH": f"{HERE}{os.pathsep}{os.environ.get('PYTHONPATH', '')}".rstrip(os.pathsep)}
    try:
        previous = signal.signal(signal.SIGTERM, lambda *_: None)
        try:
            proc = subprocess.Popen([runner, "run", "--config", config_path], env=env)
            (a.jobs / "native-process.json").write_text(json.dumps({"pid": proc.pid, "runner": runner}) + "\n")
            proc.wait()
        finally:
            signal.signal(signal.SIGTERM, previous)
        records = list((a.jobs / a.task).glob("*/result.json"))
        if len(records) == 1:
            native = json.loads(records[0].read_text())
            rewards = (native.get("verifier_result") or {}).get("rewards") or {}
            record = {"reward": rewards.get("reward"), "native_result": str(records[0]),
                      "exception_info": native.get("exception_info")}
            target = a.jobs / "result.json"
            tmp = target.with_suffix(".tmp")
            tmp.write_text(json.dumps(record, indent=2) + "\n")
            tmp.replace(target)
        raise SystemExit(proc.returncode)
    finally:
        Path(config_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
