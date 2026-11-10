"""Exercise the production SDK options and pinned transport's message-size cap."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import claude_agent_sdk as sdk
import pytest
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

import runner
from models import TaskConfig


@pytest.fixture
def sdk_options(monkeypatch, tmp_path) -> sdk.ClaudeAgentOptions:
    """Capture real runner options without launching a CLI or making AWS calls."""
    monkeypatch.setattr(runner, "_setup_agent_env", lambda *_a: None)
    monkeypatch.setattr(runner, "_log_claude_cli_version", lambda: None)
    monkeypatch.setattr(
        runner, "_initialize_policy_engine_and_hooks", lambda **_k: (MagicMock(), {})
    )
    monkeypatch.setattr(runner, "_register_gateway_server", lambda *_a: None)
    monkeypatch.setattr(runner, "browser_enabled", lambda *_a: False)
    monkeypatch.setattr(runner, "_ProgressWriter", MagicMock())

    async def messages():
        yield sdk.SystemMessage(subtype="init", data={})

    client = MagicMock()
    client.connect = AsyncMock()
    client.query = AsyncMock()
    client.disconnect = AsyncMock()
    client.receive_response = messages
    factory = MagicMock(return_value=client)
    monkeypatch.setattr(sdk, "ClaudeSDKClient", factory)
    config = TaskConfig(
        repo_url="owner/repo", task_id="buffer-test", aws_region="us-east-1", read_only=True
    )
    asyncio.run(
        runner.run_agent("Test", "Instructions", config, str(tmp_path), trajectory=MagicMock())
    )
    options = factory.call_args.kwargs["options"]
    assert options.max_buffer_size == 10 * 1024 * 1024
    return options


@pytest.mark.parametrize("payload_bytes", [2 * 1024 * 1024, 10 * 1024 * 1024])
def test_sdk_transport_enforces_runner_buffer(monkeypatch, sdk_options, payload_bytes):
    # Generate fixtures in memory. Fragment stdout so the test also exercises
    # buffering a message across chunks, as the actual CLI pipe does.
    message = {"type": "user", "content": "x" * payload_bytes}
    wire = json.dumps(message) + "\n"
    chunk_size = 128 * 1024

    async def stdout():
        for offset in range(0, len(wire), chunk_size):
            yield wire[offset : offset + chunk_size]

    async def read():
        transport = SubprocessCLITransport(prompt="Test", options=sdk_options)
        monkeypatch.setattr(transport, "_process", MagicMock(wait=AsyncMock(return_value=0)))
        monkeypatch.setattr(transport, "_stdout_stream", stdout())
        return [event async for event in transport.read_messages()]

    if payload_bytes < 10 * 1024 * 1024:
        assert asyncio.run(read()) == [message]
    else:
        # The JSON envelope makes the second frame larger than the 10 MiB cap.
        with pytest.raises(sdk.CLIJSONDecodeError, match="maximum buffer size of 10485760"):
            asyncio.run(read())
