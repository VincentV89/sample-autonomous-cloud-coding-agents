"""Exercise plain-Claude launch across a clean process environment boundary."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import runner
import terminal_claude as terminal
from models import TaskConfig

REGION = "ap-southeast-1"
MODEL = "global.anthropic.claude-opus-5-5"
HAIKU = "global.anthropic.claude-haiku-5-5"
SOURCE = Path(terminal.__file__).resolve()


@pytest.fixture
def native_cli(tmp_path):
    path = tmp_path / "native-claude"
    path.write_text(
        f"#!{sys.executable} -I\n"
        + """import json, os, sys
keys = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION',
        'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_LOG']
data = {'args': sys.argv[1:], 'settings': {key: os.environ.get(key) for key in keys}}
data['pid'] = os.getpid()
print(json.dumps(data))
sys.exit(37 if '--fake-failure' in sys.argv else 0)
"""
    )
    path.chmod(0o755)
    return path


def launch(native_cli, args=(), env=None, cwd=None):
    # -I matches the production launcher shebang: no project PYTHONPATH imports.
    bootstrap = f"""import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('terminal_claude', {str(SOURCE)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.CONFIG_PATH = pathlib.Path({str(terminal.CONFIG_PATH)!r})
module.REAL_CLAUDE = {str(native_cli)!r}
sys.argv = ['claude', *{list(args)!r}]
sys.exit(module.main())
"""
    return subprocess.run(
        [sys.executable, "-I", "-c", bootstrap],
        env={"PATH": os.defpath, **(env or {})},
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=10,
    )


def publish():
    terminal.write_terminal_config(aws_region=REGION, model=MODEL, haiku_model=HAIKU)


class TestTerminalClaude:
    def test_runner_resolved_settings_reach_a_clean_shell_without_credentials(
        self, native_cli, monkeypatch
    ):
        monkeypatch.delenv("AGENT_SESSION_ROLE_ARN", raising=False)
        config = TaskConfig(
            repo_url="owner/repo",
            aws_region=REGION,
            anthropic_model=MODEL,
            haiku_model=HAIKU,
            github_token="not-a-real-token",
            task_id="terminal-task",
        )
        runner._setup_agent_env(config)
        result = launch(native_cli)
        assert result.returncode == 0, result.stderr
        settings = json.loads(result.stdout)["settings"]
        assert settings == {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": REGION,
            "AWS_DEFAULT_REGION": REGION,
            "ANTHROPIC_MODEL": MODEL,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": HAIKU,
            "ANTHROPIC_LOG": None,
        }
        saved = json.loads(terminal.CONFIG_PATH.read_text())
        assert set(saved) == {"aws_region", "model", "haiku_model"}
        assert "not-a-real-token" not in terminal.CONFIG_PATH.read_text()
        assert stat.S_IMODE(terminal.CONFIG_PATH.stat().st_mode) == 0o600

    def test_task_pins_override_stale_shell_defaults_and_preserve_argument_boundaries(
        self, native_cli
    ):
        terminal.write_terminal_config(
            aws_region="eu-west-1",
            model="eu.anthropic.claude-opus-5-5",
            haiku_model="eu.anthropic.claude-haiku-5-5",
        )
        arguments = ["-p", "a prompt with spaces; $(not-a-command)", "--model", "explicit-model"]
        result = launch(
            native_cli,
            arguments,
            {"AWS_REGION": "us-west-2", "ANTHROPIC_MODEL": "stale", "ANTHROPIC_LOG": "debug"},
        )
        data = json.loads(result.stdout)
        assert data["args"] == arguments
        assert (
            data["settings"]["AWS_REGION"] == data["settings"]["AWS_DEFAULT_REGION"] == "eu-west-1"
        )
        assert data["settings"]["ANTHROPIC_MODEL"] == "eu.anthropic.claude-opus-5-5"
        assert data["settings"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "eu.anthropic.claude-haiku-5-5"
        assert data["settings"]["ANTHROPIC_LOG"] is None

    def test_project_cannot_select_a_launcher_or_import_python_modules(self, native_cli, tmp_path):
        publish()
        (tmp_path / "json.py").write_text("raise RuntimeError('project module executed')")
        (tmp_path / "claude").write_text("raise RuntimeError('recursive PATH launcher')")
        result = launch(
            native_cli, env={"PATH": str(tmp_path), "PYTHONPATH": str(tmp_path)}, cwd=tmp_path
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["settings"]["CLAUDE_CODE_USE_BEDROCK"] == "1"

    @pytest.mark.parametrize("argument", ["--version", "-v", "--help", "-h"])
    def test_information_probes_work_before_task_initialization(self, native_cli, argument):
        result = launch(native_cli, [argument])
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["args"] == [argument]

    def test_missing_config_fails_with_guidance_instead_of_opening_login(self, native_cli):
        result = launch(
            native_cli,
            env={"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": REGION, "ANTHROPIC_MODEL": MODEL},
        )
        assert result.returncode == 78
        assert result.stdout == ""
        assert "Wait for the task to initialize" in result.stderr

    @pytest.mark.parametrize(
        "contents",
        [
            "not json",
            "[]",
            "{}",
            "x" * 9000,
            json.dumps(
                {
                    "aws_region": REGION,
                    "model": MODEL,
                    "haiku_model": HAIKU,
                    "helper": "untrusted-command",
                }
            ),
            json.dumps({"aws_region": "bad region", "model": MODEL, "haiku_model": HAIKU}),
            json.dumps(
                {"aws_region": REGION, "model": "$(untrusted-command)", "haiku_model": HAIKU}
            ),
        ],
    )
    def test_malformed_config_cannot_launch_native_cli_or_leak_contents(self, native_cli, contents):
        terminal.CONFIG_PATH.write_text(contents)
        result = launch(native_cli)
        assert result.returncode == 78
        assert result.stdout == ""
        assert "untrusted-command" not in result.stderr
        assert "unavailable" in result.stderr

    def test_failed_atomic_publish_invalidates_old_pins_and_cleans_temp_files(self):
        publish()
        with (
            patch.object(terminal.os, "replace", side_effect=OSError("disk error")),
            pytest.raises(OSError),
        ):
            publish()
        assert not terminal.CONFIG_PATH.exists()
        assert not list(terminal.CONFIG_PATH.parent.glob(".abca-terminal-*"))

    def test_bad_new_pins_invalidate_prior_config(self):
        publish()
        with pytest.raises(ValueError):
            terminal.write_terminal_config(aws_region="", model=MODEL, haiku_model=HAIKU)
        assert not terminal.CONFIG_PATH.exists()

    def test_launcher_preserves_native_cli_exit_status(self, native_cli):
        publish()
        assert launch(native_cli, ["--fake-failure"]).returncode == 37

    def test_missing_native_binary_has_explicit_error(self, tmp_path):
        publish()
        result = launch(tmp_path / "absent")
        assert result.returncode == 127
        assert "binary is unavailable" in result.stderr

    def test_interactive_write_failure_does_not_break_existing_sdk_environment(self, monkeypatch):
        monkeypatch.delenv("AGENT_SESSION_ROLE_ARN", raising=False)
        config = TaskConfig(
            repo_url="owner/repo", aws_region=REGION, anthropic_model=MODEL, haiku_model=HAIKU
        )
        with (
            patch.object(runner, "write_terminal_config", side_effect=OSError("disk unavailable")),
            patch.object(runner, "log") as log,
        ):
            runner._setup_agent_env(config)
        assert os.environ["CLAUDE_CODE_USE_BEDROCK"] == "1"
        assert os.environ["ANTHROPIC_MODEL"] == MODEL
        assert any(
            "Interactive Claude settings unavailable" in str(call) for call in log.call_args_list
        )

    def test_managed_bedrock_credential_helper_stays_fixed(self):
        settings = json.loads((SOURCE.parents[1] / "managed-settings.json").read_text())
        assert (
            settings["awsCredentialExport"]
            == "/app/.venv/bin/python /app/src/bedrock_creds_helper.py"
        )
        assert settings["env"]["CLAUDE_CODE_USE_BEDROCK"] == "1"
