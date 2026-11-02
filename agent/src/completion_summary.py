"""Bounded, screened task outcomes for Slack; no additional model invocation."""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

from models import CompletionSummary
from output_scanner import scan_tool_output
from shell import redact_secrets

SUMMARY_INSTRUCTIONS = """

## Slack completion summary
At the end of your final answer, append one fenced `bgagent-summary` JSON block:
```bgagent-summary
{"summary":"Actual outcome in one or two sentences",
 "verification":[], "blockers":[], "development_url":null}
```
Keep summary under 500 characters. verification and blockers are lists of short
strings (at most 3 each). Report only checks actually run, including failures or
checks you could not run. Put unmet requested outcomes in blockers, even when
code was saved successfully. Include development_url only for an actual deployed
development preview, never an example, planned URL, production URL, or PR link.
Use a public HTTP(S) URL without credentials, signed query parameters, or tokens.
Omit empty sections. For tasks without deployment, leave development_url null.
Do not claim deployment succeeded merely because infrastructure code was saved.
Do not include secrets, tool logs, or personal data. If you need clarification,
follow the clarification instructions instead of adding this block.
"""

_BLOCK = re.compile(r"```bgagent-summary\s*\n(.*?)\n```", re.DOTALL)
_MAX_PREVIEW_URL = 1000


def _screen(text: str) -> str:
    screened = redact_secrets(scan_tool_output(text).redacted_content)
    # Also reject incomplete PEM blocks (e.g. when input hit the scanner's bound).
    return re.sub(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*",
        "[REDACTED-PRIVATE_KEY]",
        screened,
    )


def _text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    # Screen before truncation so long private-key blocks cannot leak a prefix.
    text = " ".join(_screen(value).split())
    text = re.sub(
        r"https?://[^\s<>\"`]+",
        lambda match: match.group() if _preview_url(match.group()) else "[private URL omitted]",
        text,
    )
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _items(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value[:3] if (text := _text(item, 200))]


def _preview_url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > _MAX_PREVIEW_URL:
        return None
    # URLs containing redacted credentials must never become clickable links.
    if (
        _screen(value) != value
        or "[REDACTED" in value
        or "***" in value
        or any(c.isspace() or c < " " or c in "<>|`\\" for c in value)
    ):
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
        ):
            return None
        _ = url.port  # Reject malformed ports as well as malformed hosts.
    except ValueError:
        # nosemgrep: py-silent-success-masking -- invalid URL is rejected, never published
        return None
    return value


def extract_completion_summary(final_answer: str) -> CompletionSummary | None:
    """Parse only the final answer, never tool output; tolerate older agents.

    Structured data is advisory agent reporting, not deployment verification.
    Missing/malformed data falls back to bounded prose without invented checks,
    blockers, or URLs. Screening errors propagate so unscreened text is not sent.
    """
    if not final_answer.strip():
        return None
    # Bound parsing work. The scanner separately bounds its own input at 5 MB.
    # Parse the envelope first, then screen EACH decoded field before using it.
    # Applying regex redaction to serialized JSON can span field delimiters and
    # corrupt the envelope, accidentally losing blockers or preview information.
    text = final_answer[:50_000]
    matches = list(_BLOCK.finditer(text))
    if matches:
        try:
            data = json.loads(matches[-1].group(1))
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and (summary := _text(data.get("summary"), 500)):
            return CompletionSummary(
                summary=summary,
                verification=_items(data.get("verification")),
                blockers=_items(data.get("blockers")),
                development_url=_preview_url(data.get("development_url")),
            )
    prose = _BLOCK.sub("", _screen(final_answer)[:50_000]).strip()
    if not prose:
        return None
    return CompletionSummary(summary=_text(prose, 500))
