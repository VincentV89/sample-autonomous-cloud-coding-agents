"""Opt-in managed Chromium smoke test; no model calls or application writes.

Run with AWS operator credentials. Visits the supplied public read-only page,
then tests a separate in-memory form in that browser. Never claims to verify
that application's registration/authentication flow.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from browser_tools import BrowserTools


async def main(url: str, region: str, output: str) -> None:
    directory = Path(output)
    directory.mkdir(parents=True, exist_ok=True)
    controller = BrowserTools("browser-smoke", region, str(directory))
    try:
        result = await controller.invoke({"action": "navigate", "url": url})
        if not result["success"]:
            raise RuntimeError(result["error"])
        # The fixture only changes this isolated browser's DOM; it never submits
        # a registration or modifies the application behind the supplied URL.
        await controller.page.set_content(
            '<label>Name<input id="name"></label>'
            '<button id="submit" type="button">Register fixture</button>'
            '<p id="result"></p>'
        )
        await controller.page.evaluate(
            "document.querySelector('#submit').addEventListener('click', () => { "
            "document.querySelector('#result').textContent = 'Fixture registered: ' + "
            "document.querySelector('#name').value; });"
        )
        checks = [
            {"action": "fill", "label": "Name", "text": "Browser smoke fixture"},
            {"action": "click", "role": "button", "name": "Register fixture"},
            {"action": "assert_text", "text": "Fixture registered: Browser smoke fixture"},
            {"action": "screenshot"},
            {"action": "diagnostics"},
        ]
        results = []
        for check in checks:
            result = await controller.invoke(check)
            if not result["success"]:
                raise RuntimeError(result["error"])
            if result.get("path"):
                shutil.copy2(result["path"], directory / "screenshot.jpg")
            results.append({k: v for k, v in result.items() if k != "path"})
        shutil.copy2(controller.directory / "checks.json", directory / "checks.json")
        (directory / "result.json").write_text(
            json.dumps(
                {
                    "real_managed_chromium": True,
                    "read_only_navigation": True,
                    "in_memory_form_checks": True,
                    "application_user_journeys_tested": False,
                    "results": results,
                },
                indent=2,
            )
        )
        await controller.close()
        if controller.session_id is not None:
            raise RuntimeError("Managed browser session cleanup failed")
        print("Managed Chromium form/assertion/screenshot smoke passed; session stopped.")
    finally:
        await controller.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.url, args.region, args.output))
