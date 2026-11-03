// Run against the local asset server with playwright-cli run-code --filename.
// All API and OAuth traffic below is mocked; no real task or Jira action is sent.
async (page) => {
  const origin = "http://127.0.0.1:4179";
  const id = "01M66590HPQJAYYSH0V9WW19HS";
  const task = {
    task_id: id,
    repo: "example/eventflow",
    status: "COMPLETED",
    created_at: "2026-11-03T01:02:00Z",
    cost_usd: 0.79,
    duration_s: 687,
    channel_source: "slack",
    task_description: "<img src=x onerror=alert(1)> Build EventFlow",
    branch_name: "bgagent/development/session",
    completion_summary: {
      summary: "Built EventFlow and deployed a development preview.",
      verification: ["Build passed", "Registration API smoke test passed"],
      development_url: "https://example.com/preview",
    },
  };
  let onboarded = false,
    linked = false,
    created = false,
    cancelled = false,
    administrator = true;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/config.json", (route) =>
    route.fulfill({
      json: {
        clientId: "test-client",
        authDomain: "https://test.amazoncognito.com",
        redirectUri: origin + "/",
      },
    }),
  );
  await page.route("https://test.amazoncognito.com/oauth2/token", (route) =>
    route.fulfill({ json: { id_token: "mock-id-token", expires_in: 3600 } }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = request.url().split("/api")[1].split("?")[0];
    let data;
    if (path === "/console/session")
      data = { administrator, user_id: "test-user" };
    else if (path === "/tasks" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (
        body.workflow_ref !== "coding/new-task-v1" ||
        body.development_action !== "develop"
      )
        throw new Error("Wrong workflow request");
      created = true;
      data = { ...task, status: "RUNNING" };
    } else if (path === "/tasks")
      return route.fulfill({
        json: {
          data: [created ? { ...task, status: "RUNNING" } : task],
          pagination: { next_token: null },
        },
      });
    else if (path === `/tasks/${id}` && request.method() === "DELETE") {
      cancelled = true;
      data = { task_id: id };
    } else if (path === `/tasks/${id}`)
      data = {
        ...task,
        status: cancelled ? "CANCELLED" : created ? "RUNNING" : "COMPLETED",
      };
    else if (path.endsWith("/replay")) data = { task_id: id, events: [] };
    else if (path.endsWith("/events"))
      return route.fulfill({
        json: {
          data: [
            {
              event_type: "task_completed",
              timestamp: task.created_at,
              metadata: { summary: "Preview ready" },
            },
          ],
          pagination: { next_token: null },
        },
      });
    else if (path === "/console/task-context")
      data = {
        answer_text: "Development preview is ready.",
        slack: { team_id: "T1", channel_id: "C1", thread_ts: "123.45" },
      };
    else if (path === "/console/repos" && request.method() === "POST") {
      onboarded = true;
      data = { repo: request.postDataJSON().repo, status: "active" };
    } else if (path === "/console/repos")
      return route.fulfill({
        json: {
          data: [{ repo: "example/eventflow", status: "active" }],
          pagination: { next_token: null },
        },
      });
    else if (path === "/jira/link") {
      if (!request.postDataJSON().dry_run) linked = true;
      data = {
        jira_user_name: "Example operator",
        jira_site_url: "https://example.atlassian.net",
      };
    } else if (path.startsWith("/console/"))
      return route.fulfill({
        json: { data: [], pagination: { next_token: null } },
      });
    else
      return route.fulfill({
        status: 404,
        json: { error: { message: "Unexpected fixture route" } },
      });
    return route.fulfill({ json: { data } });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "shoof.oauth",
      JSON.stringify({
        verifier: "test-verifier",
        state: "test-state",
        created: Date.now(),
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/?code=test&state=test-state");
  await page
    .getByRole("button", { name: "example/eventflow", exact: true })
    .waitFor();
  await page.screenshot({
    path: "/tmp/abca-console-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "View →", exact: true }).click();
  await page
    .getByText("Built EventFlow and deployed a development preview.", {
      exact: true,
    })
    .waitFor();
  await page.getByText("Original request", { exact: true }).click();
  if (await page.locator("#task-detail img").count())
    throw new Error("Unsafe task output became HTML");
  if (
    (await page
      .getByRole("link", { name: "Development preview ↗" })
      .getAttribute("href")) !== "https://example.com/preview"
  )
    throw new Error("Missing deployment link");
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download replay bundle', exact: true }).click(),
  ]);
  if (download.suggestedFilename() !== `task-${id}-replay.json`) throw new Error('Replay download failed');
  await page.getByRole("button", { name: "Close task detail" }).click();
  await page.locator("[data-view=repos]").click();
  await page.getByLabel("GitHub repository").fill("example/new-repo");
  await page
    .getByRole("button", { name: "Onboard repository", exact: true })
    .click();
  await page
    .getByText("Repository is active. You can now submit tasks.")
    .waitFor();
  await page.locator("[data-view=integrations]").click();
  await page.getByLabel("Link code", { exact: true }).fill("example-link-code");
  await page.getByRole("button", { name: "Preview account link" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Jira account linked successfully.").waitFor();
  await page.getByRole("button", { name: "＋ New task" }).click();
  await page
    .getByLabel("Repository", { exact: true })
    .fill("example/eventflow");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Build a development preview.");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel task", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.locator("#task-detail .badge.cancelled").waitFor();
  await page.getByRole("button", { name: "Close task detail" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-view=tasks]").click();
  await page
    .getByRole("button", { name: "example/eventflow", exact: true })
    .waitFor();
  await page.screenshot({
    path: "/tmp/abca-console-mobile.png",
    fullPage: true,
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Mobile page overflows");
  // A newly signed-in ordinary user sees no admin form.
  administrator = false;
  await page.goto(origin + "/?code=test&state=test-state");
  await page
    .getByRole("button", { name: "example/eventflow", exact: true })
    .waitFor();
  await page.locator("[data-view=repos]").click();
  await page
    .getByText("Administrator access is required", { exact: false })
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Onboard repository", exact: true })
      .count()
  )
    throw new Error("Admin form visible to member");
  // OAuth callback rejects a mismatched state before exchanging a code.
  await page.goto(origin + "/?code=test&state=wrong");
  await page
    .getByText("Sign-in verification expired or failed.", { exact: false })
    .waitFor();
  if (!onboarded || !linked || !created || !cancelled || errors.length)
    throw new Error(
      JSON.stringify({ onboarded, linked, created, cancelled, errors }),
    );
  return {
    onboarding: onboarded,
    jiraLink: linked,
    taskSubmission: created,
    cancellation: cancelled,
    mobileOverflow: false,
    memberAdminAccess: false,
    oauthStateValidation: true,
    browserErrors: errors,
  };
}
