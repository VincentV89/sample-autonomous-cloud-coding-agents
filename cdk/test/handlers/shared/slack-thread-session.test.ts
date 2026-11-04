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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseHistoryOption } from '../../../src/handlers/shared/slack-thread-history';
import { findSlackDevelopmentReplay, parseSlackSessionOption, resolveSlackThreadSession, slackDevelopmentTaskId, slackThreadBindingKey, slackThreadBindingPut, type SlackThreadIdentity } from '../../../src/handlers/shared/slack-thread-session';
import type { TaskRecord } from '../../../src/handlers/shared/types';

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: jest.fn(input => ({ kind: 'get', input })),
  QueryCommand: jest.fn(input => ({ kind: 'query', input })),
}));
const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
const session = '01M666YYHRAB6SE77VS1SFKMFK';
const otherSession = '01M66590HPQJAYYSH0V9WW19HS';
const identity: SlackThreadIdentity = { teamId: 'T1', channelId: 'C1', threadTs: '1000.0001', senderId: 'U1', ownerId: 'owner-1' };
const root = { task_id: session, user_id: 'owner-1', repo: 'org/repo', development_session_id: session, development_latest_task_id: session, status: 'COMPLETED' };
const binding = () => ({
  slack_identity: slackThreadBindingKey(identity),
  record_type: 'thread_session',
  owner_id: identity.ownerId,
  team_id: identity.teamId,
  channel_id: identity.channelId,
  thread_ts: identity.threadTs,
  sender_id: identity.senderId,
  repo: 'org/repo',
  session_id: session,
  revision: 'revision-1',
  message_ts: '1000.0001',
  ttl: Math.floor(Date.now()/1000) + 86400,
});
const defaultRepo = jest.fn();
const route = (extra = {}) => resolveSlackThreadSession(ddb, 'Tasks', 'SlackMap', { identity, messageTs: '1001.0001', fresh: false, defaultRepo, ...extra });
const legacy = (extra = {}) => ({ ...root, channel_source: 'slack', channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_thread_ts: '1000.0001', slack_user_id: 'U1' }, ...extra });
function backing(saved: Record<string, unknown> | undefined = undefined, roots: Record<string, unknown> = { [session]: root }, items: unknown[] = []) {
  send.mockImplementation(async ({ kind, input }) => {
    if (kind === 'query') return { Items: items };
    if (input.TableName === 'SlackMap') return { Item: saved };
    return { Item: roots[input.Key.task_id] };
  });
}
beforeEach(() => { send.mockReset(); defaultRepo.mockReset().mockResolvedValue(null); });

describe('session control and identity', () => {
  test.each([
    '--session=new --history=off develop Build a game',
    '--history=off develop --session=new Build a game',
    'org/repo --session=new --history=off develop Build a game',
  ])('new and history flags compose: %s', text => {
    const options = parseSlackSessionOption(text.split(' '));
    expect(options.fresh).toBe(true);
    const history = parseHistoryOption(options.args);
    expect(history.enabled).toBe(false);
    expect(history.args.join(' ')).not.toContain('--');
  });
  test.each(['--session=old', '--session=false', '--session'])('rejects %s as a control', flag => {
    expect(() => parseSlackSessionOption([flag, 'develop', 'Build'])).toThrow(/--session=new/);
  });
  test('flags inside prose remain prose', () => {
    expect(parseSlackSessionOption(['develop', 'Document', '--session=new'])).toEqual({ fresh: false, args: ['develop', 'Document', '--session=new'] });
  });
  test.each(['teamId', 'channelId', 'threadTs', 'senderId', 'ownerId'] as const)('binding is isolated by %s', field => {
    const value = field === 'threadTs' ? '1002.0001' : field === 'ownerId' ? 'owner-2' : identity[field] + '2';
    expect(slackThreadBindingKey({ ...identity, [field]: value })).not.toBe(slackThreadBindingKey(identity));
  });
  test('message retries keep one valid task ID, independent of object property insertion order', () => {
    const id = slackDevelopmentTaskId(identity, '1001.0001');
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(slackDevelopmentTaskId({ ownerId: 'owner-1', senderId: 'U1', channelId: 'C1', threadTs: '1000.0001', teamId: 'T1' }, '1001.0001')).toBe(id);
    expect(slackDevelopmentTaskId(identity, '1001.0002')).not.toBe(id);
    expect(slackDevelopmentTaskId({ ...identity, senderId: 'U2' }, '1001.0001')).not.toBe(id);
  });
});

describe('trusted thread routing', () => {
  test('reuses saved repo/session and captures the CAS revision with consistent reads only', async () => {
    backing(binding());
    expect(await route()).toEqual({ repo: 'org/repo', sessionId: session, reservation: { ...identity, expectedRevision: 'revision-1' } });
    expect(send.mock.calls.every(([command]) => command.kind === 'get' && command.input.ConsistentRead)).toBe(true);
    expect(defaultRepo).not.toHaveBeenCalled();
  });
  test('an older unadmitted command cannot replace a newer thread default, even with explicit overrides', async () => {
    backing({ ...binding(), message_ts: '1002.000001' });
    await expect(route({ messageTs: '1001.999999', fresh: true, repo: 'other/repo' })).rejects.toThrow(/newer command/);
    await expect(route({ messageTs: '1002.000001', sessionId: session })).rejects.toThrow(/newer command/);
    expect(defaultRepo).not.toHaveBeenCalled();
  });
  test('fresh reuses the repo but does not continue the session or read its root', async () => {
    backing(binding());
    expect(await route({ fresh: true })).toMatchObject({ repo: 'org/repo', sessionId: undefined });
    expect(send).toHaveBeenCalledTimes(1);
  });
  test('explicit different repo starts fresh; matching repo preserves the saved case and session', async () => {
    backing(binding());
    expect(await route({ repo: 'other/repo' })).toMatchObject({ repo: 'other/repo', sessionId: undefined });
    expect(await route({ repo: 'ORG/REPO' })).toMatchObject({ repo: 'org/repo', sessionId: session });
  });
  test('explicit session overrides a default and resolves its repository from an owned root', async () => {
    backing(binding(), { [otherSession]: { ...root, repo: 'other/repo', development_session_id: otherSession } });
    expect(await route({ sessionId: otherSession })).toMatchObject({ repo: 'other/repo', sessionId: otherSession });
  });
  test('rejects session=new with an explicit ID', async () => {
    backing(binding());
    await expect(route({ fresh: true, sessionId: session })).rejects.toThrow(/either/);
  });
  test.each([
    { user_id: 'another-owner' }, { repo: 'wrong/repo' }, { development_session_id: otherSession }, { development_latest_task_id: undefined },
  ])('cannot route an inaccessible/mismatched session %j', async extra => {
    backing(binding(), { [session]: { ...root, ...extra } });
    await expect(route()).rejects.toThrow(/not found/);
  });
  test('missing/deleted root fails explicitly, but an explicit fresh request can recover', async () => {
    backing(binding(), {});
    await expect(route()).rejects.toThrow(/--session=new/);
    expect(await route({ fresh: true })).toMatchObject({ repo: 'org/repo', sessionId: undefined });
  });
  test('expired binding requires explicit recovery, with its CAS revision retained', async () => {
    backing({ ...binding(), ttl: 1 });
    await expect(route()).rejects.toThrow(/expired/);
    expect(await route({ fresh: true })).toMatchObject({ reservation: { expectedRevision: 'revision-1' } });
  });
  test.each([{ owner_id: 'other' }, { sender_id: 'UOTHER' }, { team_id: 'TOTHER' }, { channel_id: 'COTHER' }, { record_type: 'wrong' }, { session_id: 'bad' }, { message_ts: 'bad' }])('rejects corrupt or cross-identity binding %j', async extra => {
    backing({ ...binding(), ...extra });
    await expect(route({ fresh: true })).rejects.toThrow(/binding is invalid/);
  });
  test('storage failures never silently start a new session or use a channel fallback', async () => {
    send.mockRejectedValue(new Error('sensitive backend details'));
    await expect(route()).rejects.toThrow(/^Unable to load the saved thread session/);
    expect(defaultRepo).not.toHaveBeenCalled();
  });
  test('new top-level request skips legacy discovery and uses the channel default when needed', async () => {
    backing(); defaultRepo.mockResolvedValue('org/default');
    expect(await route({ messageTs: identity.threadTs })).toMatchObject({ repo: 'org/default', sessionId: undefined });
    expect(send.mock.calls.some(([command]) => command.kind === 'query')).toBe(false);
  });
  test('new thread without repo/default returns first-request guidance', async () => {
    backing();
    await expect(route({ messageTs: identity.threadTs })).rejects.toThrow(/Include owner\/repo/);
  });
  test('fresh with an explicit repo can bypass legacy discovery and its ambiguities', async () => {
    backing(undefined, {}, [legacy(), legacy({ development_session_id: otherSession })]);
    expect(await route({ fresh: true, repo: 'org/repo' })).toMatchObject({ repo: 'org/repo', sessionId: undefined });
    expect(send.mock.calls.some(([command]) => command.kind === 'query')).toBe(false);
  });
});

describe('legacy association', () => {
  test('uses only persisted metadata of this user, sender, workspace, channel and root', async () => {
    backing(undefined, { [session]: root }, [legacy(),
      legacy({ user_id: 'other-owner' }),
      legacy({ channel_metadata: { ...legacy().channel_metadata, slack_team_id: 'T2' } }),
      legacy({ channel_metadata: { ...legacy().channel_metadata, slack_channel_id: 'C2' } }),
      legacy({ channel_metadata: { ...legacy().channel_metadata, slack_user_id: 'U2' } }),
      legacy({ channel_metadata: { ...legacy().channel_metadata, slack_thread_ts: '1002.0' } })]);
    expect(await route()).toMatchObject({ repo: 'org/repo', sessionId: session });
    const query = send.mock.calls.find(([command]) => command.kind === 'query')![0].input;
    expect(query).toMatchObject({ IndexName: 'UserStatusIndex', KeyConditionExpression: 'user_id = :owner', ExpressionAttributeValues: { ':owner': 'owner-1' }, Limit: 100 });
    expect(send.mock.calls.some(([command]) => !['get', 'query'].includes(command.kind))).toBe(false);
  });
  test('multiple sessions in a legacy thread require an explicit choice', async () => {
    backing(undefined, {}, [legacy(), legacy({ development_session_id: otherSession })]);
    await expect(route()).rejects.toThrow(/multiple development sessions/);
  });
  test('a bounded search must finish all its pages before choosing', async () => {
    backing();
    let pages = 0;
    send.mockImplementation(async ({ kind }) => kind === 'query'
      ? { Items: [legacy()], LastEvaluatedKey: { task_id: `page-${++pages}` } } : {});
    await expect(route()).rejects.toThrow(/search limit/);
    expect(pages).toBe(3);
  });
  test('failed search cannot masquerade as an empty thread', async () => {
    send.mockImplementation(async ({ kind }) => { if (kind === 'query') throw new Error('backend failure'); return {}; });
    await expect(route()).rejects.toThrow(/Unable to load/);
    expect(defaultRepo).not.toHaveBeenCalled();
  });
});

describe('binding admission and replay', () => {
  const task = { ...root, channel_source: 'slack', channel_metadata: { ...legacy().channel_metadata, slack_message_ts: '1001.0001' } } as unknown as TaskRecord;
  test('binding is a typed, expiring namespaced record excluded from account indexes', () => {
    const put = slackThreadBindingPut(identity, 'SlackMap', task, 12345);
    expect(put.ConditionExpression).toBe('attribute_not_exists(slack_identity)');
    expect(put.Item).toMatchObject({ record_type: 'thread_session', owner_id: 'owner-1', session_id: session, revision: session, ttl: 12345 });
    expect(put.Item?.slack_identity).toMatch(/^thread-session#/);
    expect(put.Item?.platform_user_id).toBeUndefined();
    expect(put.Item?.linked_at).toBeUndefined();
  });
  test('updating a binding requires its prior revision and same owner/sender', () => {
    const put = slackThreadBindingPut({ ...identity, expectedRevision: 'older-task' }, 'SlackMap', task, 12345);
    expect(put.ConditionExpression).toContain('#revision = :revision');
    expect(put.ExpressionAttributeValues).toEqual({ ':revision': 'older-task', ':owner': 'owner-1', ':sender': 'U1' });
  });
  test('an internal reservation cannot write another user or thread binding', () => {
    expect(() => slackThreadBindingPut({ ...identity, ownerId: 'other' }, 'SlackMap', task, 12345)).toThrow(/Invalid internal/);
    expect(() => slackThreadBindingPut({ ...identity, channelId: 'C2' }, 'SlackMap', task, 12345)).toThrow(/Invalid internal/);
  });
  test('replay reads are owner/message scoped and do not update a default', async () => {
    send.mockResolvedValue({ Item: task });
    expect(await findSlackDevelopmentReplay(ddb, 'Tasks', identity, session, '1001.0001')).toEqual(task);
    await expect(findSlackDevelopmentReplay(ddb, 'Tasks', { ...identity, senderId: 'U2' }, session, '1001.0001')).rejects.toThrow(/cannot be replayed/);
    await expect(findSlackDevelopmentReplay(ddb, 'Tasks', identity, session, '1001.0002')).rejects.toThrow(/cannot be replayed/);
    expect(send.mock.calls.every(([command]) => command.kind === 'get')).toBe(true);
  });
});
