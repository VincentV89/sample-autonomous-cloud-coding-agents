"""Deterministic delivery for versioned development sessions and frozen promotion."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models import RepoSetup, TaskConfig


def _run(repo_dir: str, *args: str) -> str:
    result = subprocess.run(
        list(args), cwd=repo_dir, capture_output=True, text=True, timeout=120, check=False
    )
    if result.returncode:
        raise RuntimeError(
            f"Development delivery failed ({args[0]} {args[1]}): {result.stderr[-1000:]}"
        )
    return result.stdout.strip()


def checkout_development(config: TaskConfig, repo_dir: str, branch: str) -> str:
    """Never silently fall back to main when a saved branch cannot be fetched."""
    expected = config.channel_metadata.get("development_expected_sha", "")
    production = config.channel_metadata["development_production_branch"]
    intent_commit = config.channel_metadata.get("development_intent_commit", "")
    if intent_commit and not re.fullmatch(r"[0-9a-f]{40}", intent_commit):
        raise RuntimeError("Invalid published intent commit")
    remote = _run(repo_dir, "git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if remote:
        _run(repo_dir, "git", "fetch", "origin", f"refs/heads/{branch}")
        _run(repo_dir, "git", "checkout", "-b", branch, "FETCH_HEAD")
    elif expected:
        raise RuntimeError(
            "Saved development branch is missing from origin; refusing to lose its history"
        )
    else:
        _run(repo_dir, "git", "fetch", "origin", intent_commit or f"refs/heads/{production}")
        _run(repo_dir, "git", "checkout", "-b", branch, "FETCH_HEAD")
    sha = _run(repo_dir, "git", "rev-parse", "HEAD")
    if (expected or intent_commit) and sha != (expected or intent_commit):
        raise RuntimeError(
            "Development branch changed outside this session; reload and reconcile before retrying"
        )
    return sha


def save_development(config: TaskConfig, setup: RepoSetup) -> str:
    """A push alone is insufficient: require origin to advertise our exact commit."""
    sha = _run(setup.repo_dir, "git", "rev-parse", "HEAD")
    _run(setup.repo_dir, "git", "push", "origin", f"HEAD:refs/heads/{setup.branch}")
    advertised = _run(
        setup.repo_dir, "git", "ls-remote", "--heads", "origin", f"refs/heads/{setup.branch}"
    )
    if not advertised or advertised.split()[0] != sha:
        raise RuntimeError("Development commit could not be verified on origin")
    return sha


def promote_development(config: TaskConfig, setup: RepoSetup) -> tuple[str, str]:
    """Open/recover a PR at the pinned saved revision, without invoking the model."""
    expected = config.channel_metadata["development_expected_sha"]
    sha = _run(setup.repo_dir, "git", "rev-parse", "HEAD")
    if sha != expected or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
        raise RuntimeError("Promotion revision does not match the verified development commit")
    release_branch = f"bgagent/releases/{config.channel_metadata['development_session_id']}"
    advertised = _run(
        setup.repo_dir, "git", "ls-remote", "--heads", "origin", f"refs/heads/{release_branch}"
    )
    if advertised:
        if advertised.split()[0] != sha:
            raise RuntimeError(
                "Release branch already exists at a different revision; refusing to overwrite it"
            )
    else:
        _run(
            setup.repo_dir,
            "git",
            "push",
            f"--force-with-lease=refs/heads/{release_branch}:",
            "origin",
            f"{sha}:refs/heads/{release_branch}",
        )
    # Admission freezes further iterations. The same head is used on every retry,
    # so neither an ambiguous API response nor a closed PR can create duplicates.
    prs = json.loads(
        _run(
            setup.repo_dir,
            "gh",
            "pr",
            "list",
            "--repo",
            config.repo_url,
            "--head",
            release_branch,
            "--base",
            setup.default_branch,
            "--state",
            "all",
            "--json",
            "url",
        )
    )
    if prs:
        return str(prs[0]["url"]), sha
    url = _run(
        setup.repo_dir,
        "gh",
        "pr",
        "create",
        "--repo",
        config.repo_url,
        "--head",
        release_branch,
        "--base",
        setup.default_branch,
        "--title",
        f"Promote development session {config.channel_metadata['development_session_id']}",
        "--body",
        (
            f"Promotes saved development commit `{sha}`.\n\n"
            "Review and merge to release through this repository's configured deployment workflow."
        ),
    )
    if not re.fullmatch(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+", url):
        raise RuntimeError("GitHub did not return a valid promotion PR URL")
    return url, sha


def development_preview_stack_name(config: TaskConfig) -> str:
    """Stable CloudFormation-safe name, isolated by full repo and session identity."""
    session = config.channel_metadata.get("development_session_id") or config.task_id
    if not session:
        raise ValueError("Development preview requires a session or task identity")
    repo = config.repo_url.lower()
    slug = re.sub(r"[^a-z0-9-]+", "-", repo).strip("-")[:48].rstrip("-") or "repo"
    suffix = hashlib.sha256(json.dumps([repo, session]).encode()).hexdigest()[:12]
    return f"bgagent-dev-{slug}-{suffix}"


def development_prompt(prompt: str, config: TaskConfig) -> str:
    """Remove the PR-creation step rather than give the model conflicting instructions."""
    prompt = re.sub(r"6\. \*\*Create a Pull Request\*\*[\s\S]*?(?=\n## Rules|\Z)", "", prompt)
    prompt = prompt.replace("and create the PR with partial results", "and report partial results")
    stack = development_preview_stack_name(config)
    return prompt + (
        "\n\n## Development session delivery\n"
        "This task saves versioned development work. Do not create a pull request, merge, "
        "deploy production, force-push, or delete the session branch. Work on the supplied "
        "branch, test and commit changes. The platform verifies the remote commit. "
        "Only a separate explicit promotion action may create a production PR.\n"
        "\n### Requested development preview deployment\n"
        "Only deploy when the user requests a deployment or preview. A code-only request "
        "must remain code-only. When deployment is requested, you are authorized to "
        "create/update this session's isolated development resources using the ambient "
        "runtime role's EXISTING permissions through the standard AWS credential chain. "
        "The role being named RuntimeExecutionRole, or the target account also hosting "
        "the platform, is not a reason to refuse. Do not request access keys, GitHub "
        "repository secrets, or a separate deploy role merely because runtime credentials "
        "are available. AWS CLI v2 is installed as `aws`; use it directly.\n"
        "Before any infrastructure mutation, run `aws sts get-caller-identity` and verify "
        "the account matches the user's requested account, if specified. Use an explicit "
        "`--region` on AWS CLI deployment commands; for CDK configure AWS_REGION, "
        "AWS_DEFAULT_REGION and CDK_DEFAULT_REGION on the deployment subprocess. "
        "Do not change the platform/model runtime's region. "
        "Honor the user's requested region, otherwise "
        f"use the task region {json.dumps(config.aws_region)}. If identity, target account "
        "or region cannot be verified, stop deployment and report the mismatch or exact "
        "error. Never print or export credential values. Do not expand your own IAM "
        "permissions or alter platform/production roles, "
        "bootstrap/replace shared infrastructure, or bypass an authorization denial.\n"
        f"Use development stack name `{stack}` for a new preview. For a resumed session, "
        "first inspect the saved infrastructure/deploy scripts and reuse the session's "
        "existing preview stack if one was already recorded; do not create a second "
        "preview or take over another session's resources. Save the chosen stack name "
        "and region in the repository's development deployment configuration. Include "
        "the account/region or stack identity in globally unique bucket names. Never "
        "modify production or platform infrastructure.\n"
        "For static web apps, default to a private S3 bucket + CloudFront with Origin "
        "Access Control unless the user names a different hosting target. Save "
        "infrastructure as code and deployment commands on the development branch, "
        "then actually run them against development resources. Development deployment "
        "does not require merging to main, creating a PR, or setting up GitHub Actions. "
        "Do not substitute a production-only workflow for the requested preview.\n"
        "Wait for infrastructure deployment and upload the built application. Retrieve "
        "the actual URL from stack outputs/the deployment response and check the URL. "
        "Report which build/deployment/HTTP checks actually passed or failed. A saved "
        "commit or generated workflow alone is not a deployment. If AWS denies an "
        "operation, report the actual action/resource and unmet outcome without "
        "granting yourself permissions or working around the denial. Include the "
        "development URL in the final answer and Slack completion summary when a "
        "preview exists; report an unverified/unreachable preview as a blocker.\n"
    )
