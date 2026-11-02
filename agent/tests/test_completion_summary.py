"""Notification reports preserve outcomes without forwarding logs or secrets."""

import json
from unittest.mock import patch

import pytest

from completion_summary import extract_completion_summary
from models import RepoSetup, TaskConfig
from prompt_builder import build_repoless_system_prompt, build_system_prompt


def report(**kwargs):
    return "Details.\n```bgagent-summary\n" + json.dumps(kwargs) + "\n```"


def test_deployment_and_blockers_are_independent():
    result = extract_completion_summary(
        report(
            summary="Preview deployed; mobile layout needs work.",
            development_url="https://example.cloudfront.net/",
            verification=["Build passed", "Preview returned HTTP 200"],
            blockers=["Mobile layout incomplete"],
        )
    )
    assert result is not None
    assert result.development_url == "https://example.cloudfront.net/"
    assert result.blockers == ["Mobile layout incomplete"]
    assert len(result.verification) == 2


def test_non_deployment_does_not_invent_checks_or_url():
    result = extract_completion_summary(report(summary="Fixed keyboard controls."))
    assert result is not None
    assert result.development_url is None
    assert result.verification == []
    assert result.blockers == []


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "https://example.com/?token=secret",
        "https://example.com/#secret",
        "https://example.com/ <!here>",
        "https://example.com:bad/",
        "https://example.com/[REDACTED-GITHUB_TOKEN]",
        "https://example.com/***",
    ],
)
def test_unsafe_preview_url_is_not_published(url):
    result = extract_completion_summary(report(summary="Work saved", development_url=url))
    assert result is not None
    assert result.development_url is None


def test_screening_before_truncation_and_after_json_unescaping():
    key = "AKIA" + "X" * 16
    token = "ghp_" + "x" * 36
    pem = "-----BEGIN PRIVATE KEY-----\n" + "a" * 1000 + "\n-----END PRIVATE KEY-----"
    result = extract_completion_summary(
        report(
            summary=pem,
            verification=[key],
            blockers=[token],
        )
    )
    assert result is not None
    dumped = result.model_dump_json()
    assert "BEGIN PRIVATE KEY" not in dumped
    assert key not in dumped
    assert token not in dumped
    assert "REDACTED" in dumped


def test_summary_limits_and_wrong_types():
    result = extract_completion_summary(
        report(
            summary="x" * 1000,
            verification=["y" * 900] * 10,
            blockers="not a list",
            development_url=123,
        )
    )
    assert result is not None
    assert len(result.summary) == 500
    assert len(result.verification) == 3
    assert all(len(v) == 200 for v in result.verification)
    assert result.blockers == []
    assert result.development_url is None


def test_private_urls_are_removed_from_prose_as_well_as_buttons():
    result = extract_completion_summary(
        report(
            summary="Open https://example.com/?X-Amz-Signature=secret for the result.",
            blockers=["See https://user:password@example.com/private"],
        )
    )
    assert result is not None
    serialized = result.model_dump_json()
    assert "secret" not in serialized
    assert "password" not in serialized
    assert "[private URL omitted]" in result.summary


@pytest.mark.parametrize("text", ["", "  ", "```bgagent-summary\n{}\n```"])
def test_missing_answer_is_omitted(text):
    assert extract_completion_summary(text) is None


def test_invalid_report_uses_screened_prose_without_inference():
    result = extract_completion_summary(
        "Deployment blocked by AccessDenied.\n```bgagent-summary\ninvalid\n```"
    )
    assert result is not None
    assert result.summary == "Deployment blocked by AccessDenied."
    assert result.development_url is None


def test_screening_failure_does_not_forward_unscreened_answer():
    with (
        patch("completion_summary.scan_tool_output", side_effect=RuntimeError("scanner failed")),
        pytest.raises(RuntimeError, match="scanner failed"),
    ):
        extract_completion_summary("Secret answer")


@pytest.mark.parametrize("source", ["slack", "api"])
def test_prompt_requests_report_only_for_slack(source):
    config = TaskConfig(
        repo_url="owner/repo", task_id="t", channel_source=source, aws_region="us-east-1"
    )
    setup = RepoSetup(repo_dir="/tmp/repo", branch="test")
    for prompt in (
        build_system_prompt(config, setup, None, ""),
        build_repoless_system_prompt(config, None, ""),
    ):
        assert ("```bgagent-summary" in prompt) == (source == "slack")
