"""Run inside the built image as the agent user, with --network none.

docker run --rm -i --network none --entrypoint /app/.venv/bin/python IMAGE \
    - < agent/tests/image_preview_smoke.py

Uses a loopback-only fake container credential provider and STS endpoint. No real
credentials or AWS calls; verifies CLI default-chain signing and runtime imports.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    assert os.geteuid() != 0, "Must smoke-test the non-root runtime user"
    version = subprocess.check_output(["aws", "--version"], text=True).strip()
    assert "aws-cli/2.39.3 " in version, version
    credential_key = "ASIA" + "T" * 16
    observed = {"credentials": False, "signed": False}

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            """Suppress HTTP logs; do not log authorization headers."""

        def do_GET(self):
            assert self.path == "/credentials"
            observed["credentials"] = True
            data = json.dumps(
                {
                    "AccessKeyId": credential_key,
                    "SecretAccessKey": "s" * 40,
                    "Token": "test-session-token",
                    "Expiration": "2099-01-01T00:00:00Z",
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            observed["signed"] = (
                f"Credential={credential_key}/" in self.headers.get("Authorization", "")
                and self.headers.get("X-Amz-Security-Token") == "test-session-token"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/xml")
            self.end_headers()
            self.wfile.write(b"""<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
<GetCallerIdentityResult><Arn>arn:aws:sts::123456789012:assumed-role/runtime/test</Arn>
<UserId>test</UserId><Account>123456789012</Account></GetCallerIdentityResult>
<ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></GetCallerIdentityResponse>""")

    with ThreadingHTTPServer(("127.0.0.1", 0), Endpoint) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        endpoint = f"http://127.0.0.1:{server.server_port}"
        env = os.environ.copy()
        for name in [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_PROFILE",
        ]:
            env.pop(name, None)
        env.update(
            {
                "AWS_CONTAINER_CREDENTIALS_FULL_URI": endpoint + "/credentials",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_PAGER": "",
                "AWS_CLI_AUTO_PROMPT": "off",
            }
        )
        try:
            identity = json.loads(
                subprocess.check_output(
                    [
                        "aws",
                        "sts",
                        "get-caller-identity",
                        "--endpoint-url",
                        endpoint,
                        "--region",
                        "us-east-1",
                        "--output",
                        "json",
                    ],
                    env=env,
                    text=True,
                    timeout=30,
                )
            )
            assert identity["Account"] == "123456789012"
            assert all(observed.values()), observed
        finally:
            server.shutdown()
            worker.join(timeout=5)

    print(version)
    print("Non-root CLI, container credentials and signed loopback STS: OK")
    # For compatibility testing the CLI stage against the pinned AMD64 base,
    # without rebuilding the unrelated Go/Node/agent layers under emulation.
    if os.environ.get("BGAGENT_IMAGE_CLI_ONLY") == "1":
        return

    sys.path.insert(0, "/app/src")
    import pipeline  # noqa: F401 -- verify the complete runtime import graph
    from development import development_preview_stack_name
    from models import RepoSetup, TaskConfig
    from prompt_builder import build_system_prompt

    config = TaskConfig(
        repo_url="owner/repo",
        aws_region="us-east-1",
        task_id="followup",
        channel_metadata={"development_action": "develop", "development_session_id": "SESSION"},
    )
    prompt = build_system_prompt(config, RepoSetup(repo_dir="/tmp/repo", branch="dev"), None, "")
    assert development_preview_stack_name(config) in prompt
    assert "runtime role's EXISTING permissions" in prompt
    print("Runtime imports and development preview prompt: OK")


if __name__ == "__main__":
    main()
