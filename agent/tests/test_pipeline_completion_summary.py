"""End-to-end runtime wiring from final answer to atomic terminal write."""

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import pytest

from models import AgentResult, RepoSetup
from post_hooks import VerifyOutcome


@pytest.mark.parametrize("channel_source", ["slack", "api"])
@pytest.mark.parametrize("develop", [True, False])
def test_coding_final_answer_reaches_slack_task_record(channel_source, develop, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    final_answer = """Code saved but deployment blocked.
```bgagent-summary
{"summary":"Code saved; deployment blocked.",
 "blockers":["CloudFormation AccessDenied"],"verification":["Build passed"]}
```"""

    async def fake_agent(*args, **kwargs):
        return AgentResult(status="success", turns=1, num_turns=1, result_text=final_answer)

    with ExitStack() as stack:
        state = stack.enter_context(patch("pipeline.task_state"))
        stack.enter_context(patch("pipeline.task_span", return_value=MagicMock()))
        stack.enter_context(
            patch(
                "repo.setup_repo",
                return_value=RepoSetup(
                    repo_dir="/workspace/repo",
                    branch="bgagent/test",
                    build_before=True,
                ),
            )
        )
        stack.enter_context(patch("pipeline.discover_project_config"))
        stack.enter_context(patch("pipeline.build_system_prompt", return_value="prompt"))
        stack.enter_context(patch("runner.run_agent", side_effect=fake_agent))
        stack.enter_context(patch("pipeline.ensure_committed", return_value=False))
        stack.enter_context(patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)))
        stack.enter_context(patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)))
        stack.enter_context(
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/1")
        )
        stack.enter_context(patch("pipeline.get_disk_usage", return_value=0))
        stack.enter_context(patch("pipeline.print_metrics"))
        stack.enter_context(patch("development.save_development", return_value="a" * 40))
        from pipeline import run_task

        result = run_task(
            repo_url="owner/repo",
            task_description="Deploy development preview",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_id="summary-test",
            channel_source=channel_source,
            channel_metadata={"development_action": "develop"} if develop else {},
        )

    persisted = state.write_terminal.call_args.args[2]
    if channel_source == "slack":
        assert result["completion_summary"]["blockers"] == ["CloudFormation AccessDenied"]
        assert persisted["completion_summary"] == result["completion_summary"]
        assert persisted["completion_summary"]["development_url"] is None
    else:
        assert persisted["completion_summary"] is None
    # Keep the existing no-change PR answer contract separate.
    assert result["answer_text"] == ""
