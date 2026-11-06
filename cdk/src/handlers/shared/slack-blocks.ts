/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { formatDuration, truncate } from './slack-format';
import { HISTORY_MAX_MESSAGES } from './slack-thread-history';
import { terminalHandle, TerminalUnavailableError, type TerminalTask } from './terminal-command';

/** Max length for task-failure reason text in Slack blocks. */
const TASK_FAILED_REASON_MAX_LEN = 300;
const SUMMARY_ITEMS_MAX = 3;
const SUMMARY_SECTION_MAX_LEN = 2800;
import type { TaskRecord } from './types';

/** A Slack Block Kit mrkdwn text object. */
interface MrkdwnText {
  readonly type: 'mrkdwn';
  readonly text: string;
  readonly verbatim?: boolean;
}

/** A Slack Block Kit plain_text text object. */
interface PlainText {
  readonly type: 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

/** Section block: a single line/paragraph of mrkdwn content. */
export interface SectionBlock {
  readonly type: 'section';
  readonly text: MrkdwnText;
  readonly block_id?: string;
}

/** Link-out button: opens a URL in a new tab. No action_id needed. */
export interface LinkButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly url: string;
  readonly style?: 'primary' | 'danger';
}

/** Actionable button: triggers a Block Kit interaction callback via action_id. */
export interface ActionButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly action_id: string;
  readonly style?: 'primary' | 'danger';
  readonly confirm?: {
    readonly title: PlainText;
    readonly text: MrkdwnText;
    readonly confirm: PlainText;
    readonly deny: PlainText;
  };
}

export type ButtonElement = LinkButtonElement | ActionButtonElement;

/** Actions block: a row of interactive elements (buttons, menus, etc.). */
export interface ActionsBlock {
  readonly type: 'actions';
  readonly block_id: string;
  readonly elements: ReadonlyArray<ButtonElement>;
}

/** Any Block Kit block this module renders. */
export type SlackBlock = SectionBlock | ActionsBlock;

/** A Slack message payload suitable for chat.postMessage. */
export interface SlackMessage {
  /** Fallback plain-text for notifications. */
  readonly text: string;
  /** Block Kit blocks for rich rendering. */
  readonly blocks: SlackBlock[];
  /** If set, post as a threaded reply. */
  readonly thread_ts?: string;
}

/**
 * Render a task event as a Slack Block Kit message.
 *
 * @param eventType - the task event type (e.g. 'task_created', 'task_completed').
 * @param task - the task record with current state.
 * @param eventMetadata - optional metadata from the event record.
 * @returns a SlackMessage payload.
 */
export function renderSlackBlocks(
  eventType: string,
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description' | 'pr_url' | 'error_message' | 'cost_usd' | 'duration_s' | 'status'> & Partial<Pick<TaskRecord, 'development_session_id' | 'development_action' | 'branch_name' | 'head_sha' | 'completion_summary' | 'channel_metadata' | 'session_id' | 'agent_runtime_arn' | 'compute_type' | 'started_at' | 'agent_heartbeat_at'>>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  switch (eventType) {
    case 'task_created':
      return taskCreatedMessage(task);
    case 'session_started':
      return sessionStartedMessage(task);
    case 'task_completed':
      return taskCompletedMessage(task);
    case 'task_failed':
      return taskFailedMessage(task, eventMetadata);
    case 'task_cancelled':
      return simpleStatusMessage(task, ':no_entry_sign: Task cancelled');
    case 'task_timed_out':
      return taskTimedOutMessage(task);
    case 'task_stranded':
      // Emitted by reconcile-stranded-tasks when a task's heartbeat
      // stops. Operators see this on stranded Slack-origin tasks; the
      // generic "Event: ..." fallback would be a UX regression
      // (issue #64 review Cat 7).
      return taskStrandedMessage(task, eventMetadata);
    case 'agent_error':
      return agentErrorMessage(task, eventMetadata);
    default:
      return simpleStatusMessage(task, `Event: ${eventType}`);
  }
}

function taskCreatedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description'> & Partial<Pick<TaskRecord, 'channel_metadata' | 'development_session_id' | 'pr_number'>>,
): SlackMessage {
  const request = task.channel_metadata?.slack_request_preview ?? task.task_description;
  const desc = request
    ? `\n${truncate(request, 200)}`
    : '';
  const context = task.channel_metadata;
  const count = Number(context?.slack_history_count);
  const history = context?.slack_history_status === 'included' && Number.isInteger(count) && count > 0 && count <= HISTORY_MAX_MESSAGES
    ? `\nThread history: ${count} message(s) included${context?.slack_history_truncated === 'true' ? ' (truncated)' : ''}.`
    : context?.slack_history_status === 'disabled' ? '\nThread history: off for this request.'
      : context?.slack_history_status === 'none' ? '\nThread history: no earlier messages.' : '';
  const session = task.development_session_id && ['new', 'reused'].includes(context?.slack_session_mode ?? '')
    ? `\nSession: \`${task.development_session_id}\` (${context?.slack_session_mode})` : '';
  const workflow = context?.slack_workflow_mode === 'pr'
    ? `\nWorkflow: PR (${context?.slack_session_mode === 'reused' ? 'reused' : 'new'})${task.pr_number ? ` — PR #${task.pr_number}` : ''}` : '';
  const text = `:rocket: *Task submitted* for \`${task.repo}\`${desc}${history}${session}${workflow}\n_ID:_ \`${task.task_id}\``;
  return {
    text: `Task submitted for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskCompletedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'pr_url' | 'cost_usd' | 'duration_s'> & Partial<Pick<TaskRecord, 'development_session_id' | 'development_action' | 'branch_name' | 'head_sha' | 'completion_summary' | 'channel_metadata'>>,
): SlackMessage {
  const reported = task.completion_summary;
  const blocked = summaryItems(reported?.blockers).length > 0;
  const heading = blocked ? 'Work needs attention' : 'Task completed';
  const parts = [`${blocked ? ':warning:' : ':white_check_mark:'} *${heading}* for \`${task.repo}\``];
  if (task.development_session_id) {
    parts.push(`Session: \`${task.development_session_id}\` (${task.development_action})`);
    if (task.head_sha) parts.push(`Saved: \`${task.branch_name}@${task.head_sha}\``);
  }
  const stats: string[] = [];
  if (task.duration_s != null) stats.push(formatDuration(task.duration_s));
  if (task.cost_usd != null) stats.push(`$${Number(task.cost_usd).toFixed(2)}`);
  if (stats.length > 0) parts.push(stats.join(' · '));
  const text = parts.join('\n');

  const outcome = completionSummaryBlock(reported);
  const blocks: SlackBlock[] = outcome ? [section(parts[0]), outcome] : [section(text)];
  if (outcome && parts.length > 1) blocks.push(section(parts.slice(1).join('\n')));

  const buttons: LinkButtonElement[] = [];
  const previewUrl = safePreviewUrl(reported?.development_url);
  if (previewUrl) buttons.push(linkButton('Open development preview', previewUrl));

  // "View PR" button — no inline link text, so Slack won't unfurl a big preview card.
  if (task.pr_url) {
    buttons.push(linkButton(`View PR ${prLabel(task.pr_url)}`, task.pr_url));
  }
  if (buttons.length) blocks.push(actions(task.task_id, buttons));

  return {
    text: reported
      ? `${heading} for ${task.repo}: ${safeSummaryText(reported.summary, 200)}${previewUrl ? ` — ${previewUrl}` : ''}`
      : `Task completed for ${task.repo}`,
    blocks,
  };
}

/** Treat model text as data: disable Slack mentions, link syntax and auto parsing. */
function safeSummaryText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return truncate(value.replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b'), limit);
}

function summaryItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SUMMARY_ITEMS_MAX).map(item => safeSummaryText(item, 200)).filter(Boolean);
}

function safePreviewUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1000 || /[\s<>|`\\]/.test(value)) return undefined;
  if (Array.from(value).some(c => c < ' ')) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.search || url.hash
      || value.includes('[REDACTED') || value.includes('***')) return undefined;
    return url.href;
  } catch {
    // nosemgrep: ts-silent-success-masking -- invalid URL is rejected, never published
    return undefined;
  }
}

function completionSummaryBlock(reported: TaskRecord['completion_summary']): SectionBlock | undefined {
  if (!reported) return undefined;
  const lines: string[] = [];
  const summary = safeSummaryText(reported.summary, 500);
  if (summary) lines.push(summary);
  const verification = summaryItems(reported.verification);
  const blockers = summaryItems(reported.blockers);
  if (blockers.length) lines.push(`*Blockers:* ${blockers.join(' · ')}`);
  if (verification.length) lines.push(`*Checks (agent reported):* ${verification.join(' · ')}`);
  if (!lines.length) return undefined;
  // Escape expansion can increase length; cap the section below Slack's 3000 limit.
  return { type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), SUMMARY_SECTION_MAX_LEN), verbatim: true } };
}

function taskFailedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'error_message' | 'completion_summary'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  const reason = task.error_message
    ?? (eventMetadata?.error as string | undefined)
    ?? 'Unknown error';
  const text = `:x: *Task failed* for \`${task.repo}\`\n_Reason:_ ${truncate(reason, TASK_FAILED_REASON_MAX_LEN)}`;
  const blocks = [section(text)];
  const outcome = completionSummaryBlock(task.completion_summary);
  if (outcome) blocks.push(outcome);
  return {
    text: `Task failed for ${task.repo}`,
    blocks,
  };
}

function taskTimedOutMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'duration_s'>,
): SlackMessage {
  const duration = task.duration_s != null ? ` after ${formatDuration(task.duration_s)}` : '';
  const text = `:hourglass: *Task timed out* for \`${task.repo}\`${duration}`;
  return {
    text: `Task timed out for ${task.repo}`,
    blocks: [section(text)],
  };
}

function sessionStartedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'> & TerminalTask,
): SlackMessage {
  const text = `:hourglass_flowing_sand: Agent started working on \`${task.repo}\``;
  let connect: ButtonElement[] = [];
  try {
    terminalHandle(task);
    connect = [{ type: 'button', text: { type: 'plain_text', text: 'Connect terminal' }, action_id: `connect_terminal:${task.task_id}` }];
  } catch (error) {
    if (!(error instanceof TerminalUnavailableError)) throw error;
    // Session-start events can be delivered after a task completes, or without a handle.
    // The existing status/cancel presentation is preserved; no attach action is offered.
  }
  return {
    text: `Agent started working on ${task.repo}`,
    blocks: [
      section(text),
      actions(task.task_id, [
        ...connect,
        dangerButton('Cancel Task', `cancel_task:${task.task_id}`),
      ]),
    ],
  };
}

function taskStrandedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
  // ``prior_status`` on the event metadata (see
  // handlers/reconcile-stranded-tasks.ts). Surface the prior status so
  // operators can tell at a glance whether the task hung in HYDRATING
  // vs RUNNING.
  const priorStatus = typeof eventMetadata?.prior_status === 'string'
    ? eventMetadata.prior_status
    : undefined;
  const detail = priorStatus ? ` (last status: ${priorStatus})` : '';
  const text = `:warning: *Task stranded* for \`${task.repo}\`${detail}`;
  return {
    text: `Task stranded for ${task.repo}`,
    blocks: [section(text)],
  };
}

function agentErrorMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // ``agent/src/progress_writer.py::write_agent_error`` carries
  // ``error_type`` and ``message_preview``. Render whichever is
  // present without leaking the full preview if it's noisy.
  const errorType = typeof eventMetadata?.error_type === 'string'
    ? eventMetadata.error_type
    : undefined;
  const preview = typeof eventMetadata?.message_preview === 'string'
    ? eventMetadata.message_preview
    : undefined;
  const detail = errorType
    ? `\n_Type:_ \`${errorType}\``
    : '';
  const previewLine = preview ? `\n${truncate(preview, 200)}` : '';
  const text = `:rotating_light: *Agent error* during \`${task.repo}\`${detail}${previewLine}`;
  return {
    text: `Agent error during ${task.repo}`,
    blocks: [section(text)],
  };
}

function simpleStatusMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  label: string,
): SlackMessage {
  const text = `${label} for \`${task.repo}\`\n_ID:_ \`${task.task_id}\``;
  return {
    text: `${label} for ${task.repo}`,
    blocks: [section(text)],
  };
}

function section(text: string): SectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function actions(blockId: string, elements: ReadonlyArray<ButtonElement>): ActionsBlock {
  return { type: 'actions', block_id: blockId, elements };
}

function linkButton(label: string, url: string): LinkButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    url,
    style: 'primary',
  };
}

function dangerButton(label: string, actionId: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: actionId,
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: 'Cancel task?' },
      text: { type: 'mrkdwn', text: 'This will stop the running agent.' },
      confirm: { type: 'plain_text', text: 'Cancel' },
      deny: { type: 'plain_text', text: 'Keep running' },
    },
  };
}

function prLabel(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)$/);
  return match ? `#${match[1]}` : 'Pull Request';
}
