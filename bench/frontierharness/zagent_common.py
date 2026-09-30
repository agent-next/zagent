"""Shared pieces of the zagent FrontierHarness adapters (Harbor + Pier).

zagent is installed inside the task container from a prebuilt bundle (Node 22 +
the zagent npm package + the official ZCode kernel copied from a licensed desktop
install), so no package download happens at task time. The kernel is driven by
`zagent -p "<instruction>" --json`; the usage block of that JSON is the cost evidence.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# Working root holding the bundle and key file; override with FH_ROOT.
DEFAULT_ROOT = Path(os.environ.get("FH_ROOT", str(Path.home() / "frontierharness")))
INSTALL_DIR = "/installed-agent/zagent"
OUTPUT_FILENAME = "zagent.json"
STDERR_FILENAME = "zagent.stderr"
CONTAINER_LOG_DIR = "/logs/agent"


def install_script(bundle_remote: str, model_main: str, model_lite: str) -> str:
    """Shell that unpacks the bundle, writes the Coding Plan config and a wrapper.

    The Coding Plan key is uploaded separately to INSTALL_DIR/.key and never placed in
    a command line: Harbor logs exec commands and copies them into exception records.
    """
    node = f"{INSTALL_DIR}/node/bin/node"
    zagent = f"{INSTALL_DIR}/prefix/lib/node_modules/zagent/bin/zagent"
    config_patch = (
        f"{node} -e '"
        "const fs=require(\"fs\");const p=process.argv[1];"
        "const c=JSON.parse(fs.readFileSync(p,\"utf8\"));"
        "c.model=c.model||{};c.model.main=process.argv[2];c.model.lite=process.argv[3];"
        "fs.writeFileSync(p,JSON.stringify(c,null,2));' "
        f"\"$HOME/.zcode/cli/config.json\" {model_main} {model_lite}"
    )
    wrapper = "\n".join([
        "#!/bin/sh",
        f"export PATH={INSTALL_DIR}/node/bin:{INSTALL_DIR}/prefix/bin:$PATH",
        f"export ZCODE_RUNTIME={INSTALL_DIR}/kernel/zcode.cjs",
        f"export ZAI_API_KEY=\"$(cat {INSTALL_DIR}/.key)\"",
        "export NODE_USE_ENV_PROXY=1",
        f"exec {node} {zagent} \"$@\"",
    ])
    return " && ".join([
        "set -e",
        f"mkdir -p {INSTALL_DIR}",
        f"tar -xzf {bundle_remote} -C {INSTALL_DIR}",
        f"rm -f {bundle_remote}",
        f"test -s {INSTALL_DIR}/.key",
        f"chmod 600 {INSTALL_DIR}/.key",
        f"printf '%s\\n' '{wrapper}' > {INSTALL_DIR}/zagent.sh",
        f"chmod 755 {INSTALL_DIR}/zagent.sh",
        f"{INSTALL_DIR}/zagent.sh --version",
        f"{INSTALL_DIR}/zagent.sh doctor --fix",
        config_patch,
        f"{INSTALL_DIR}/zagent.sh doctor",
    ])


def run_command(instruction_remote: str) -> str:
    """Run one headless turn in the task's working directory, keeping the JSON."""
    return (
        "cd /app 2>/dev/null || cd \"$HOME\"; "
        f"mkdir -p {CONTAINER_LOG_DIR}; "
        f"{INSTALL_DIR}/zagent.sh -p \"$(cat {instruction_remote})\" --json "
        f"> {CONTAINER_LOG_DIR}/{OUTPUT_FILENAME} 2> {CONTAINER_LOG_DIR}/{STDERR_FILENAME}"
    )


def parse_usage(output_path: Path) -> dict | None:
    """Return the usage block of the last JSON object zagent printed, or None."""
    if not output_path.exists():
        return None
    text = output_path.read_text(errors="replace").strip()
    if not text:
        return None
    # zagent prints one JSON document; tolerate leading noise by scanning from the
    # last opening brace at column 0.
    for candidate in (text, text[text.rfind("\n{") + 1:] if "\n{" in text else text):
        try:
            doc = json.loads(candidate)
        except ValueError:
            continue
        usage = doc.get("usage") if isinstance(doc, dict) else None
        if isinstance(usage, dict):
            usage = dict(usage)
            usage["_sessionId"] = doc.get("sessionId")
            usage["_response_chars"] = len(doc.get("response") or "")
            return usage
    return None


def usage_totals(usage: dict) -> tuple[int, int, int] | None:
    """(input incl. cache, cache read, output) as non-negative ints, or None."""
    def as_int(key: str) -> int | None:
        value = usage.get(key)
        return value if isinstance(value, int) and value >= 0 else None

    fresh, cached, out = as_int("inputTokens"), as_int("cacheReadTokens"), as_int("outputTokens")
    if fresh is None or out is None:
        return None
    cached = cached or 0
    return fresh + cached, cached, out
