# Slack integration setup guide

This guide walks through setting up the ABCA Slack integration. Once configured, your team can submit tasks by mentioning `@Shoof` in any channel and receive real-time notifications as tasks progress.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](./DEVELOPER_GUIDE.md))
- A Cognito user account configured (see [User guide](./USER_GUIDE.md))
- A Slack workspace where you are authorized to install apps (if your workspace requires admin approval for app installs, request it through your Slack administrator)
- AWS CLI configured with credentials for your ABCA account

## Quick start

```bash
bgagent slack setup
```

This single command handles everything: deploying the stack (if needed), generating the Slack App manifest URL, prompting for credentials, and showing the install link. Follow the on-screen instructions.

## How it works

- **@Shoof mentions**: `@Shoof fix the bug in org/repo#42` submits a task. Reactions on your message show progress: :eyes: (received) → :hourglass_flowing_sand: (working) → :white_check_mark: (done)
- **DMs**: Message Shoof directly for private task submissions
- **Notifications**: Threaded messages show task_created → completed (with PR link, duration, cost). The Cancel button lets you stop a running task.
- **Multi-workspace**: Each workspace installs via OAuth and gets its own bot token

## Step-by-step setup

### Step 1: Run the setup wizard

```bash
bgagent slack setup
```

If the stack isn't deployed yet, it will offer to deploy for you.

### Step 2: Create the Slack App

The wizard outputs a URL that opens Slack's "Create New App" page with everything pre-filled (scopes, events, commands, URLs). Click the link, select your workspace, and create the app.

### Step 3: Enter credentials

The wizard prompts for three values from your new app's **Basic Information → App Credentials** page:

| Field | Format |
|-------|--------|
| Signing Secret | 32 hex characters |
| Client Secret | 32 hex characters |
| Client ID | Numeric (e.g. 12345.67890) |

![App Credentials location](../imgs/find-credentials.png)

Format validation catches obvious typos (wrong length, non-hex characters). If the format is wrong, it loops back to re-enter. Note: the actual values cannot be verified until the app is installed — if you paste the wrong secret by mistake, you'll get an error at install time.

### Step 4: Verify Event Subscriptions

In the Slack App dashboard, go to **Event Subscriptions**:

![Finding Event Subscriptions](../imgs/find-even-subscriptions.png)

1. The Request URL may show "Your URL didn't respond" — click **Retry**
2. Wait for the green "Verified" checkmark
3. Click **Save Changes**

![Event Subscriptions before](../imgs/enable-events-before.png)

Click **Retry** and wait for the green checkmark:

![Event Subscriptions after](../imgs/enable-events-after.png)

The first attempt may time out due to Lambda cold start. The retry always succeeds.

### Step 5: Install the app

The wizard outputs an OAuth install URL. Open it in your browser — do **not** use the "Install App" button in the Slack dashboard (it won't connect to your backend).

After clicking **Allow**, you'll see a success page. The bot token is now stored and Shoof can respond to messages.

#### Reauthorize an existing app for images and thread history

Shoof needs `files:read` to download images attached to a task message. Thread
history uses `channels:history`, `groups:history`, `im:history`, and `mpim:history`
for public channels, private channels, direct messages, and group direct messages
respectively. Updating the generated manifest or adding a scope in the app settings
does not grant that permission to an existing installation until it is authorized.

1. Open your existing app at [Slack app settings](https://api.slack.com/apps).
2. Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add `files:read`,
   `channels:history`, `groups:history`, `im:history`, and `mpim:history`.
3. Open the OAuth install URL printed by the updated `bgagent slack setup` wizard.
   You can also reuse the original wizard's URL, adding those history/file scopes to its
   comma-separated `scope` parameter while preserving its `client_id` and
   `redirect_uri`. The redirect must remain your platform's
   `/v1/slack/oauth/callback` URL.
4. Select the intended workspace and click **Allow**. Request administrator
   approval if your workspace requires it.
5. Wait for the platform's success page. Its callback stores the refreshed bot
   token in Secrets Manager and records the granted scopes automatically.

Use this callback flow rather than a dashboard-only install. You do not need to
recreate the app, paste a bot token, or relink users whose account mappings already
exist. Slack permissions are additive across installations; see the
[Slack OAuth guide](https://docs.slack.dev/authentication/installing-with-oauth/).

To test, attach a **PNG or JPEG of 500 KB or less** to the same Slack message as
your `@Shoof` task prompt. This permission update keeps the existing 500 KB inline
attachment limit and image screening/storage flow. Historical attachment names
can appear in thread context, but their contents are not downloaded. Attach an image to the current message if the agent needs to see it.

### Step 6: Link your account

In Slack:
```
/bgagent link
```

In your terminal:
```bash
bgagent slack link <CODE>
```

This one-time step connects your Slack identity to your ABCA (Cognito) account. The code expires in 10 minutes.

### Step 7: Test it

In any channel where Shoof is added:
```
@Shoof fix the README typo in org/repo#1
```

You should see:
- :eyes: reaction on your message immediately
- A "Task submitted" message in the thread
- :hourglass_flowing_sand: reaction when the agent starts
- :white_check_mark: reaction and "Task completed" with a View PR button when done

## Usage

### Submit a task

Mention Shoof with a repo and description:
```
@Shoof fix the login bug in org/repo#42
@Shoof update the README in org/repo
```

For private submissions, DM Shoof directly:
```
fix the login bug in org/repo#42
```

### Follow-up requests and thread history

Replies that mention `@Shoof` automatically include earlier text from the same
thread. Your latest message is the current request; earlier messages provide
context. This applies to threaded direct messages too. A new top-level message
has no earlier thread context, and plain channel replies without an `@Shoof`
mention do not submit tasks.

For example, reply in the task's thread:

```text
@Shoof develop SESSION_ID owner/repo Fix the registration error you reported above, redeploy the development preview, and verify it in the browser.
```

To ignore the earlier conversation for one request:

```text
@Shoof --history=off develop SESSION_ID owner/repo Change the background to dark blue and deploy the development preview.
```

Use `--history=on` to explicitly include history. Put either flag before your task
description, for example before `develop`, after `develop`, or after the session
ID. Omitting the flag defaults to on for thread replies. A flag written inside
ordinary task prose is treated as prose. Conflicting or invalid control flags
return usage guidance. Each sender controls their own request; these flags do
not change a shared or persistent preference.

Development requests can reuse the thread's saved session and repository,
independently of history. This association comes from trusted platform records;
message history never selects a session or a production action. Earlier
`promote` commands do not promote a follow-up automatically.

The task acknowledgement states whether history was included, disabled, empty,
or truncated. History contains the original root and recent eligible messages,
up to 20 messages, 2,000 characters per message, and 16,000 characters total.
The combined task description must still fit the existing 10,000-character
limit, so long current requests leave less room for context. Prior human
messages and Shoof answers (including block text) are included; other bots and
system events are ignored. Only messages before the triggering command are
eligible. Historical attachments contribute at most three file names per
message; contents are not loaded. Included text is saved with the task, like
other task instructions, and sent to the coding agent.

Retrieval is bounded to three pages of 100 messages, an eight-second API window,
and 512 KB per API response. Very long threads, missing permissions, Slack rate
limits, or API failures prevent submission with a clear error. Retry after
fixing the problem or use `--history=off` with a self-contained request. Shoof
must have access to the channel; invite it to private channels. Existing
installations need the reauthorization flow above after deployment; changing a
manifest alone does not grant scopes. See Slack's
[thread retrieval reference](https://docs.slack.dev/reference/methods/conversations.replies/).

### Automatic workflow continuation

After deploying a platform version with workflow-aware thread reuse, start work
with a repository (or use the channel's configured default):

```text
@Shoof develop owner/repo Build a playable Tetris app.
@Shoof owner/repo Fix the registration bug and open a PR.
```

The first starts development without a PR. The second uses the normal PR
workflow. In either thread, follow up without repeating the repository or mode:

```text
@Shoof Fix the keyboard controls.
@Shoof Address the remaining review findings.
```

Shoof resolves the linked sender's context from persisted platform task records:

| Thread context | Follow-up behavior |
| --- | --- |
| Development session | Append commits to the same development branch, without opening a PR |
| Existing open PR | Use PR iteration to update the same PR head branch |
| No context | Use the normal new-task workflow; require a repository or channel default |

Continuation does not merge a PR or authorize a production deployment. Each
request creates a separate task execution; branch/workflow reuse does not keep
an agent process or its private reasoning memory alive. The acknowledgement
shows the resolved repository, workflow and new/reused status, plus the session
ID or existing PR number when available.

#### Start fresh or override the context

```text
@Shoof --session=new Build a separate fix.
@Shoof --session=new develop Build a fresh development version.
@Shoof develop SESSION_ID Continue the previous design.
```

`--session=new` starts separate work in the inherited mode. In a PR thread it
starts a new PR task; in a development thread it starts a new development
session. With no saved context it uses the normal PR workflow unless `develop`
is explicit. Fresh work starts from the configured production/base branch
(normally `main`), and preserves old branches, commits and previews. On legacy
threads with ambiguous context, `--session=new owner/repo ...` deliberately
bypasses discovery; include `develop` if you want fresh development work.

An explicit `develop` switches a PR thread into development. An explicit
SESSION_ID selects an owned development session; do not combine it with
`--session=new`. A supplied repository and session ID must match. A different
explicit repository starts fresh in the resolved mode and never inherits the
previous repository's PR or session. An explicit `owner/repo#ISSUE_NUMBER`
without a mode control starts fresh issue work in the resolved mode rather
than silently continuing the bound PR. Put repository, session and option controls
before task prose. File paths and URLs in reply prose are not routing controls.
For first top-level requests, the existing natural-language `in owner/repo`
syntax remains supported.

There is one active default per linked sender and Slack thread. Other senders,
channels, workspaces and top-level messages have separate defaults. Only
successfully admitted requests change the default.

#### History is independent

```text
@Shoof --history=off Fix the background color.
@Shoof --history=on Address the earlier feedback.
@Shoof --history=off --session=new Build a separate fix.
```

History-off requests still resolve the workflow, repo and branch from trusted
platform records and make no Slack history calls. History-on requests include
separately delimited earlier conversation as context; history cannot override
routing or authorization. Supply a PR URL in the current request when it is
needed as task context and earlier messages are omitted. Missing history scopes
produce reauthorization guidance before admission. See the history section above.

#### Validation and recovery

Wait for the current task to finish (or cancel it) before continuing the same
working branch. Missing saved PR metadata or active-task conflicts are rejected
before admission. A failed iteration can still continue the PR identified by
its verified lineage root.

PR follow-ups are accepted first. Before coding starts, the orchestrator uses
its existing GitHub credential access to validate the current PR state, push
permission and saved head branch. Closed/merged PRs, deleted/fork/changed heads,
or unavailable credentials fail the accepted task and are reported in Slack;
the accepted thread binding has already advanced. The platform never silently
creates a different PR. Repositories continue using their configured Blueprint
credential, including custom repository credentials; the Slack processor does
not read the GitHub credential.

Promoted/frozen development sessions retain their existing protections.
Promotion remains explicit:

```text
@Shoof promote SESSION_ID owner/repo
```

Older threads use bounded owner-indexed task metadata lookups. Ordinary PR tasks
without a development session ID are valid PR context. Multiple matching
sessions/PRs or an exhausted search require explicit routing or fresh work;
no table scans or model-selected branches are used. A missing or expired context
can be replaced with `--session=new owner/repo ...`. Storage failures require
retrying rather than silently starting fresh.

Task admission, lineage reservation and the thread binding update are atomic.
Duplicate messages reuse their accepted task, and late older commands cannot
roll the default back. Send a new Slack message to retry an unadmitted request
after a newer command has advanced the thread.

Bindings use isolated records in the existing Slack user-mapping table and
expire according to task retention. They do not appear as account links or
channel default mappings. Workflow reuse requires no new Slack scopes or IAM permissions. GitHub
credentials remain in the orchestrator/runtime; the Slack processor does not
receive access to the GitHub token secret.

### Plan an intent

When the platform console is enabled, add a Slack slash command named `/plan` to the existing Shoof app. Set its request URL to the same URL as `/bgagent` (ending in `/slack/commands`). The generated app manifest includes both commands for new installations.

1. Link your Slack account, then enter `/plan owner/repo describe your idea` for an onboarded repository with an initial commit.
2. Open the private workspace link and sign in with Cognito. The Intents area is separate from repository and integration administration.
3. Generate and answer questions for Intent capture, Requirements, and Acceptance criteria. These stages adapt the [pinned AWS Labs AI-DLC workflow](https://github.com/awslabs/aidlc-workflows/tree/ab95815fa00647fe611c746619a6f34e385ca62c) and use the repository README at the starting commit as context.
4. To invite a contributor or reviewer, ask for their platform member ID from the Intents landing screen, add them by role, and share the workspace link. Contributors can answer and comment. Reviewers can read and comment. The owner can assign questions, remove members, approve stages, and publish.
5. Approve each stage to commit its decisions to the planning branch. Use **Review spec** to review the approved stages, then **Publish intent** to commit the complete Markdown spec. Use **Published versions** to download the exact file or open it on GitHub.
6. Copy the develop command and mention Shoof in Slack. An intent starts a new development session from the published commit. Later plan versions leave the original build input intact.

Publishing an intent creates no task or pull request. Working answers and comments stay in the workspace until stage approval. A subsequent development run follows the usual development rules and requires an explicit deployment request for a preview.

### Connect to a task’s terminal

When an AgentCore task starts, its Slack message includes **Connect terminal** next to **Cancel Task**. Eligible completion responses also include **Connect terminal**, alongside any PR or development-preview links, including **Work needs attention** summaries. Click it to receive a private reply with a ready-to-paste command. Only the linked Slack user who submitted the task can retrieve its command, from the original conversation.

On your laptop:

1. Install an [AgentCore CLI with command-shell support](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-command-shell.html). Check `agentcore runtime shell --help`; the older Python CLI may not include this command.
2. Select and authenticate your AWS profile, for example `export AWS_PROFILE=default` and `aws sso login --profile default` if your profile uses SSO. Your local AWS identity needs `bedrock-agentcore:InvokeAgentRuntimeCommandShell` access to the runtime. This feature does not add IAM permissions or create credentials.
3. Paste the private command. It explicitly selects the original task’s runtime, region, qualifier, runtime session and debug shell. A development session ID or branch name cannot replace the runtime session ID.

This opens a separate shell in the agent’s environment. For a running task, the coding agent continues independently. It does not take over the agent conversation. Use **Ctrl+]** to detach and paste the same command to reconnect to the same debug shell. `exit` or **Ctrl+D** closes that shell. Coordinate file edits with the running agent to avoid simultaneous changes.

Running and approval-waiting tasks retain heartbeat checks. Completed tasks no longer need a fresh heartbeat, because their heartbeat writer stops normally. Their private reply describes inspection or independent manual work; manual edits do not change the completed task's recorded result or create a new platform task.

For completed tasks, the connection window ends eight hours after the earlier of task creation and recorded start. Task creation precedes compute provisioning, so this is a conservative bound: queue and startup time reduce the window. Completion does not start another eight-hour period. Missing or malformed creation/start/completion metadata, changed handles, expired windows, cancelled/timed-out/failed tasks and unsupported backends do not offer access. No runtime timeouts are extended.

The button and command use metadata-based eligibility, not an authoritative live-compute check. No shell or invoking probe is opened by clicking the button. The native CLI performs the connection when you run it. [AWS can provision fresh compute when a stopped logical session is invoked](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), so a saved command cannot guarantee that the original container or workspace survives. The copied command always targets the original task's runtime/session, even when the Slack thread has newer tasks.

The shared Slack message contains only the task button; runtime identifiers appear in the private reply. No AWS credentials or presigned shell URL are included. Private replies have a short delivery deadline to preserve Slack’s acknowledgement window. If a reply is missing, retry the button; Lambda cold starts or Slack delivery failures can still cause a timeout.

### Cancel a task

Click the **Cancel Task** button in the thread while the agent is working.

### Get help

```
/bgagent help
```

### Slash commands

| Command | Purpose |
|---------|---------|
| `/bgagent link` | Link your Slack account (one-time) |
| `/bgagent help` | Show usage instructions |

## Troubleshooting

### @Shoof doesn't respond

1. Is Shoof added to the channel? Use `/invite @Shoof` or add via channel settings.
2. Were credentials entered correctly? Delete the app and re-run `bgagent slack setup`.
3. Check CloudWatch logs for the `SlackEventsFn` Lambda — look for "Invalid Slack event signature" (wrong signing secret).

### "Your Slack account is not linked"

Run `/bgagent link` in Slack, then `bgagent slack link <code>` in your terminal.

### "Repository not onboarded"

The repo must be registered with a Blueprint before submitting tasks. See the [User guide](./USER_GUIDE.md).

### OAuth install fails (bad_client_secret)

The credentials stored don't match your app. Delete the app and re-run `bgagent slack setup`, making sure to paste the correct values.

### Event Subscriptions URL doesn't verify

Click **Retry** — the first attempt times out due to Lambda cold start. The retry succeeds.

## Multi-workspace support

The integration supports multiple Slack workspaces. Each workspace admin opens the OAuth install URL from `bgagent slack setup` output. Per-workspace bot tokens are stored separately. Users in each workspace link their accounts independently.

## Removing the integration

To uninstall from a workspace: **Slack → Settings → Manage Apps → Shoof → Remove App**. The bot token is automatically scheduled for deletion.

To remove the Slack integration from your ABCA deployment entirely, delete the Slack App and redeploy without it.
