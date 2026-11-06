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

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { logger } from './shared/logger';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';
import { terminalPrivateMessage, TerminalUnavailableError } from './shared/terminal-command';
import type { TaskRecord } from './shared/types';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;

interface SlackInteractionPayload {
  readonly type: string;
  readonly team?: { readonly id: string };
  readonly message?: { readonly ts?: string; readonly thread_ts?: string };
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly actions?: ReadonlyArray<{
    readonly action_id: string;
    readonly block_id: string;
    readonly value?: string;
  }>;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly channel?: { readonly id: string };
}

/**
 * POST /v1/slack/interactions — Handle Slack Block Kit interactive actions.
 *
 * Slack sends interaction payloads as a URL-encoded `payload` field in the body.
 * Currently handles:
 * - `connect_terminal:{task_id}` — Return a private native AgentCore shell command.
 * - `cancel_task:{task_id}` — Cancel a running task via the "Cancel Task" button.
 */
const TERMINAL_PREPARE_MS = 1800;
const TERMINAL_REPLY_MS = 450;
const TERMINAL_ACTION = 'connect_terminal:';
const TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A separate bounded path leaves cancellation behavior unchanged. */
export async function handler(event: APIGatewayProxyEvent, context?: Pick<Context, 'callbackWaitsForEmptyEventLoop'>): Promise<APIGatewayProxyResult> {
  let payload: SlackInteractionPayload | undefined;
  try {
    const raw = new URLSearchParams(event.body ?? '').get('payload');
    if (raw) payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    // Existing validation owns malformed non-terminal requests.
  }
  if (payload?.type === 'block_actions' && Array.isArray(payload.actions)
    && payload.actions.some(action => typeof action?.action_id === 'string' && action.action_id.startsWith(TERMINAL_ACTION))) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    return handleTerminalInteraction(event, payload);
  }
  return handleExistingInteraction(event);
}

function trustedResponseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash && /^\/(actions|services)\//.test(url.pathname);
  } catch { return false; }
}

async function handleTerminalInteraction(event: APIGatewayProxyEvent, payload: SlackInteractionPayload): Promise<APIGatewayProxyResult> {
  const controller = new AbortController();
  let verified = false;
  let invalidSignature = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text: string;
  const prepare = async (): Promise<string> => {
    verified = await verifySlackRequest(SIGNING_SECRET_ARN,
      event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '',
      event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '', event.body!);
    if (!verified) { invalidSignature = true; throw new Error('Invalid Slack signature'); }
    controller.signal.throwIfAborted();
    if (!trustedResponseUrl(payload.response_url)) throw new TerminalUnavailableError('Private response unavailable. Retry from the original task message.');
    const action = payload.actions?.[0];
    const id = action?.action_id?.slice(TERMINAL_ACTION.length) ?? '';
    const teamId = payload.team?.id ?? payload.user?.team_id;
    const userId = payload.user?.id;
    const channel = payload.channel?.id;
    if (payload.actions?.length !== 1 || !TASK_ID.test(id) || !/^T[A-Z0-9]+$/.test(teamId ?? '')
      || !/^[UW][A-Z0-9]+$/.test(userId ?? '') || !/^[CDG][A-Z0-9]+$/.test(channel ?? '')
      || payload.team?.id && payload.user?.team_id && payload.team.id !== payload.user.team_id) {
      throw new TerminalUnavailableError('Terminal unavailable for this interaction. Use the original task message.');
    }
    // Independent consistent reads; authorization is checked before any task metadata is returned.
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- exactly two fixed reads, never a user-sized collection
    const [mapping, result] = await Promise.all([
      ddb.send(new GetCommand({ TableName: USER_MAPPING_TABLE, Key: { slack_identity: `${teamId}#${userId}` }, ConsistentRead: true }), { abortSignal: controller.signal }),
      ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: id }, ConsistentRead: true }), { abortSignal: controller.signal }),
    ]);
    controller.signal.throwIfAborted();
    // Confirmed mappings written by slack-link omit status; pending links carry it.
    // Accept that canonical format and explicit active records, but no other state.
    const linkStatus = mapping.Item?.status;
    const owner = mapping.Item?.platform_user_id;
    if (linkStatus !== undefined && linkStatus !== 'active' || typeof owner !== 'string' || !owner.trim()) {
      throw new TerminalUnavailableError('Link your Slack account with /bgagent link before connecting to a terminal.');
    }
    const authorized = (task: TaskRecord | undefined): task is TaskRecord => {
      const metadata = task?.channel_metadata;
      return !!task && task.task_id === id && task.user_id === owner && task.channel_source === 'slack'
        && metadata?.slack_team_id === teamId && metadata.slack_channel_id === channel && metadata.slack_user_id === userId
        && (!payload.message?.thread_ts || metadata.slack_thread_ts === payload.message.thread_ts);
    };
    const first = result.Item as TaskRecord | undefined;
    if (!authorized(first)) {
      throw new TerminalUnavailableError('Terminal unavailable: you can only connect to your own task from its original Slack conversation.');
    }
    // Close the common click/completion race and never redirect an old button to a newer task/session.
    const freshResult = await ddb.send(new GetCommand({
      TableName: TASK_TABLE, Key: { task_id: id }, ConsistentRead: true,
    }), { abortSignal: controller.signal });
    const fresh = freshResult.Item as TaskRecord | undefined;
    controller.signal.throwIfAborted();
    if (!authorized(fresh) || fresh.session_id !== first.session_id || fresh.agent_runtime_arn !== first.agent_runtime_arn) {
      throw new TerminalUnavailableError('Terminal unavailable: the task session changed. Retry from the current task message.');
    }
    return terminalPrivateMessage(fresh, owner);
  };
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Terminal preparation deadline')); }, TERMINAL_PREPARE_MS);
    });
    text = await Promise.race([prepare(), deadline]);
  } catch (error) {
    text = error instanceof TerminalUnavailableError ? error.message : 'Unable to prepare the terminal command right now. Please retry.';
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  if (invalidSignature) return jsonResponse(401, { error: 'Invalid signature' });
  if (verified && trustedResponseUrl(payload.response_url)) {
    try {
      const response = await fetch(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TERMINAL_REPLY_MS),
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
      });
      if (!response.ok) logger.warn('Private terminal response rejected', { status: response.status });
    } catch {
      // Do not log the response URL (a Slack capability), connection command or credentials.
      logger.warn('Private terminal response could not be delivered');
    }
  }
  return jsonResponse(200, {});
}

async function handleExistingInteraction(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret (re-fetches if the cached value was rotated out).
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);
    if (!signingSecret) {
      logger.error('Slack signing secret not found');
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack interaction signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    // Parse the payload — Slack sends it as URL-encoded `payload=<json>`.
    const params = new URLSearchParams(event.body);
    const payloadStr = params.get('payload');
    if (!payloadStr) {
      return jsonResponse(400, { error: 'Missing payload' });
    }

    const payload: SlackInteractionPayload = JSON.parse(payloadStr);

    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        if (action.action_id.startsWith('cancel_task:')) {
          await handleCancelAction(payload, action.action_id);
        }
      }
    }

    // Slack expects a 200 response within 3 seconds.
    return jsonResponse(200, {});
  } catch (err) {
    logger.error('Slack interaction handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(200, {}); // Still return 200 to avoid Slack retries.
  }
}

async function handleCancelAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const taskId = actionId.replace('cancel_task:', '');
  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Look up platform user.
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));

  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked.');
    return;
  }

  const platformUserId = mappingResult.Item.platform_user_id as string;

  // Load the task.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!taskResult.Item) {
    await postToResponseUrl(payload.response_url, `:mag: Task \`${taskId}\` not found.`);
    return;
  }

  if (taskResult.Item.user_id !== platformUserId) {
    await postToResponseUrl(payload.response_url, ':no_entry: You can only cancel your own tasks.');
    return;
  }

  // Attempt to cancel. QUEUED (#441) is cancellable — it removes the
  // task from the admission queue (no compute or concurrency to release).
  const CANCELLABLE_STATUSES = ['PENDING_UPLOADS', 'QUEUED', 'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'];
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :cancelled, updated_at = :now',
      ConditionExpression: '#s IN (:s1, :s2, :s3, :s4, :s5, :s6, :s7)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': new Date().toISOString(),
        ':s1': CANCELLABLE_STATUSES[0],
        ':s2': CANCELLABLE_STATUSES[1],
        ':s3': CANCELLABLE_STATUSES[2],
        ':s4': CANCELLABLE_STATUSES[3],
        ':s5': CANCELLABLE_STATUSES[4],
        ':s6': CANCELLABLE_STATUSES[5],
        ':s7': CANCELLABLE_STATUSES[6],
      },
    }));

    // Instant feedback: replace the Cancel button message with "Cancelling..."
    // then clean up all intermediate messages.
    const channelMeta = taskResult.Item.channel_metadata as Record<string, string> | undefined;
    const channelId = payload.channel?.id ?? channelMeta?.slack_channel_id;
    if (channelMeta && channelId) {
      const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
      if (botToken) {
        if (channelMeta.slack_session_msg_ts) {
          await updateSlackMessage(botToken, channelId, channelMeta.slack_session_msg_ts,
            ':hourglass_flowing_sand: Cancelling...', channelMeta.slack_thread_ts);
        }
        const toDelete = [channelMeta.slack_created_msg_ts].filter(Boolean);
        for (const ts of toDelete) {
          await deleteSlackMessage(botToken, channelId, ts!);
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'ConditionalCheckFailedException') {
      await postToResponseUrl(payload.response_url, ':warning: Task is already in a terminal state.');
    } else {
      throw err;
    }
  }
}

async function updateSlackMessage(botToken: string, channel: string, ts: string, text: string, threadTs?: string): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      channel,
      ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    };
    if (threadTs) payload.thread_ts = threadTs;
    const response = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to update Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error updating Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function deleteSlackMessage(botToken: string, channel: string, ts: string): Promise<void> {
  try {
    const response = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, ts }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to delete Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error deleting Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function postToResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text, replace_original: false }),
    });
  } catch (err) {
    logger.warn('Failed to post to interaction response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
