/** Small pure presentation helpers. Task output is always rendered as text. */
export const terminal = (status) =>
  ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export const date = (value) => (value ? new Date(value).toLocaleString() : "—");
export const money = (value) =>
  typeof value === "number" ? `$${value.toFixed(2)}` : "—";
export const duration = (value) =>
  typeof value === "number"
    ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`
    : "—";
export function sourceLinks(task, context = {}) {
  const links = [];
  const add = (label, url) => {
    const safe = safeUrl(url);
    if (safe) links.push({ label, url: safe });
  };
  add("Pull request", task.pr_url);
  add("Development preview", task.completion_summary?.development_url);
  if (/^[\w.-]+\/[\w.-]+$/.test(task.repo ?? "")) {
    const base = `https://github.com/${task.repo}`;
    add("Repository", base);
    if (task.branch_name)
      add(
        "Saved branch",
        `${base}/tree/${encodeURIComponent(task.branch_name)}`,
      );
    if (/^[a-f0-9]{40}$/i.test(task.head_sha ?? ""))
      add("Commit", `${base}/commit/${task.head_sha}`);
    if (Number.isInteger(task.issue_number) && task.issue_number > 0)
      add("GitHub issue", `${base}/issues/${task.issue_number}`);
  }
  const slack = context.slack ?? {};
  if (
    /^[A-Z0-9]+$/.test(slack.team_id ?? "") &&
    /^[A-Z0-9]+$/.test(slack.channel_id ?? "")
  ) {
    add(
      "Slack source",
      `https://app.slack.com/client/${slack.team_id}/${slack.channel_id}${/^\d+\.\d+$/.test(slack.thread_ts ?? "") ? "/thread/" + slack.channel_id + "-" + slack.thread_ts : ""}`,
    );
  }
  const jira = context.jira ?? {};
  if (
    safeUrl(jira.site_url) &&
    /^[A-Z][A-Z0-9_]*-\d+$/.test(jira.issue_key ?? "")
  )
    add(
      "Jira issue",
      `${new URL(jira.site_url).origin}/browse/${jira.issue_key}`,
    );
  return links;
}
