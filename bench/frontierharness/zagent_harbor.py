"""Harbor (Terminal-Bench) adapter for zagent — a BaseInstalledAgent."""
from __future__ import annotations

import shlex
import tempfile
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from zagent_common import (CONTAINER_LOG_DIR, DEFAULT_ROOT, INSTALL_DIR, OUTPUT_FILENAME, install_script,
                           parse_usage, run_command, usage_totals)


class ZagentAgent(BaseInstalledAgent):
    """Runs `zagent -p` against the bundled official ZCode kernel on the GLM Coding Plan."""

    def __init__(self, *args: Any, bundle_path: str = str(DEFAULT_ROOT / "zagent-runtime.tar.gz"),
                 zai_key_file: str = str(DEFAULT_ROOT / ".zai_key"), model_main: str = "zai/glm-5.3",
                 model_lite: str = "zai/glm-5.3-flash", zagent_version: str = "0.0.202",
                 **kwargs: Any) -> None:
        self._bundle_path = Path(bundle_path)
        self._key = Path(zai_key_file).read_text().strip()
        self._model_main = model_main
        self._model_lite = model_lite
        self._zagent_version = zagent_version
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "zagent"

    def version(self) -> str | None:
        return self._version or self._zagent_version

    def get_version_command(self) -> str | None:
        return f"{INSTALL_DIR}/zagent.sh --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if not self._bundle_path.is_file():
            raise FileNotFoundError(f"zagent runtime bundle not found: {self._bundle_path}")
        remote_bundle = "/tmp/zagent-runtime.tar.gz"
        await environment.upload_file(self._bundle_path, remote_bundle)
        await self.exec_as_root(environment, command=f"mkdir -p {INSTALL_DIR}")
        with tempfile.NamedTemporaryFile("w", delete=False) as fh:
            fh.write(self._key)
            key_file = Path(fh.name)
        try:
            await environment.upload_file(key_file, f"{INSTALL_DIR}/.key")
        finally:
            key_file.unlink(missing_ok=True)
        await self.exec_as_root(environment, command=install_script(
            remote_bundle, self._model_main, self._model_lite))

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
            fh.write(instruction)
            local = Path(fh.name)
        remote = f"{INSTALL_DIR}/instruction.md"
        try:
            await environment.upload_file(local, remote)
        finally:
            local.unlink(missing_ok=True)
        await self.exec_as_root(environment, command=run_command(remote))

    def populate_context_post_run(self, context: AgentContext) -> None:
        usage = parse_usage(self.logs_dir / OUTPUT_FILENAME)
        if not usage:
            return
        totals = usage_totals(usage)
        if totals is None:
            return
        context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens = totals
        context.metadata = {**(context.metadata or {}), "zagent_usage": usage,
                            "model_main": self._model_main, "kernel": "official-3.11.2"}
