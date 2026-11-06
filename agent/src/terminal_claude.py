#!/app/.venv/bin/python -I
"""Image-owned launcher for independent interactive Claude conversations.

The attached shell need not inherit the runner's environment. Only non-secret
region/model settings cross that boundary; managed awsCredentialExport still
owns credential resolution. The SDK's bundled CLI is not replaced.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import cast

CONFIG_PATH = Path("/home/agent/.abca-terminal.json")
REAL_CLAUDE = "/usr/local/libexec/abca-claude"
_CONFIG_KEYS = {"aws_region", "model", "haiku_model"}
_MAX_CONFIG_BYTES = 8192
_REGION = re.compile(r"[a-z]{2}(?:-[a-z]+)+-\d+")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}")


def _validate(config: object) -> dict[str, str]:
    if not isinstance(config, dict):
        raise ValueError("Invalid terminal configuration schema")
    values = cast("dict[str, object]", config)
    if set(values) != _CONFIG_KEYS:
        raise ValueError("Invalid terminal configuration schema")
    result: dict[str, str] = {}
    for key in _CONFIG_KEYS:
        value = values[key]
        pattern = _REGION if key == "aws_region" else _MODEL
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise ValueError("Invalid terminal region/model configuration")
        result[key] = value
    return result


def write_terminal_config(*, aws_region: str, model: str, haiku_model: str) -> None:
    """Atomically publish an allowlisted snapshot of the resolved task settings.

    Never dump os.environ or TaskConfig: both contain credentials. Invalidate
    the prior snapshot on failure so a later invocation cannot use stale pins.
    """
    temporary: Path | None = None
    try:
        data = _validate({"aws_region": aws_region, "model": model, "haiku_model": haiku_model})
        with tempfile.NamedTemporaryFile(
            mode="w", dir=CONFIG_PATH.parent, prefix=".abca-terminal-", delete=False
        ) as stream:
            temporary = Path(stream.name)
            # NamedTemporaryFile creates mode 0600, including before the rename.
            json.dump(data, stream)
        os.replace(temporary, CONFIG_PATH)
    except (OSError, ValueError):
        CONFIG_PATH.unlink(missing_ok=True)
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def terminal_environment() -> dict[str, str]:
    """Read trusted-path data, never project settings or executable shell text."""
    with CONFIG_PATH.open() as stream:
        contents = stream.read(_MAX_CONFIG_BYTES + 1)
    if len(contents) > _MAX_CONFIG_BYTES:
        raise ValueError("Terminal configuration is too large")
    config = _validate(json.loads(contents))
    env = dict(os.environ)
    env.update(
        {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": config["aws_region"],
            "AWS_DEFAULT_REGION": config["aws_region"],
            "ANTHROPIC_MODEL": config["model"],
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": config["haiku_model"],
        }
    )
    env.pop("ANTHROPIC_LOG", None)
    return env


def main() -> int:
    args = sys.argv[1:]
    # Version/help probes work before any task has initialized the container.
    # In particular, runner._log_claude_cli_version and the image build use this.
    if args in (["--version"], ["-v"], ["--help"], ["-h"]):
        env = dict(os.environ)
    else:
        try:
            env = terminal_environment()
        except (OSError, ValueError):
            print(
                "Claude terminal settings are unavailable. "
                "Wait for the task to initialize, then retry claude.",
                file=sys.stderr,
            )
            return 78
    try:
        # Fixed image-owned target; no PATH lookup, shell interpolation or flags
        # added to the user's arguments. exec preserves signals and exit codes.
        os.execve(REAL_CLAUDE, [REAL_CLAUDE, *args], env)  # noqa: S606 -- fixed image-owned executable
    except OSError:
        print("The image-owned Claude binary is unavailable.", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main())
