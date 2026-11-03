import test from "node:test";
import assert from "node:assert/strict";
import { safeUrl, sourceLinks, terminal } from "../../console/core.mjs";
test("external URLs reject script schemes, credentials, and HTTP", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://example.com",
    "https://user:pass@example.com",
    "//example.com",
  ])
    assert.equal(safeUrl(url), null);
  assert.equal(
    safeUrl("https://example.com/preview"),
    "https://example.com/preview",
  );
});
test("source links encode branch names and never accept executable preview links", () => {
  const links = sourceLinks({
    repo: "owner/repo",
    branch_name: "bgagent/development/session",
    completion_summary: { development_url: "javascript:alert(1)" },
  });
  assert.equal(
    links.find((l) => l.label === "Development preview"),
    undefined,
  );
  assert.equal(
    links.find((l) => l.label === "Saved branch").url,
    "https://github.com/owner/repo/tree/bgagent%2Fdevelopment%2Fsession",
  );
});
test("Jira and Slack links are constructed from validated source metadata", () => {
  const links = sourceLinks(
    {},
    {
      jira: { site_url: "https://example.atlassian.net", issue_key: "KAN-4" },
      slack: { team_id: "T1", channel_id: "C1", thread_ts: "123.45" },
    },
  );
  assert.equal(links.length, 2);
  assert.ok(links[0].url.startsWith("https://app.slack.com/"));
  assert.equal(links[1].url, "https://example.atlassian.net/browse/KAN-4");
});
test("terminal state handling keeps approval and queued tasks live", () => {
  assert.equal(terminal("AWAITING_APPROVAL"), false);
  assert.equal(terminal("QUEUED"), false);
  assert.equal(terminal("COMPLETED"), true);
});
