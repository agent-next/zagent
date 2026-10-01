"""Pier (DeepSWE) adapter for zagent.

Pier isolates the task network and exposes the provider through an authenticated
proxy (HTTPS_PROXY in the agent env); NODE_USE_ENV_PROXY=1 in the wrapper makes the
kernel's fetch honor it. The mcode profile's pattern: a Pier BaseAgent wrapper that
delegates install/run to the Harbor adapter, with Pier's own exec plumbing.
"""
from __future__ import annotations

from typing import Any

from pier.agents.base import BaseAgent
from pier.agents.installed.base import BaseInstalledAgent as PierInstalledAgent
from pier.models.agent.network import NetworkAllowlist

from zagent_harbor import ZagentAgent as HarborZagent


class _PierZagent(HarborZagent):
    async def _exec(self, environment, command, **kwargs):
        return await PierInstalledAgent._exec(self, environment, command, **kwargs)


class ZagentAgent(BaseAgent):
    """Leave task execution, resource limits and verification to Pier."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._inner = _PierZagent(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "zagent"

    def version(self) -> str | None:
        return self._inner.version()

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=["api.z.ai"])

    async def setup(self, environment) -> None:
        await self._inner.setup(environment)

    async def run(self, instruction: str, environment, context) -> None:
        try:
            await self._inner.run(instruction, environment, context)
        finally:
            self._inner.populate_context_post_run(context)
