# Versioned development sessions

Development mode saves commits to a persistent GitHub branch without creating a pull request. Explicit promotion freezes the session and opens a PR against its production branch. Existing tasks keep their usual PR-based behavior.

This feature requires deploying this platform fork and rebuilding the CLI. It is not enabled by changing a task prompt on an older deployment.

## CLI

Start a session (the response includes its development session ID):

```sh
bgagent submit --repo owner/application --develop --production-branch main \
  --task "Build a playable Tetris game" --wait
```

Continue using the returned development session ID:

```sh
bgagent submit --repo owner/application --development-session SESSION_ID \
  --task "Add a next-piece preview and improve the controls" --wait
```

Promote the saved revision:

```sh
bgagent submit --repo owner/application --promote SESSION_ID --wait
```

Promotion creates a PR from `bgagent/releases/SESSION_ID` to the session's configured production branch. It does not merge or deploy the PR. Configure your application repository's deployment workflow to run after a reviewed PR merges if you want merging to deploy it.

The production branch defaults to `main`. Set `--production-branch` at session creation for a repository that releases from another branch. It cannot change during the session.

## Slack

Use the configured bot mention (examples use `@Shoof`), or send it a direct message:

```text
@Shoof develop owner/application Build a playable Tetris game
@Shoof develop SESSION_ID owner/application Add a next-piece preview
@Shoof promote SESSION_ID owner/application
```

Specify the repository, or use the channel's onboarded default. Continue with the session ID reported in the completion message; a thread alone does not select a development session. The slash command's existing account-link/help behavior is unchanged. Your Slack account must be linked to your platform account and the channel must be allowed.

## Jira

Include the `bgagent-dev` label alongside the configured trigger label (usually `bgagent`) **before triggering the issue**. The initial task starts a development session. Subsequent `@bgagent` comments continue that session even though it has no PR:

```text
@bgagent Add a next-piece preview
@bgagent promote
```

Promotion is recognized only when the instruction is exactly `promote`; mentioning promotion inside ordinary prose does not release anything. The commenter must resolve to the session owner's platform identity. A linked different user cannot take over another user's session.

## API

Submit through the existing authenticated `POST /tasks` endpoint:

```json
{
  "repo": "owner/application",
  "workflow_ref": "coding/new-task-v1",
  "development_action": "develop",
  "production_branch": "main",
  "task_description": "Build a playable Tetris game"
}
```

For a continuation include `development_session_id`. For promotion send `development_action: "promote"` and that session ID; a task description is optional. Responses expose `development_session_id`, `development_action`, `production_branch`, `branch_name`, and the verified `head_sha` once saved.

## Delivery and concurrency

- Each session belongs to one platform user and one repository. API admission checks both on every continuation and promotion.
- Only one task may advance a session at a time. Concurrent submissions receive a conflict rather than creating competing branches. Wait for the active task to finish, or cancel it, before retrying.
- Iterations fetch the saved branch and verify its expected commit. A deleted or unexpectedly changed branch produces an error; the runtime does not silently start from `main`.
- The runtime commits outstanding changes, pushes without force, and verifies that GitHub advertises the exact commit before reporting saved work. Build failures still report task failure even if the changes were saved.
- Promotion runs deterministically without generating new code. It copies the verified revision to a release branch and reuses an existing PR on retries, including after an ambiguous response or a closed PR.
- Promotion freezes further development in that session, even if promotion fails partway through. Retry promotion to recover it. Start a new session for later development; do not manually rewrite its branch.
- Sessions are anchored by their first task record and use the deployment's task-retention period. Keep branches and retain task records for sessions you need to continue.

Preview environments are not provisioned by this feature. GitHub token permissions still need Contents and Pull requests write access; modifying workflows additionally requires Workflows write permission.
