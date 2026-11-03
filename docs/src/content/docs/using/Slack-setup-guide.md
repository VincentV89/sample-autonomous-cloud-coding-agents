---
title: Slack setup guide
---

# Slack integration setup guide

This guide walks through setting up the ABCA Slack integration. Once configured, your team can submit tasks by mentioning `@Shoof` in any channel and receive real-time notifications as tasks progress.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction))
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
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

![App Credentials location](/sample-autonomous-cloud-coding-agents/imgs/find-credentials.png)

Format validation catches obvious typos (wrong length, non-hex characters). If the format is wrong, it loops back to re-enter. Note: the actual values cannot be verified until the app is installed — if you paste the wrong secret by mistake, you'll get an error at install time.

### Step 4: Verify Event Subscriptions

In the Slack App dashboard, go to **Event Subscriptions**:

![Finding Event Subscriptions](/sample-autonomous-cloud-coding-agents/imgs/find-even-subscriptions.png)

1. The Request URL may show "Your URL didn't respond" — click **Retry**
2. Wait for the green "Verified" checkmark
3. Click **Save Changes**

![Event Subscriptions before](/sample-autonomous-cloud-coding-agents/imgs/enable-events-before.png)

Click **Retry** and wait for the green checkmark:

![Event Subscriptions after](/sample-autonomous-cloud-coding-agents/imgs/enable-events-after.png)

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

Continue to specify the repository and `SESSION_ID` when continuing saved work.
Thread history does not infer a repository, resume a development session, or
promote work automatically. A channel's configured default repository still
works when the current command omits a repository. Earlier `develop` or
`promote` commands do not change the current command's action.

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

The repo must be registered with a Blueprint before submitting tasks. See the [User guide](/sample-autonomous-cloud-coding-agents/using/overview).

### OAuth install fails (bad_client_secret)

The credentials stored don't match your app. Delete the app and re-run `bgagent slack setup`, making sure to paste the correct values.

### Event Subscriptions URL doesn't verify

Click **Retry** — the first attempt times out due to Lambda cold start. The retry succeeds.

## Multi-workspace support

The integration supports multiple Slack workspaces. Each workspace admin opens the OAuth install URL from `bgagent slack setup` output. Per-workspace bot tokens are stored separately. Users in each workspace link their accounts independently.

## Removing the integration

To uninstall from a workspace: **Slack → Settings → Manage Apps → Shoof → Remove App**. The bot token is automatically scheduled for deletion.

To remove the Slack integration from your ABCA deployment entirely, delete the Slack App and redeploy without it.
