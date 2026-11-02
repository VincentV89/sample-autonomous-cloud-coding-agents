"""Exercise delivery against real local Git remotes; no AWS/GitHub writes."""

import json
import re
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

import development
from models import RepoSetup, TaskConfig


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


@pytest.fixture
def workspace(tmp_path):
    origin = tmp_path / "origin.git"
    origin.mkdir()
    git(origin, "init", "--bare", "--initial-branch=main")
    repo = tmp_path / "repo"
    git(tmp_path, "clone", str(origin), str(repo))
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    (repo / "README.md").write_text("first\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "initial")
    git(repo, "push", "origin", "main")
    config = TaskConfig(
        aws_region="us-east-1",
        repo_url="owner/repo",
        task_id="test",
        branch_name="bgagent/development/test",
        channel_metadata={
            "development_action": "develop",
            "development_session_id": "test",
            "development_production_branch": "main",
        },
    )
    setup = RepoSetup(repo_dir=str(repo), branch=config.branch_name, default_branch="main")
    return config, setup, origin


def test_save_and_continue_versioned_branch(workspace, tmp_path):
    config, setup, origin = workspace
    first = development.checkout_development(config, setup.repo_dir, setup.branch)
    (Path(setup.repo_dir) / "game.txt").write_text("tetris")
    git(setup.repo_dir, "add", "game.txt")
    git(setup.repo_dir, "commit", "-m", "add game")
    sha = development.save_development(config, setup)
    assert sha != first
    assert git(origin, "rev-parse", setup.branch) == sha
    clone = tmp_path / "next"
    git(tmp_path, "clone", str(origin), str(clone))
    config.channel_metadata["development_expected_sha"] = sha
    assert development.checkout_development(config, str(clone), setup.branch) == sha
    assert (clone / "game.txt").read_text() == "tetris"


def test_unverified_push_is_not_success(workspace):
    config, setup, _ = workspace
    development.checkout_development(config, setup.repo_dir, setup.branch)
    real = development._run

    def run(repo, *args):
        if args[1] == "ls-remote":
            return "b" * 40 + "\trefs/heads/" + setup.branch
        return real(repo, *args)

    with (
        patch.object(development, "_run", side_effect=run),
        pytest.raises(RuntimeError, match="verified"),
    ):
        development.save_development(config, setup)


def test_missing_saved_branch_never_falls_back_to_main(workspace):
    config, setup, _ = workspace
    config.channel_metadata["development_expected_sha"] = "a" * 40
    with pytest.raises(RuntimeError, match="missing"):
        development.checkout_development(config, setup.repo_dir, setup.branch)


def test_promotion_freezes_commit_and_recovers_existing_pr(workspace):
    config, setup, origin = workspace
    development.checkout_development(config, setup.repo_dir, setup.branch)
    sha = development.save_development(config, setup)
    config.channel_metadata["development_expected_sha"] = sha
    real = development._run
    calls = []

    def run(repo, *args):
        calls.append(args)
        if args[:3] == ("gh", "pr", "list"):
            return json.dumps([{"url": "https://github.com/owner/repo/pull/1"}])
        return real(repo, *args)

    with patch.object(development, "_run", side_effect=run):
        assert development.promote_development(config, setup) == (
            "https://github.com/owner/repo/pull/1",
            sha,
        )
    assert git(origin, "rev-parse", "bgagent/releases/test") == sha
    assert not any(args[:3] == ("gh", "pr", "create") for args in calls)


def test_existing_release_at_another_revision_is_never_overwritten(workspace):
    config, setup, _ = workspace
    development.checkout_development(config, setup.repo_dir, setup.branch)
    first = development.save_development(config, setup)
    git(setup.repo_dir, "push", "origin", f"{first}:refs/heads/bgagent/releases/test")
    (Path(setup.repo_dir) / "README.md").write_text("next")
    git(setup.repo_dir, "commit", "-am", "next")
    config.channel_metadata["development_expected_sha"] = git(setup.repo_dir, "rev-parse", "HEAD")
    with pytest.raises(RuntimeError, match="refusing to overwrite"):
        development.promote_development(config, setup)


def test_development_prompt_preserves_rules_and_channel_context():
    prompt = (
        "Work\n6. **Create a Pull Request**\nMUST create PR\n## Rules\nkeep rules\nChannel context"
    )
    config = TaskConfig(aws_region="us-east-1", repo_url="owner/repo", task_id="test")
    rewritten = development.development_prompt(prompt, config)
    assert "MUST create PR" not in rewritten
    assert "keep rules" in rewritten and "Channel context" in rewritten
    assert "Do not create a pull request" in rewritten


def preview_config(repo="owner/repo", session="SESSION", task="task-1", region="us-east-1"):
    return TaskConfig(
        aws_region=region,
        repo_url=repo,
        task_id=task,
        channel_metadata={"development_action": "develop", "development_session_id": session},
    )


def test_preview_stack_reused_by_followup_but_isolated_across_repos_and_sessions():
    name = development.development_preview_stack_name(preview_config())
    assert name == development.development_preview_stack_name(preview_config(task="task-2"))
    assert name != development.development_preview_stack_name(preview_config(session="OTHER"))
    assert name != development.development_preview_stack_name(preview_config(repo="other/repo"))
    assert name == development.development_preview_stack_name(preview_config(repo="Owner/Repo"))


def test_stack_slug_collisions_and_long_names_stay_safe():
    configs = [
        preview_config(repo="Owner/" + "a_" * 150),
        preview_config(repo="Owner/" + "a-" * 150),
    ]
    names = [development.development_preview_stack_name(config) for config in configs]
    assert names[0] != names[1]
    assert all(re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,127}", name) for name in names)


def test_preview_cannot_fall_back_to_a_shared_unidentified_stack():
    with pytest.raises(ValueError, match="session or task identity"):
        development.development_preview_stack_name(preview_config(session="", task=""))
    assert development.development_preview_stack_name(preview_config(session=""))


@pytest.mark.parametrize("task_text", ["Create a game", "Create and deploy a game"])
def test_real_system_prompt_permits_only_requested_development_previews(task_text):
    from prompt_builder import build_system_prompt

    config = preview_config(region="ap-southeast-1")
    config.task_description = task_text
    setup = RepoSetup(
        repo_dir="/tmp/repo", branch="bgagent/development/SESSION", default_branch="main"
    )
    prompt = build_system_prompt(config, setup, None, "")
    assert "Only deploy when the user requests a deployment or preview" in prompt
    assert "A code-only request must remain code-only" in prompt
    assert "runtime role's EXISTING permissions" in prompt
    assert "aws sts get-caller-identity" in prompt
    assert 'task region "ap-southeast-1"' in prompt
    assert "account matches the user's requested account" in prompt
    assert "Use an explicit `--region`" in prompt
    assert development.development_preview_stack_name(config) in prompt
    assert "reuse the session's existing preview stack" in prompt
    assert "private S3 bucket + CloudFront" in prompt
    assert "Do not create a pull request" in prompt
    assert "deploy production" in prompt
    assert "Only a separate explicit promotion action" in prompt
    assert "Development deployment does not require merging to main" in prompt
    assert "report the actual action/resource" in prompt


def test_regular_coding_workflow_does_not_get_development_deploy_authorization():
    from prompt_builder import build_system_prompt

    config = preview_config()
    config.channel_metadata.clear()
    prompt = build_system_prompt(
        config, RepoSetup(repo_dir="/tmp/repo", branch="feature"), None, ""
    )
    assert "Requested development preview deployment" not in prompt
    assert "Create a Pull Request" in prompt
