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
const GUIDANCE = 'Provide an explicit development SESSION_ID, or use --session=new with a repository to start fresh.';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
export type SlackThreadMode = 'develop' | 'pr';
type TransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>;
type ThreadTask = TaskRecord & { slack_pr_latest_task_id?: string };

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
  mode?: SlackThreadMode;
  prRootTaskId?: string;
  prNumber?: number;
  prExpectedBranch?: string;
  advance?: TransactionItems;
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
  session_id?: string;
  mode?: SlackThreadMode;
  pr_root_task_id?: string;
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
  action?: 'develop' | 'promote';
  nextTaskId?: string;
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

interface ThreadContext { repo: string; mode: SlackThreadMode; session?: string; prRootTaskId?: string }
function sameThread(task: TaskRecord, identity: SlackThreadIdentity): boolean {
  const m = task.channel_metadata ?? {};
  return task.user_id === identity.ownerId && task.channel_source === 'slack'
    && m.slack_team_id === identity.teamId && m.slack_channel_id === identity.channelId
    && m.slack_thread_ts === identity.threadTs && m.slack_user_id === identity.senderId;
}
function prNumber(task: TaskRecord): number | undefined {
  const explicit = Number.isSafeInteger(task.pr_number) && task.pr_number! > 0 ? task.pr_number : undefined;
  if (!task.pr_url) return explicit;
  const match = task.pr_url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/);
  if (!match || match[1].toLowerCase() !== task.repo?.toLowerCase() || !Number.isSafeInteger(Number(match[2]))) return undefined;
  const number = Number(match[2]);
  return explicit !== undefined && explicit !== number ? undefined : number;
}
async function discoverLegacy(ddb: DynamoDBDocumentClient, table: string, input: RouteInput): Promise<ThreadContext | undefined> {
  let cursor: Record<string, unknown> | undefined;
  const candidates = new Map<string, ThreadContext>();
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const result = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'UserStatusIndex',
      KeyConditionExpression: 'user_id = :owner',
      ExpressionAttributeValues: { ':owner': input.identity.ownerId },
      ProjectionExpression: 'task_id, user_id, repo, development_session_id, development_action, channel_source, channel_metadata, pr_number, pr_url',
      Limit: DISCOVERY_PAGE_SIZE,
      ExclusiveStartKey: cursor,
    }));
    for (const item of (result.Items ?? []) as TaskRecord[]) {
      if (!sameThread(item, input.identity)) continue;
      // Ordinary PR tasks legitimately have no development session. They are not corrupt.
      const developing = item.development_session_id !== undefined && item.development_action !== 'promote';
      if (input.action && !developing) continue;
      if (!item.repo || !isValidRepo(item.repo) || (developing && !SESSION_ID.test(item.development_session_id!))) {
        throw new SlackThreadSessionError(`Saved thread task metadata is invalid. ${GUIDANCE}`);
      }
      if (input.repo && item.repo.toLowerCase() !== input.repo.toLowerCase()) continue;
      const session = item.development_session_id;
      const number = prNumber(item);
      const prRootTaskId = item.channel_metadata?.slack_pr_root_task_id ?? item.task_id;
      const key = developing ? `develop:${session}` : `pr:${item.repo.toLowerCase()}:${number ?? prRootTaskId}`;
      candidates.set(key, developing ? { repo: item.repo, mode: 'develop', session } : { repo: item.repo, mode: 'pr', prRootTaskId });
    }
    if (!result.LastEvaluatedKey) {
      if (candidates.size > 1) throw new SlackThreadSessionError(`This thread has multiple development sessions or PR contexts. ${GUIDANCE}`);
      return [...candidates.values()][0];
    }
    cursor = result.LastEvaluatedKey;
  }
  throw new SlackThreadSessionError(`Thread session discovery reached its search limit. ${GUIDANCE}`);
}

async function preparePrIteration(
  ddb: DynamoDBDocumentClient, table: string, input: RouteInput, context: ThreadContext,
): Promise<{ prNumber: number; branch: string; advance: TransactionItems }> {
  const rootResult = await ddb.send(new GetCommand({ TableName: table, Key: { task_id: context.prRootTaskId }, ConsistentRead: true }));
  const root = rootResult.Item as ThreadTask | undefined;
  if (!root || !sameThread(root, input.identity) || root.repo?.toLowerCase() !== context.repo.toLowerCase()) {
    throw new SlackThreadSessionError(`Saved PR task not found for this user and thread. ${GUIDANCE}`);
  }
  const latestId = root.slack_pr_latest_task_id ?? root.task_id;
  const latest = latestId === root.task_id ? root : (await ddb.send(new GetCommand({
    TableName: table, Key: { task_id: latestId }, ConsistentRead: true,
  }))).Item as ThreadTask | undefined;
  if (!latest || !sameThread(latest, input.identity) || latest.repo?.toLowerCase() !== context.repo.toLowerCase() || !TERMINAL.has(latest.status)) {
    throw new SlackThreadSessionError('A PR task is still active or unavailable. Wait for it to finish, or use --session=new for separate work.');
  }
  // A failed iteration can lack hydrated PR fields; its verified lineage root
  // still identifies the existing PR. A failed first task without any PR cannot.
  const target = latest.pr_url ? latest : root;
  const number = prNumber(target);
  if (!number || !target.pr_url || !target.branch_name || target.branch_name.startsWith('pending:')
    || latest.pr_number !== undefined && latest.pr_number !== number) {
    throw new SlackThreadSessionError(`The previous task has no verified PR to continue. ${GUIDANCE}`);
  }
  if (!input.nextTaskId) throw new SlackThreadSessionError('PR continuation admission is not configured. Ask the platform administrator.');
  return {
    prNumber: number,
    branch: target.branch_name,
    advance: [{
      Update: {
        TableName: table,
        Key: { task_id: root.task_id },
        UpdateExpression: 'SET slack_pr_latest_task_id = :next',
        ConditionExpression: 'user_id = :owner AND repo = :repo AND ' + (root.slack_pr_latest_task_id ? 'slack_pr_latest_task_id = :previous' : 'attribute_not_exists(slack_pr_latest_task_id)'),
        ExpressionAttributeValues: { ':next': input.nextTaskId, ':owner': input.identity.ownerId, ':repo': root.repo, ...(root.slack_pr_latest_task_id && { ':previous': latestId }) },
      },
    }],
  };
}

export interface SlackThreadRoute {
  repo: string;
  mode: SlackThreadMode;
  sessionId?: string;
  prNumber?: number;
  reservation: SlackThreadReservation;
}
/** All routing is from platform records. This module never reads Slack message history. */
export async function resolveSlackThreadWorkflow(
  ddb: DynamoDBDocumentClient, taskTable: string, mappingTable: string, input: RouteInput,
): Promise<SlackThreadRoute> {
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
      || typeof binding.repo !== 'string' || !isValidRepo(binding.repo)
      || (binding.mode !== undefined && !['develop', 'pr'].includes(binding.mode))
      || (binding.mode === 'pr' ? !SESSION_ID.test(binding.pr_root_task_id ?? '') : !SESSION_ID.test(binding.session_id ?? ''))
      || typeof binding.revision !== 'string' || !binding.revision || !Number.isFinite(binding.ttl)
      || typeof binding.message_ts !== 'string' || !SLACK_TIMESTAMP.test(binding.message_ts))) {
      throw new SlackThreadSessionError('The saved thread binding is invalid. Ask the platform administrator to inspect it, or start a new Slack thread.');
    }
    if (binding && messageTime <= timestamp(binding.message_ts)) throw new SlackThreadSessionError('A newer command has already advanced this thread session. Send your request as a new Slack message.');
    if (binding && binding.ttl <= Math.floor(Date.now() / MILLISECONDS_PER_SECOND) && !input.fresh && !input.sessionId) throw new SlackThreadSessionError(`The saved thread session binding has expired. ${GUIDANCE}`);
    let repo = input.repo;
    let sessionId = input.sessionId;
    let context: ThreadContext | undefined = binding ? { repo: binding.repo, mode: binding.mode ?? 'develop', session: binding.session_id, prRootTaskId: binding.pr_root_task_id } : undefined;
    if (!binding && !sessionId && input.messageTs !== input.identity.threadTs && !(input.fresh && repo)) {
      context = await discoverLegacy(ddb, taskTable, input);
    }
    const mode: SlackThreadMode = input.action || sessionId ? 'develop' : context?.mode ?? 'pr';
    const matchesRepo = !repo || repo.toLowerCase() === context?.repo.toLowerCase();
    if (sessionId) {repo = (await ownedRoot(ddb, taskTable, input.identity.ownerId, sessionId, repo)).repo!;} else if (context && matchesRepo) {
      repo = context.repo;
      if (!input.fresh && mode === 'develop' && context.mode === 'develop') sessionId = context.session;
    }
    if (sessionId && !input.sessionId) repo = (await ownedRoot(ddb, taskTable, input.identity.ownerId, sessionId, repo)).repo!;
    repo ??= await input.defaultRepo() ?? undefined;
    if (!repo || !isValidRepo(repo)) throw new SlackThreadSessionError('Include owner/repo for the first request, or configure a channel default repository.');
    const reservation: SlackThreadReservation = { ...input.identity, ...(binding && { expectedRevision: binding.revision }), mode };
    let number: number | undefined;
    if (context?.mode === 'pr' && mode === 'pr' && matchesRepo && !input.fresh) {
      const iteration = await preparePrIteration(ddb, taskTable, input, context);
      number = iteration.prNumber;
      reservation.prRootTaskId = context.prRootTaskId;
      reservation.prNumber = number;
      reservation.prExpectedBranch = iteration.branch;
      reservation.advance = iteration.advance;
    }
    return { repo, mode, sessionId, prNumber: number, reservation };
  } catch (error) {
    if (error instanceof SlackThreadSessionError) throw error;
    throw new SlackThreadSessionError(`Unable to load the saved thread session. Retry later. ${GUIDANCE}`);
  }
}

/** Compatibility seam for explicit development callers; workflow-aware routing is used by Slack. */
export async function resolveSlackThreadSession(
  ddb: DynamoDBDocumentClient, taskTable: string, mappingTable: string, input: RouteInput,
): Promise<{ repo: string; sessionId?: string; reservation: SlackThreadReservation }> {
  const route = await resolveSlackThreadWorkflow(ddb, taskTable, mappingTable, { ...input, action: input.action ?? 'develop' });
  const { mode: _mode, ...reservation } = route.reservation;
  return { repo: route.repo, sessionId: route.sessionId, reservation };
}

/** Consistent read before routing prevents a retried older event from changing a newer default. */
export async function findSlackDevelopmentReplay(
  ddb: DynamoDBDocumentClient, table: string, identity: SlackThreadIdentity, taskId: string, messageTs: string,
): Promise<TaskRecord | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: { task_id: taskId }, ConsistentRead: true }));
  const task = result.Item as TaskRecord | undefined;
  if (!task) return undefined;
  const metadata = task.channel_metadata ?? {};
  if (task.user_id !== identity.ownerId || task.channel_source !== 'slack'
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
    || !task.repo) throw new SlackThreadSessionError('Invalid internal Slack thread reservation.');
  if (timestamp(metadata.slack_message_ts) < timestamp(reservation.threadTs)) {
    throw new SlackThreadSessionError('Invalid internal Slack message timestamp.');
  }
  const mode = task.development_action === 'promote' ? 'pr' : reservation.mode ?? (task.development_session_id ? 'develop' : 'pr');
  if (mode === 'develop' && !SESSION_ID.test(task.development_session_id ?? '')
    || reservation.prRootTaskId && (task.pr_number !== reservation.prNumber || task.resolved_workflow?.id !== 'coding/pr-iteration-v1')) {
    throw new SlackThreadSessionError('Invalid internal Slack workflow reservation.');
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
    mode,
    ...(task.development_session_id && task.development_action !== 'promote' ? { session_id: task.development_session_id } : { pr_root_task_id: reservation.prRootTaskId ?? task.task_id }),
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
