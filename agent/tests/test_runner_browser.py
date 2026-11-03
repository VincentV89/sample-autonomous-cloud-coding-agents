"""Exercise actual runner registration, redacted trajectory and finally cleanup."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

import browser_tools as bt
import runner
from models import TaskConfig


@pytest.mark.parametrize(
    "failure", [None, RuntimeError("SDK disconnected"), asyncio.CancelledError()]
)
def test_runner_closes_browser_for_completion_failure_and_cancellation(
    monkeypatch, tmp_path, failure, capsys
):
    import claude_agent_sdk as sdk

    config = TaskConfig(
        repo_url="owner/repo",
        task_id="task-browser-1",
        aws_region="us-east-1",
        resolved_workflow={"id": "coding/new-task-v1"},
    )
    monkeypatch.setenv(bt.BROWSER_ENABLED_ENV, "true")
    monkeypatch.setattr(runner, "_setup_agent_env", lambda *_a: None)
    monkeypatch.setattr(runner, "_log_claude_cli_version", lambda: None)
    monkeypatch.setattr(
        runner, "_initialize_policy_engine_and_hooks", lambda **_k: (MagicMock(), {})
    )
    monkeypatch.setattr(runner, "_register_gateway_server", lambda *_a: None)
    monkeypatch.setattr(runner, "_ProgressWriter", MagicMock())
    controller = MagicMock()
    controller.close = AsyncMock()
    monkeypatch.setattr(runner, "BrowserTools", lambda *_a: controller)
    monkeypatch.setattr(
        runner, "build_browser_server", lambda *_a: {"type": "sdk", "name": bt.BROWSER_SERVER_NAME}
    )

    async def messages():
        yield sdk.AssistantMessage(
            content=[
                sdk.ToolUseBlock(
                    id="tool-1",
                    name=bt.BROWSER_TOOL_NAME,
                    input={"action": "fill", "text": "secret-form-value"},
                )
            ],
            model="test-model",
        )
        if failure:
            raise failure

    client = MagicMock()
    client.connect = AsyncMock()
    client.query = AsyncMock()
    client.receive_response = messages
    factory = MagicMock(return_value=client)
    monkeypatch.setattr(sdk, "ClaudeSDKClient", factory)
    trajectory = MagicMock()
    call = runner.run_agent(
        "Test preview", "Instructions", config, str(tmp_path), trajectory=trajectory
    )
    if isinstance(failure, asyncio.CancelledError):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(call)
    else:
        asyncio.run(call)
    controller.close.assert_awaited_once()
    options = factory.call_args.kwargs["options"]
    assert bt.BROWSER_TOOL_NAME in options.allowed_tools
    assert bt.BROWSER_SERVER_NAME in options.mcp_servers
    assert "managed Chromium" in options.system_prompt
    assert "secret-form-value" not in str(trajectory.write_turn.call_args_list)
    assert "secret-form-value" not in capsys.readouterr().out
