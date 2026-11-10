import {
  terminal,
  safeUrl,
  date,
  money,
  duration,
  sourceLinks,
} from "./core.mjs";
const $ = (selector) => document.querySelector(selector);
let config,
  token,
  expires = 0,
  session,
  currentView = "tasks",
  taskRows = [],
  nextTasks,
  selectedTask,
  poll,
  unmountIntents,
  intentStyles;
const titles = {
  intents: ["Intents", "Capture decisions and publish an approved spec."],
  tasks: [
    "Task activity",
    "Follow the work, from first instruction to final delivery.",
  ],
  repos: ["Repositories", "Connect your codebase to the factory."],
  integrations: [
    "Integrations",
    "One platform, connected to the tools you work in.",
  ],
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = "quiet") {
  const b = el("button", text, className);
  b.type = "button";
  b.addEventListener("click", () => Promise.resolve(action()).catch(showError));
  return b;
}
function notice(text, error = false) {
  $("#notice").textContent = text;
  $("#notice").className = text ? (error ? "notice error" : "notice") : "";
}
function showError(error) {
  notice(error.message || String(error), true);
}
function link(label, url) {
  const a = el("a", label, "link");
  const safe = safeUrl(url);
  if (safe) {
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}
function badge(status) {
  return el(
    "span",
    (status || "unknown").replaceAll("_", " "),
    `badge ${String(status).toLowerCase()}`,
  );
}
function confirmAction(message) {
  const dialog = $("#confirm-dialog");
  $("#confirm-message").textContent = message;
  return new Promise((resolve) => {
    let accepted = false;
    const yes = () => {
      accepted = true;
      dialog.close();
    };
    const no = () => dialog.close();
    $("#confirm-yes").addEventListener("click", yes);
    $("#confirm-no").addEventListener("click", no);
    dialog.addEventListener(
      "close",
      () => {
        $("#confirm-yes").removeEventListener("click", yes);
        $("#confirm-no").removeEventListener("click", no);
        resolve(accepted);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
async function api(path, options = {}) {
  if (!token || Date.now() >= expires) {
    token = null;
    throw new Error("Your session expired. Sign in again to continue.");
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.message || `Request failed (${response.status}).`,
    );
  return body;
}
const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
async function signIn() {
  if (!config)
    throw new Error("Console configuration is unavailable. Reload the page.");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48))),
    state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  sessionStorage.setItem(
    "shoof.oauth",
    JSON.stringify({ verifier, state, created: Date.now(), intent: intentRoute() }),
  );
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const url = new URL("/oauth2/authorize", config.authDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: config.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  location.assign(url);
}
function signOut() {
  token = null;
  expires = 0;
  clearInterval(poll);
  sessionStorage.removeItem("shoof.oauth");
  const url = new URL("/logout", config.authDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.redirectUri,
  });
  location.assign(url);
}
async function authenticate() {
  const response = await fetch("config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load console configuration.");
  config = await response.json();
  $('[data-view="intents"]').hidden = !config.intents;
  const params = new URLSearchParams(location.search);
  if (params.has("error")) {
    history.replaceState({}, "", "/");
    throw new Error(
      "Cognito sign-in was cancelled or rejected. Try signing in again.",
    );
  }
  if (!params.has("code")) return;
  const saved = JSON.parse(sessionStorage.getItem("shoof.oauth") || "null");
  sessionStorage.removeItem("shoof.oauth");
  const code = params.get("code");
  history.replaceState({}, "", "/");
  if (
    !saved ||
    saved.state !== params.get("state") ||
    Date.now() - saved.created > 600000
  )
    throw new Error(
      "Sign-in verification expired or failed. Please sign in again.",
    );
  const result = await fetch(new URL("/oauth2/token", config.authDomain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: saved.verifier,
    }),
  });
  const auth = await result.json();
  if (!result.ok || !auth.id_token)
    throw new Error("Unable to complete sign-in.");
  // Tokens stay in memory, never in localStorage or the deployed configuration.
  token = auth.id_token;
  expires = Date.now() + Math.max(0, Number(auth.expires_in) - 30) * 1000;
  session = (await api("/console/session")).data;
  $("#identity").textContent = session.administrator
    ? "Administrator"
    : "Workspace member";
  $("#auth").textContent = "Sign out";
  $("#welcome").hidden = true;
  $("#screen").hidden = false;
  $("#new-task").hidden = false;
  if (config.intents && typeof saved.intent === "string") {
    history.replaceState({}, "", saved.intent ? `/#intents/${saved.intent}` : "/#intents");
    await renderView("intents");
  } else {
    await renderView("tasks");
  }
  poll = setInterval(() => {
    if (document.hidden || !token) return;
    if (selectedTask && !$("#detail-dialog").hidden && $("#detail-dialog").open)
      loadDetail(selectedTask, true).catch(showError);
    else if (currentView === "tasks" && taskRows.length <= 50)
      loadTasks(true).catch(showError);
  }, 8000);
}
function panel(title, subtitle) {
  const p = el("section", undefined, "panel");
  const h = el("div", undefined, "panel-heading");
  h.append(el("h2", title));
  if (subtitle) h.append(el("p", subtitle, "hint"));
  p.append(h);
  return p;
}
function intentRoute() {
  const match = /^#intents(?:\/([a-z0-9][a-z0-9-]{0,80}))?$/.exec(location.hash);
  return match ? (match[1] ?? "") : undefined;
}

async function renderView(view) {
  unmountIntents?.();
  unmountIntents = undefined;
  intentStyles?.remove();
  intentStyles = undefined;
  if (view === "intents" && intentRoute() === undefined) history.replaceState({}, "", "/#intents");
  if (view !== "intents" && intentRoute() !== undefined) history.replaceState({}, "", "/");
  $("#new-task").hidden = !token || view === "intents";
  currentView = view;
  notice("");
  $("#title").textContent = titles[view][0];
  $("#breadcrumb").textContent = titles[view][0];
  $("#subtitle").textContent = titles[view][1];
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.view === view));
  if (!token) return;
  $("#screen").replaceChildren();
  if (view === "tasks") await taskScreen();
  else if (view === "repos") await repoScreen();
  else if (view === "intents") {
    const { mountIntents } = await import("./intents.js");
    if (currentView !== "intents") return;
    intentStyles = el("link");
    intentStyles.rel = "stylesheet";
    intentStyles.href = "./intents.css";
    document.head.append(intentStyles);
    const workspace = el("div");
    workspace.className = "intent-workspace";
    $("#screen").append(workspace);
    unmountIntents = mountIntents(workspace, { api, id: intentRoute(), user: session.user_id });
  } else await integrationScreen();
}
async function taskScreen() {
  const stats = el("div", undefined, "stats");
  stats.id = "stats";
  $("#screen").append(stats);
  const p = panel(
    "Your tasks",
    "Live updates every 8 seconds · metrics reflect loaded records",
  );
  const filters = el("form", undefined, "filters");
  const repo = el("input");
  repo.name = "repo";
  repo.placeholder = "Filter by owner/repo";
  repo.setAttribute("aria-label", "Repository filter");
  const status = el("select");
  status.name = "status";
  status.setAttribute("aria-label", "Status filter");
  for (const v of [
    "",
    "RUNNING",
    "QUEUED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "SUBMITTED",
    "HYDRATING",
    "FINALIZING",
    "AWAITING_APPROVAL",
    "PENDING_UPLOADS",
  ]) {
    const o = el("option", v.replaceAll("_", " ") || "All statuses");
    o.value = v;
    status.append(o);
  }
  const submit = el("button", "Apply filters", "quiet");
  submit.type = "submit";
  filters.append(repo, status, submit);
  filters.id = "filters";
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    loadTasks(true).catch(showError);
  });
  p.append(filters);
  const table = el("div");
  table.id = "task-table";
  p.append(table);
  const more = button("Load more tasks", () => loadTasks(false));
  more.id = "more-tasks";
  p.append(more);
  $("#screen").append(p);
  await loadTasks(true);
}
async function loadTasks(reset) {
  if (currentView !== "tasks") return;
  const filters = $("#filters");
  if (!filters) return;
  const values = new FormData(filters),
    query = new URLSearchParams({ limit: "50" });
  for (const key of ["repo", "status"])
    if (values.get(key)) query.set(key, values.get(key));
  if (!reset && nextTasks) query.set("next_token", nextTasks);
  const result = await api(`/tasks?${query}`);
  if (currentView !== "tasks") return;
  taskRows = reset ? result.data : [...taskRows, ...result.data];
  nextTasks = result.pagination?.next_token;
  const stats = $("#stats");
  stats.replaceChildren();
  for (const [label, value] of [
    ["Loaded tasks", taskRows.length],
    ["In progress", taskRows.filter((t) => !terminal(t.status)).length],
    ["Completed", taskRows.filter((t) => t.status === "COMPLETED").length],
    [
      "Recorded cost",
      money(taskRows.reduce((sum, t) => sum + (t.cost_usd || 0), 0)),
    ],
  ]) {
    const card = el("div", undefined, "stat");
    card.append(el("span", label), el("strong", String(value)));
    stats.append(card);
  }
  const box = $("#task-table");
  box.replaceChildren();
  const table = el("table");
  const head = el("thead"),
    hr = el("tr");
  ["Task / repository", "Status", "Created", "Cost", ""].forEach((t) =>
    hr.append(el("th", t)),
  );
  head.append(hr);
  table.append(head);
  const tbody = el("tbody");
  for (const task of taskRows) {
    const row = el("tr");
    const name = el("td");
    name.append(
      button(
        task.repo || "Repository-less workflow",
        () => loadDetail(task.task_id),
        "task-name",
      ),
      el("small", task.task_id),
    );
    const state = el("td");
    state.append(badge(task.status));
    const action = el("td");
    action.append(button("View →", () => loadDetail(task.task_id)));
    row.append(
      name,
      state,
      el("td", date(task.created_at)),
      el("td", money(task.cost_usd)),
      action,
    );
    tbody.append(row);
  }
  table.append(tbody);
  box.append(table);
  if (!taskRows.length)
    box.append(
      el(
        "p",
        nextTasks
          ? "No matching tasks on this page. Load more to continue."
          : "No tasks found. Try another filter or start your first task.",
        "empty",
      ),
    );
  $("#more-tasks").hidden = !nextTasks;
}
let eventsToken, eventTask, contextCache;
async function loadDetail(id, refresh = false) {
  selectedTask = id;
  const dialog = $("#detail-dialog");
  if (!dialog.open) dialog.showModal();
  const task = (await api(`/tasks/${encodeURIComponent(id)}`)).data;
  if (selectedTask !== id) return;
  if (!refresh || eventTask !== id || terminal(task.status)) {
    contextCache = (
      await api(`/console/task-context?task_id=${encodeURIComponent(id)}`)
    ).data;
    eventTask = id;
  }
  const events = await api(
    `/tasks/${encodeURIComponent(id)}/events?desc=1&limit=50`,
  );
  eventsToken = events.pagination?.next_token;
  const box = $("#task-detail");
  box.replaceChildren();
  box.append(
    badge(task.status),
    el("h3", task.repo || "Workflow"),
    el("p", id, "mono"),
  );
  const summary = task.completion_summary;
  if (summary?.summary) box.append(el("p", summary.summary, "outcome"));
  if (task.error_message)
    box.append(el("p", task.error_message, "notice error"));
  const metadata = el("div", undefined, "detail-meta");
  metadata.append(
    el("span", `Created ${date(task.created_at)}`),
    el("span", `Duration ${duration(task.duration_s)}`),
    el("span", `Cost ${money(task.cost_usd)}`),
    el("span", `Source ${task.channel_source || "api"}`),
  );
  box.append(metadata);
  const links = el("div", undefined, "links");
  sourceLinks(task, contextCache).forEach((l) =>
    links.append(link(l.label + " ↗", l.url)),
  );
  links.append(
    button("Download replay bundle", async () => {
      const replay = await api(`/tasks/${encodeURIComponent(id)}/replay`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(replay.data, null, 2)], {
          type: "application/json",
        }),
      );
      const download = document.createElement("a");
      download.href = url;
      download.download = `task-${id}-replay.json`;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  );
  box.append(links);
  if (summary?.verification?.length) {
    box.append(el("h3", "Checks · agent reported"));
    summary.verification.forEach((v) => box.append(el("p", v, "check")));
  }
  if (summary?.blockers?.length) {
    box.append(el("h3", "Needs attention"));
    summary.blockers.forEach((v) => box.append(el("p", v, "notice")));
  }
  const request = el("details");
  request.append(
    el("summary", "Original request"),
    el("pre", task.task_description || "Not retained."),
  );
  box.append(request);
  const answer = contextCache?.answer_text;
  const final = el("details");
  final.append(
    el("summary", "Agent final answer"),
    el(
      "pre",
      answer ||
        "A separate final answer was not retained for this task. See the outcome summary and event history.",
    ),
  );
  box.append(final);
  if (!terminal(task.status))
    box.append(
      button(
        "Cancel task",
        async () => {
          if (
            !(await confirmAction(
              "Cancel this task? Work already saved will remain.",
            ))
          )
            return;
          await api(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
          await loadDetail(id);
        },
        "danger",
      ),
    );
  box.append(
    el("h3", "Progress & event history"),
    el(
      "p",
      "Newest first. Events are retained platform records, not a complete terminal transcript.",
      "hint",
    ),
  );
  const list = el("div");
  list.id = "events";
  drawEvents(list, events.data);
  box.append(list);
  const more = button("Load older events", async () => {
    const page = await api(
      `/tasks/${encodeURIComponent(id)}/events?next_token=${encodeURIComponent(eventsToken)}&limit=50`,
    );
    drawEvents(list, page.data);
    eventsToken = page.pagination?.next_token;
    more.hidden = !eventsToken;
  });
  more.hidden = !eventsToken;
  box.append(more);
  if (terminal(task.status)) selectedTask = null;
}
function drawEvents(list, events) {
  for (const event of events) {
    const d = el("details", undefined, "event");
    d.append(
      el(
        "summary",
        `${event.event_type || event.type || "Event"} · ${date(event.timestamp || event.created_at)}`,
      ),
      el("pre", JSON.stringify(event, null, 2)),
    );
    list.append(d);
  }
}
async function dataset(resource, mount, heading) {
  const p = panel(heading),
    content = el("div");
  p.append(content);
  mount.append(p);
  let next;
  const more = button("Load more", () => load(false));
  p.append(more);
  async function load(reset) {
    const result = await api(
      `/console/${resource}${!reset && next ? "?next_token=" + encodeURIComponent(next) : ""}`,
    );
    if (reset) content.replaceChildren();
    for (const row of result.data) {
      const record = el("div", undefined, "record");
      for (const [key, value] of Object.entries(row)) {
        const field = el("div");
        field.append(
          el("small", key.replaceAll("_", " ")),
          key === "status" ? badge(value) : el("span", String(value)),
        );
        record.append(field);
      }
      content.append(record);
    }
    if (!result.data.length && !next)
      content.append(el("p", "No records on this page.", "empty"));
    next = result.pagination?.next_token;
    more.hidden = !next;
  }
  await load(true);
  return () => load(true);
}
function adminOnly() {
  if (session.administrator) return false;
  $("#screen").append(
    el(
      "p",
      "Administrator access is required for repository and integration settings. Your task activity remains available.",
      "notice",
    ),
  );
  return true;
}
async function repoScreen() {
  if (adminOnly()) return;
  const form = el("form", undefined, "panel onboard");
  form.append(
    el("h2", "Onboard a repository"),
    el(
      "p",
      "Uses the current platform runtime and GitHub credential. Existing per-repository configuration is preserved.",
      "hint",
    ),
  );
  const label = el("label", "GitHub repository"),
    input = el("input");
  input.required = true;
  input.name = "repo";
  input.placeholder = "owner/repository";
  input.maxLength = 140;
  input.pattern = "[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}";
  label.append(input);
  const submit = el("button", "Onboard repository", "primary");
  submit.type = "submit";
  const status = el("p", "", "form-status");
  status.setAttribute("role", "status");
  form.append(
    label,
    submit,
    status,
    el(
      "p",
      "Before submitting a task: confirm the GitHub token can push to this repo and its base branch has an initial commit. Onboarding registers the repo; it does not create it or grant GitHub permissions.",
      "hint",
    ),
  );
  $("#screen").append(form);
  const reload = await dataset(
    "repos",
    $("#screen"),
    "Registered repositories",
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "Registering…";
    try {
      await api("/console/repos", {
        method: "POST",
        body: JSON.stringify({ repo: input.value.trim() }),
      });
      status.textContent = "Repository is active. You can now submit tasks.";
      input.value = "";
      await reload();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
}
async function integrationScreen() {
  const p = panel(
    "Link your Jira account",
    "Account linking associates your Jira identity with your existing platform login. It does not install Forge or configure project routing.",
  );
  const form = el("form"),
    label = el("label", "Link code"),
    input = el("input");
  input.required = true;
  input.maxLength = 200;
  input.placeholder = "Code from your Jira app or administrator";
  label.append(input);
  const submit = el("button", "Preview account link", "primary");
  submit.type = "submit";
  const status = el("p", "", "form-status");
  status.setAttribute("role", "status");
  form.append(label, submit, status);
  p.append(
    form,
    link(
      "Jira setup guide ↗",
      "https://github.com/VincentV89/sample-autonomous-cloud-coding-agents/blob/main/docs/guides/JIRA_SETUP_GUIDE.md",
    ),
  );
  $("#screen").append(p);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const code = input.value.trim();
      const preview = (
        await api("/jira/link", {
          method: "POST",
          body: JSON.stringify({ code, dry_run: true }),
        })
      ).data;
      if (
        await confirmAction(
          `Link your platform account to ${preview.jira_user_name || preview.jira_account_id} on ${preview.jira_site_url || preview.jira_cloud_id}?`,
        )
      ) {
        await api("/jira/link", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        status.textContent = "Jira account linked successfully.";
        input.value = "";
      } else status.textContent = "Linking cancelled.";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
  if (!session.administrator) return;
  const help = panel(
    "Workspace setup",
    "Workspace installation, account linking, and repository routing are separate steps.",
  );
  help.append(
    link("Slack app settings ↗", "https://api.slack.com/apps"),
    link(
      "Slack setup guide ↗",
      "https://github.com/VincentV89/sample-autonomous-cloud-coding-agents/blob/main/docs/guides/SLACK_SETUP_GUIDE.md",
    ),
    el(
      "p",
      "Jira Forge installation and Slack workspace approval must be completed in their respective services. Use the CLI for project/channel routing; the tables below show the current configuration.",
      "hint",
    ),
  );
  $("#screen").append(help);
  for (const [key, title] of [
    ["slack_workspaces", "Slack workspaces"],
    ["slack_channels", "Slack channel routing"],
    ["jira_workspaces", "Jira workspaces"],
    ["jira_projects", "Jira project routing"],
  ])
    await dataset(key, $("#screen"), title);
}
$("#auth").addEventListener("click", () =>
  Promise.resolve(token ? signOut() : signIn()).catch(showError),
);
$("#welcome-auth").addEventListener("click", () => signIn().catch(showError));
document
  .querySelectorAll("[data-view]")
  .forEach((b) =>
    b.addEventListener("click", () =>
      renderView(b.dataset.view).catch(showError),
    ),
  );
document
  .querySelectorAll("[data-close]")
  .forEach((b) =>
    b.addEventListener("click", () => $("#" + b.dataset.close).close()),
  );
$("#new-task").addEventListener("click", () => $("#task-dialog").showModal());
$("#detail-dialog").addEventListener("close", () => {
  selectedTask = null;
});
$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    status = form.querySelector(".form-status"),
    submit = form.querySelector("[type=submit]"),
    values = new FormData(form);
  submit.disabled = true;
  status.textContent = "Creating task…";
  try {
    const result = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({
        repo: values.get("repo").trim(),
        task_description: values.get("description"),
        workflow_ref: "coding/new-task-v1",
        ...(values.get("mode") === "develop"
          ? { development_action: "develop" }
          : {}),
      }),
    });
    form.reset();
    $("#task-dialog").close();
    await renderView("tasks");
    await loadDetail(result.data.task_id);
  } catch (err) {
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  if (config?.intents && token && intentRoute() !== undefined) renderView("intents").catch(showError);
});
authenticate().catch(showError);
