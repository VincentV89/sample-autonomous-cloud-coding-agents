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

import { createHash } from 'crypto';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { TaskRecord } from './types';
import { isValidRepo } from './validation';

const SLACK_TIMESTAMP = /^\d{1,16}\.\d{1,6}$/;
const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_DISCOVERY_PAGES = 3;
const DISCOVERY_PAGE_SIZE = 100;
const PRNG_RANGE = 256;
const MILLISECONDS_PER_SECOND = 1000;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const TIMESTAMP_FRACTION_DIGITS = 6;
const GUIDANCE = 'Provide an explicit SESSION_ID, or use --session=new with a repository to start fresh.';
export class SlackThreadSessionError extends Error {}

export interface SlackThreadIdentity {
  teamId: string;
  channelId: string;
  threadTs: string;
  senderId: string;
  ownerId: string;
}
export interface SlackThreadReservation extends SlackThreadIdentity {
  expectedRevision?: string;
}
interface Binding {
  slack_identity: string;
  record_type: 'thread_session';
  owner_id: string;
  sender_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  repo: string;
  session_id: string;
  revision: string;
  message_ts: string;
  ttl: number;
}
interface RouteInput {
  identity: SlackThreadIdentity;
  messageTs: string;
  repo?: string;
  sessionId?: string;
  fresh: boolean;
  defaultRepo: () => Promise<string | null>;
}

function timestamp(value: unknown): bigint {
  if (typeof value !== 'string' || !SLACK_TIMESTAMP.test(value)) {
    throw new SlackThreadSessionError('Invalid Slack message timestamp. Send the command again.');
  }
  const [seconds, fraction] = value.split('.');
  return BigInt(seconds) * MICROSECONDS_PER_SECOND + BigInt(fraction.padEnd(TIMESTAMP_FRACTION_DIGITS, '0'));
}

function validIdentity(identity: SlackThreadIdentity): boolean {
  return /^[A-Z][A-Z0-9]{1,30}$/.test(identity.teamId)
    && /^[CDG][A-Z0-9]{1,30}$/.test(identity.channelId)
    && /^[UW][A-Z0-9]{1,30}$/.test(identity.senderId)
    && SLACK_TIMESTAMP.test(identity.threadTs)
    && typeof identity.ownerId === 'string' && identity.ownerId.length > 0 && identity.ownerId.length <= 200;
}
export function slackThreadBindingKey(identity: SlackThreadIdentity): string {
  if (!validIdentity(identity)) throw new SlackThreadSessionError(`Invalid Slack thread identity. ${GUIDANCE}`);
  return `thread-session#${createHash('sha256').update(JSON.stringify([
    identity.teamId, identity.channelId, identity.threadTs, identity.ownerId, identity.senderId,
  ])).digest('hex')}`;
}

/** Slack message retries keep one task ID; full timestamp and identities seed its random part. */
export function slackDevelopmentTaskId(identity: SlackThreadIdentity, messageTs: string): string {
  slackThreadBindingKey(identity);
  if (!SLACK_TIMESTAMP.test(messageTs)) throw new SlackThreadSessionError('Missing or invalid Slack message timestamp. Retry the command.');
  const entropy = createHash('sha256').update(JSON.stringify([identity.teamId, identity.channelId, identity.threadTs, identity.ownerId, identity.senderId, messageTs])).digest();
  let index = 0;
  return ulid(Math.floor(Number(messageTs) * MILLISECONDS_PER_SECOND), () => entropy[index++ % entropy.length] / PRNG_RANGE);
}

/** Only control-position flags are consumed; the history parser runs independently afterwards. */
export function parseSlackSessionOption(args: readonly string[]): { args: string[]; fresh: boolean } {
  const clean: string[] = [];
  let fresh = false;
  let control = true;
  for (const arg of args) {
    if (control && arg.startsWith('--session')) {
      if (arg !== '--session=new') throw new SlackThreadSessionError('Use --session=new before the task description to start fresh.');
      fresh = true;
    } else {
      clean.push(arg);
      if (control && arg.startsWith('--history')) continue;
      if (!/^[\w.-]+\/[\w.-]+(?:#\d+)?$/.test(arg) && !SESSION_ID.test(arg.toUpperCase())
        && !['develop', 'promote'].includes(arg.toLowerCase())) control = false;
    }
  }
  return { args: clean, fresh };
}

async function ownedRoot(ddb: DynamoDBDocumentClient, table: string, owner: string, session: string, repo?: string): Promise<TaskRecord> {
  if (!SESSION_ID.test(session)) throw new SlackThreadSessionError(`Invalid development session. ${GUIDANCE}`);
  const result = await ddb.send(new GetCommand({ TableName: table, Key: { task_id: session }, ConsistentRead: true }));
  const root = result.Item as (TaskRecord & { development_latest_task_id?: string }) | undefined;
  if (!root || root.user_id !== owner || root.development_session_id !== session || !root.development_latest_task_id
    || !root.repo || !isValidRepo(root.repo) || (repo && root.repo.toLowerCase() !== repo.toLowerCase())) {
    throw new SlackThreadSessionError(`Development session not found for this user and repository. ${GUIDANCE}`);
  }
  return root;
}

async function discoverLegacy(ddb: DynamoDBDocumentClient, table: string, input: RouteInput): Promise<{ repo: string; session: string } | undefined> {
  let cursor: Record<string, unknown> | undefined;
  const candidates = new Map<string, string>();
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const result = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :owner',
      ExpressionAttributeValues: { ':owner': input.identity.ownerId },
      ProjectionExpression: 'task_id, user_id, repo, development_session_id, channel_source, channel_metadata',
      Limit: DISCOVERY_PAGE_SIZE,
      ExclusiveStartKey: cursor,
    }));
    for (const item of result.Items ?? []) {
      const metadata = item.channel_metadata ?? {};
      if (item.user_id !== input.identity.ownerId || item.channel_source !== 'slack'
        || metadata.slack_team_id !== input.identity.teamId || metadata.slack_channel_id !== input.identity.channelId
        || metadata.slack_thread_ts !== input.identity.threadTs || metadata.slack_user_id !== input.identity.senderId) continue;
      if (typeof item.development_session_id !== 'string' || !SESSION_ID.test(item.development_session_id)
        || typeof item.repo !== 'string' || !isValidRepo(item.repo)) throw new SlackThreadSessionError(`Saved thread task metadata is invalid. ${GUIDANCE}`);
      if (input.repo && item.repo.toLowerCase() !== input.repo.toLowerCase()) continue;
      candidates.set(item.development_session_id, item.repo);
    }
    if (!result.LastEvaluatedKey) {
      if (candidates.size > 1) throw new SlackThreadSessionError(`This thread has multiple development sessions. ${GUIDANCE}`);
      const entry = [...candidates.entries()][0];
      return entry ? { session: entry[0], repo: entry[1] } : undefined;
    }
    cursor = result.LastEvaluatedKey;
  }
  throw new SlackThreadSessionError(`Thread session discovery reached its search limit. ${GUIDANCE}`);
}

/** All routing is from platform records. This module never reads Slack message history. */
export async function resolveSlackThreadSession(
  ddb: DynamoDBDocumentClient, taskTable: string, mappingTable: string, input: RouteInput,
): Promise<{ repo: string; sessionId?: string; reservation: SlackThreadReservation }> {
  try {
    const key = slackThreadBindingKey(input.identity);
    const messageTime = timestamp(input.messageTs);
    if (messageTime < timestamp(input.identity.threadTs)) throw new SlackThreadSessionError('The message precedes its thread root. Send the command again.');
    if (!taskTable || !mappingTable) throw new SlackThreadSessionError('Thread session storage is not configured. Ask the platform administrator.');
    if (input.fresh && input.sessionId) throw new SlackThreadSessionError('Use either --session=new or an explicit SESSION_ID, not both.');
    const existing = await ddb.send(new GetCommand({ TableName: mappingTable, Key: { slack_identity: key }, ConsistentRead: true }));
    const binding = existing.Item as Binding | undefined;
    if (binding && (binding.record_type !== 'thread_session' || binding.owner_id !== input.identity.ownerId
      || binding.sender_id !== input.identity.senderId || binding.team_id !== input.identity.teamId
      || binding.channel_id !== input.identity.channelId || binding.thread_ts !== input.identity.threadTs
      || typeof binding.repo !== 'string' || !isValidRepo(binding.repo) || !SESSION_ID.test(binding.session_id)
      || typeof binding.revision !== 'string' || !binding.revision || !Number.isFinite(binding.ttl)
      || typeof binding.message_ts !== 'string' || !SLACK_TIMESTAMP.test(binding.message_ts))) {
      throw new SlackThreadSessionError('The saved thread binding is invalid. Ask the platform administrator to inspect it, or start a new Slack thread.');
    }
    if (binding && messageTime <= timestamp(binding.message_ts)) {
      throw new SlackThreadSessionError('A newer command has already advanced this thread session. Send your request as a new Slack message.');
    }
    if (binding && binding.ttl <= Math.floor(Date.now() / MILLISECONDS_PER_SECOND) && !input.fresh && !input.sessionId) {
      throw new SlackThreadSessionError(`The saved thread session binding has expired. ${GUIDANCE}`);
    }
    let repo = input.repo;
    let sessionId = input.sessionId;
    if (sessionId) {
      repo = (await ownedRoot(ddb, taskTable, input.identity.ownerId, sessionId, repo)).repo!;
    } else if (binding) {
      if (!repo || repo.toLowerCase() === binding.repo.toLowerCase()) {
        repo = binding.repo;
        if (!input.fresh) sessionId = binding.session_id;
      }
    } else if (input.messageTs !== input.identity.threadTs && !(input.fresh && repo)) {
      const legacy = await discoverLegacy(ddb, taskTable, input);
      if (legacy) {
        repo = legacy.repo;
        if (!input.fresh) sessionId = legacy.session;
      }
    }
    if (sessionId && !input.sessionId) repo = (await ownedRoot(ddb, taskTable, input.identity.ownerId, sessionId, repo)).repo!;
    repo ??= await input.defaultRepo() ?? undefined;
    if (!repo || !isValidRepo(repo)) throw new SlackThreadSessionError('Include owner/repo for the first development request, or configure a channel default repository.');
    return { repo, sessionId, reservation: { ...input.identity, ...(binding && { expectedRevision: binding.revision }) } };
  } catch (error) {
    if (error instanceof SlackThreadSessionError) throw error;
    throw new SlackThreadSessionError(`Unable to load the saved thread session. Retry later. ${GUIDANCE}`);
  }
}

/** Consistent read before routing prevents a retried older event from changing a newer default. */
export async function findSlackDevelopmentReplay(
  ddb: DynamoDBDocumentClient, table: string, identity: SlackThreadIdentity, taskId: string, messageTs: string,
): Promise<TaskRecord | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: { task_id: taskId }, ConsistentRead: true }));
  const task = result.Item as TaskRecord | undefined;
  if (!task) return undefined;
  const metadata = task.channel_metadata ?? {};
  if (!task.development_session_id || !SESSION_ID.test(task.development_session_id)
    || task.user_id !== identity.ownerId || task.channel_source !== 'slack'
    || metadata.slack_team_id !== identity.teamId || metadata.slack_channel_id !== identity.channelId
    || metadata.slack_thread_ts !== identity.threadTs || metadata.slack_user_id !== identity.senderId
    || metadata.slack_message_ts !== messageTs) throw new SlackThreadSessionError('This Slack submission cannot be replayed for the current identity.');
  return task;
}

/** The task, session pointer and thread binding commit atomically or none of them do. */
export function slackThreadBindingPut(
  reservation: SlackThreadReservation, table: string, task: TaskRecord, ttl: number,
): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Put']> {
  const metadata = task.channel_metadata ?? {};
  if (!table || task.channel_source !== 'slack' || task.user_id !== reservation.ownerId
    || metadata.slack_team_id !== reservation.teamId || metadata.slack_channel_id !== reservation.channelId
    || metadata.slack_thread_ts !== reservation.threadTs || metadata.slack_user_id !== reservation.senderId
    || !task.development_session_id || !task.repo) throw new SlackThreadSessionError('Invalid internal Slack thread reservation.');
  if (timestamp(metadata.slack_message_ts) < timestamp(reservation.threadTs)) {
    throw new SlackThreadSessionError('Invalid internal Slack message timestamp.');
  }
  const item: Binding = {
    slack_identity: slackThreadBindingKey(reservation),
    record_type: 'thread_session',
    owner_id: reservation.ownerId,
    sender_id: reservation.senderId,
    team_id: reservation.teamId,
    channel_id: reservation.channelId,
    thread_ts: reservation.threadTs,
    repo: task.repo,
    session_id: task.development_session_id,
    revision: task.task_id,
    message_ts: metadata.slack_message_ts,
    ttl,
  };
  return {
    TableName: table,
    Item: item,
    ConditionExpression: reservation.expectedRevision === undefined ? 'attribute_not_exists(slack_identity)'
      : '#revision = :revision AND #owner = :owner AND #sender = :sender',
    ...(reservation.expectedRevision !== undefined && {
      ExpressionAttributeNames: { '#revision': 'revision', '#owner': 'owner_id', '#sender': 'sender_id' },
      ExpressionAttributeValues: {
        ':revision': reservation.expectedRevision, ':owner': reservation.ownerId, ':sender': reservation.senderId,
      },
    }),
  };
}
