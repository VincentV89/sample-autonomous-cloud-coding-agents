"""Browser target isolation, credentials, evidence, lifecycle and SDK registration."""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from botocore.credentials import Credentials

import browser_tools as bt
from models import TaskConfig


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def controller(tmp_path, monkeypatch):
    monkeypatch.delenv("TRACE_ARTIFACTS_BUCKET_NAME", raising=False)
    tool = bt.BrowserTools("task-browser-1", "us-east-1", str(tmp_path), MagicMock())
    yield tool
    run(tool.close())


def page_ready(tool):
    locator = MagicMock()
    locator.aria_snapshot = AsyncMock(return_value='- button "Register"')
    locator.get_attribute = AsyncMock(return_value="text")
    locator.fill = AsyncMock()
    locator.click = AsyncMock()
    locator.first.wait_for = AsyncMock()
    page = MagicMock(url="https://example.com/app?token=hidden")
    page.locator.return_value = locator
    page.get_by_label.return_value = locator
    page.get_by_role.return_value = locator
    page.get_by_text.return_value = locator
    page.goto = AsyncMock(return_value=SimpleNamespace(status=200))
    page.screenshot = AsyncMock(return_value=b"image")
    tool.page = page
    tool.session_id = "session-one"
    tool.client = MagicMock()
    tool.deadline = time.monotonic() + 100
    return page, locator


def allow_public(monkeypatch):
    monkeypatch.setattr(bt, "public_url", AsyncMock(side_effect=lambda value: value))


def test_feature_and_workflow_gates(monkeypatch):
    config = TaskConfig(
        repo_url="owner/repo",
        aws_region="us-east-1",
        resolved_workflow={"id": "coding/new-task-v1"},
    )
    assert not bt.browser_enabled(config)
    monkeypatch.setenv(bt.BROWSER_ENABLED_ENV, "true")
    assert bt.browser_enabled(config)
    config.read_only = True
    assert not bt.browser_enabled(config)
    config.read_only = False
    config.resolved_workflow = {"id": "knowledge/web-research-v1"}
    assert not bt.browser_enabled(config)


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "https://127.0.0.1",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.1",
        "https://[::1]",
        "https://224.0.0.1",
        "https://localhost",
        "https://example.com:8443",
        "https://example.com\n",
    ],
)
def test_rejects_non_public_targets(url):
    with pytest.raises(bt.BrowserProblem):
        run(bt.public_url(url))


def test_rejects_private_dns_and_mixed_answer_sets(monkeypatch):
    async def check():
        resolver = AsyncMock(
            return_value=[
                (None, None, None, None, ("1.1.1.1", 443)),
                (None, None, None, None, ("10.0.0.1", 443)),
            ]
        )
        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver)
        with pytest.raises(bt.BrowserProblem):
            await bt.public_url("https://example.com")
        resolver.return_value = [(None, None, None, None, ("1.1.1.1", 443))]
        assert await bt.public_url("https://example.com") == "https://example.com"

    run(check())


def test_redirect_and_subresource_requests_are_validated(controller):
    route = MagicMock()
    route.request.url = "https://169.254.169.254/latest/meta-data"
    route.abort = AsyncMock()
    route.continue_ = AsyncMock()
    run(controller._route(route))
    route.abort.assert_awaited_once()
    route.continue_.assert_not_awaited()


def test_snapshot_and_url_diagnostics_are_bounded(controller):
    _page, locator = page_ready(controller)
    locator.aria_snapshot.return_value = "x" * (bt.MAX_SNAPSHOT + 100)
    result = run(controller.invoke({"action": "snapshot"}))
    assert result["success"]
    assert len(result["snapshot"]) == bt.MAX_SNAPSHOT
    assert "token=hidden" not in json.dumps(result)
    assert "token=hidden" not in (controller.directory / "checks.json").read_text()


def test_real_assertion_failure_is_not_reported_as_pass(controller):
    _, locator = page_ready(controller)
    locator.first.wait_for.side_effect = TimeoutError("signed-url-sensitive-detail")
    result = run(controller.invoke({"action": "assert_text", "text": "Success"}))
    assert result["success"] is False
    assert "signed-url-sensitive-detail" not in json.dumps(result)
    assert controller.events[-1]["success"] is False


def test_fill_password_requires_file_and_never_returns_or_persists_value(controller, tmp_path):
    _, locator = page_ready(controller)
    locator.get_attribute.return_value = "password"
    result = run(
        controller.invoke({"action": "fill", "selector": "#password", "text": "do-not-log"})
    )
    assert not result["success"]
    locator.fill.assert_not_awaited()
    secret = __import__("uuid").uuid4().hex
    (tmp_path / "test-account.json").write_text(json.dumps({"password": secret}))
    result = run(
        controller.invoke(
            {
                "action": "fill_secret",
                "selector": "#password",
                "secret_file": "test-account.json",
                "secret_key": "password",
            }
        )
    )
    assert result["success"]
    locator.fill.assert_awaited_once_with(secret, timeout=10000)
    assert secret not in json.dumps(result)
    assert secret not in (controller.directory / "checks.json").read_text()
    locator.aria_snapshot.return_value = "Page accidentally displayed " + secret
    result = run(controller.invoke({"action": "snapshot"}))
    assert secret not in result["snapshot"]


def test_credential_file_escape_and_symlink_are_blocked(controller, tmp_path):
    page_ready(controller)
    outside = tmp_path.parent / "outside-credential"
    outside.write_text("not-readable")
    (tmp_path / "escape").symlink_to(outside)
    for name in ["../outside-credential", str(outside), "escape"]:
        result = run(
            controller.invoke(
                {"action": "fill_secret", "selector": "#password", "secret_file": name}
            )
        )
        assert not result["success"]
        assert "not-readable" not in json.dumps(result)


def test_screenshot_masks_credentials_and_is_uploaded_to_task_prefix(controller, monkeypatch):
    page, locator = page_ready(controller)
    controller.secrets.append("password-test-value")
    controller.secret_locators.append(locator)
    client = MagicMock()
    monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "artifact-bucket")
    monkeypatch.setattr(bt, "tenant_client", lambda *_a, **_k: client)
    result = run(controller.invoke({"action": "screenshot"}))
    assert result["success"]
    assert (
        result["s3_uri"] == "s3://artifact-bucket/artifacts/task-browser-1/browser/screenshot-1.jpg"
    )
    assert locator in page.screenshot.call_args.kwargs["mask"]
    assert all(
        call.kwargs["Key"].startswith("artifacts/task-browser-1/browser/")
        for call in client.put_object.call_args_list
    )


def test_evidence_failure_does_not_repeat_or_hide_a_completed_click(controller, monkeypatch):
    _, locator = page_ready(controller)
    client = MagicMock()
    client.put_object.side_effect = RuntimeError("private SDK error")
    monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "artifact-bucket")
    monkeypatch.setattr(bt, "tenant_client", lambda *_a, **_k: client)
    result = run(controller.invoke({"action": "click", "selector": "#submit"}))
    assert result["success"] and result["storage_warning"]
    locator.click.assert_awaited_once()
    assert "private SDK error" not in json.dumps(result)


def test_limits_still_allow_explicit_session_cleanup(controller):
    page_ready(controller)
    controller.calls = bt.MAX_ACTIONS
    assert not run(controller.invoke({"action": "snapshot"}))["success"]
    assert run(controller.invoke({"action": "close"}))["success"]
    controller.client.stop_browser_session.assert_called_once()


def test_missing_page_does_not_pretend_to_test(controller):
    assert not run(controller.invoke({"action": "snapshot"}))["success"]


def test_sdk_server_and_log_redaction(controller):
    server = bt.build_browser_server(controller)
    assert server["type"] == "sdk" and server["name"] == bt.BROWSER_SERVER_NAME
    secret = {"action": "fill_secret", "secret_file": "credentials.json", "text": "hidden"}
    assert "hidden" not in json.dumps(bt.browser_log_input(bt.BROWSER_TOOL_NAME, secret))
    assert bt.browser_log_input("Read", secret) == secret


def test_start_connection_failure_stops_session_and_redacts_driver_detail(controller, monkeypatch):
    import playwright.async_api as api

    client = MagicMock()
    client.meta.endpoint_url = "https://bedrock-agentcore.us-east-1.amazonaws.com"
    client.start_browser_session.return_value = {
        "sessionId": "managed-session",
        "streams": {
            "automationStream": {
                "streamEndpoint": "wss://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/managed-session/automation"
            }
        },
    }
    monkeypatch.setattr(bt, "platform_client", lambda *_a, **_k: client)
    monkeypatch.setattr(
        bt,
        "get_session",
        lambda: SimpleNamespace(
            get_credentials=lambda: Credentials("test-access", "test-secret", "test-session")
        ),
    )
    pw = MagicMock()
    pw.chromium.connect_over_cdp = AsyncMock(side_effect=RuntimeError("Authorization: test-secret"))
    pw.stop = AsyncMock()
    monkeypatch.setattr(
        api, "async_playwright", lambda: SimpleNamespace(start=AsyncMock(return_value=pw))
    )
    allow_public(monkeypatch)
    result = run(controller.invoke({"action": "navigate", "url": "https://example.com"}))
    assert not result["success"] and "test-secret" not in json.dumps(result)
    client.stop_browser_session.assert_called_once_with(
        browserIdentifier="aws.browser.v1", sessionId="managed-session"
    )
    assert (
        client.start_browser_session.call_args.kwargs["sessionTimeoutSeconds"] == bt.SESSION_SECONDS
    )


def test_successful_browser_actions_are_real_driver_calls(controller, monkeypatch):
    page, locator = page_ready(controller)
    allow_public(monkeypatch)
    for args in [
        {"action": "navigate", "url": "https://example.com"},
        {"action": "fill", "label": "Name", "text": "Example"},
        {"action": "click", "role": "button", "name": "Register"},
        {"action": "assert_text", "text": "Registered"},
    ]:
        assert run(controller.invoke(args))["success"]
    page.goto.assert_awaited_once()
    locator.fill.assert_awaited_once()
    locator.click.assert_awaited_once()
    locator.first.wait_for.assert_awaited_once()


def test_session_limit_does_not_allocate_another_remote_browser(controller, monkeypatch):
    controller.sessions = bt.MAX_SESSIONS
    allow_public(monkeypatch)
    client = MagicMock()
    monkeypatch.setattr(bt, "platform_client", client)
    assert not run(controller.invoke({"action": "navigate", "url": "https://example.com"}))[
        "success"
    ]
    client.assert_not_called()


def test_existing_cedar_hard_denial_applies_to_browser_even_with_session_approval():
    from hooks import pre_tool_use_hook
    from policy import PolicyEngine

    engine = PolicyEngine(
        task_type="new_task",
        repo="owner/repo",
        initial_approvals=["all_session"],
        blueprint_hard_policies=(
            '@tier("hard") @rule_id("no-browser") forbid(principal, '
            'action == Agent::Action::"invoke_tool", '
            'resource == Agent::Tool::"mcp__abca_browser__browser");'
        ),
    )
    result = run(
        pre_tool_use_hook(
            {
                "tool_name": bt.BROWSER_TOOL_NAME,
                "tool_input": {"action": "click", "selector": "#submit"},
            },
            "tool-1",
            {},
            engine=engine,
        )
    )
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_cancelled_browser_operation_is_closed_by_task_cleanup(controller, monkeypatch):
    page, _locator = page_ready(controller)
    allow_public(monkeypatch)
    page.goto.side_effect = asyncio.CancelledError()

    async def task():
        try:
            await controller.invoke({"action": "navigate", "url": "https://example.com"})
        finally:
            await controller.close()

    with pytest.raises(asyncio.CancelledError):
        run(task())
    controller.client.stop_browser_session.assert_called_once()
    assert not controller.directory.exists()


def test_malformed_browser_arguments_cannot_leak_through_log_action():
    for action in ["not-an-action-private-value", ["private-value"], None]:
        output = bt.browser_log_input(bt.BROWSER_TOOL_NAME, {"action": action})
        assert output["action"] == "unknown"
        assert "private-value" not in json.dumps(output)


def test_evidence_sdk_requests_have_bounded_network_timeouts(controller, monkeypatch):
    page_ready(controller)
    monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "artifact-bucket")
    factory = MagicMock(return_value=MagicMock())
    monkeypatch.setattr(bt, "tenant_client", factory)
    assert run(controller.invoke({"action": "snapshot"}))["success"]
    config = factory.call_args.kwargs["config"]
    assert config.connect_timeout <= 5 and config.read_timeout <= 10
    assert config.retries["max_attempts"] == 1
