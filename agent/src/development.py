"""Deterministic delivery for versioned development sessions and frozen promotion."""

from __future__ import annotations

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
    remote = _run(repo_dir, "git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if remote:
        _run(repo_dir, "git", "fetch", "origin", f"refs/heads/{branch}")
        _run(repo_dir, "git", "checkout", "-b", branch, "FETCH_HEAD")
    elif expected:
        raise RuntimeError(
            "Saved development branch is missing from origin; refusing to lose its history"
        )
    else:
        _run(repo_dir, "git", "fetch", "origin", f"refs/heads/{production}")
        _run(repo_dir, "git", "checkout", "-b", branch, "FETCH_HEAD")
    sha = _run(repo_dir, "git", "rev-parse", "HEAD")
    if expected and sha != expected:
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


def development_prompt(prompt: str) -> str:
    """Remove the PR-creation step rather than give the model conflicting instructions."""
    prompt = re.sub(r"6\. \*\*Create a Pull Request\*\*[\s\S]*?(?=\n## Rules|\Z)", "", prompt)
    prompt = prompt.replace("and create the PR with partial results", "and report partial results")
    return prompt + (
        "\n\n## Development session delivery\n"
        "This task saves versioned development work. Do not create a pull request, merge, "
        "deploy production, force-push, or delete the session branch. Work on the supplied "
        "branch, test and commit changes. The platform verifies the remote commit. "
        "Only a separate explicit promotion action may create a production PR.\n"
    )
