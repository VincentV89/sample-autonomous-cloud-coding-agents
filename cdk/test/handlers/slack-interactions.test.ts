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

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-I';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-interactions';

const SIGNING_SECRET = 'test-signing';

function sign(body: string, ts: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

function makeInteractionEvent(payload: object): APIGatewayProxyEvent {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'X-Slack-Signature': sign(body, ts),
      'X-Slack-Request-Timestamp': ts,
    },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/interactions',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function interactionPayload(actionId: string, userId = 'U1', teamId = 'T1'): object {
  return {
    type: 'block_actions',
    user: { id: userId, username: 'u', team_id: teamId },
    response_url: 'https://hooks.slack.com/response/xyz',
    trigger_id: 't.1',
    actions: [{ action_id: actionId, block_id: 'task-123' }],
    channel: { id: 'C1' },
  };
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-interactions handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: SIGNING_SECRET });
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });

  test('rejects invalid signature with 401', async () => {
    const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
    const ts = String(Math.floor(Date.now() / 1000));
    const event: APIGatewayProxyEvent = {
      body,
      headers: { 'X-Slack-Signature': 'v0=000', 'X-Slack-Request-Timestamp': ts },
      multiValueHeaders: {},
      httpMethod: 'POST',
      isBase64Encoded: false,
      path: '/v1/slack/interactions',
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as APIGatewayProxyEvent['requestContext'],
      resource: '',
    };
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('cancel_task transitions owned task to CANCELLED', async () => {
    // 1. user mapping lookup → platform user id
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'user-42' } });
    // 2. task lookup → same owner
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42', channel_metadata: {} } });
    // 3. update → success
    ddbSend.mockResolvedValueOnce({});

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42', 'U1', 'T1'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const updateCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.ExpressionAttributeValues[':cancelled']).toBe('CANCELLED');
  });

  test('cancel_task rejects when caller is not task owner', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'attacker' } });
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42' } });

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    // No update attempted
    const updateCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Update');
    expect(updateCall).toBeFalsy();
    // Posted to response_url with "own your own tasks"
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('your own tasks'),
    );
    expect(posted).toBeTruthy();
  });

  test('cancel_task on already-terminal task warns the user', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'user-42' } });
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42' } });
    // ConditionalCheckFailedException => already in terminal state
    const err = new Error('conditional failed');
    err.name = 'ConditionalCheckFailedException';
    ddbSend.mockRejectedValueOnce(err);

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('terminal state'),
    );
    expect(posted).toBeTruthy();
  });

  test('unknown action_id is ignored silently', async () => {
    const event = makeInteractionEvent(interactionPayload('other_action:xyz'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('unlinked account receives :link: message instead of cancel', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'pending' } });
    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(posted).toBeTruthy();
  });
});

describe('Connect terminal private interaction', () => {
  const id = '01M6K1S4S1QQ9KT6NXQ8B31RAG';
  const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/MyCodingAgent-0123456789';
  const session = '123e4567-e89b-12d3-a456-426614174000';
  const url = 'https://hooks.slack.com/actions/T1/private-capability';
  const task = (extra = {}) => ({ task_id: id, user_id: 'owner-1', status: 'RUNNING', compute_type: 'agentcore', agent_runtime_arn: arn, session_id: session, started_at: new Date(Date.now() - 60000).toISOString(), agent_heartbeat_at: new Date(Date.now() - 10000).toISOString(), repo: 'org/repo', branch_name: 'bgagent/existing', channel_source: 'slack', channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_user_id: 'U1', slack_thread_ts: '1000.0' }, ...extra });
  const payload = (extra = {}) => ({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1', team_id: 'T1', username: 'dev' }, channel: { id: 'C1' }, message: { thread_ts: '1000.0' }, response_url: url, trigger_id: 'trigger', actions: [{ action_id: `connect_terminal:${id}`, block_id: 'task-actions' }], ...extra });
  const posts = () => fetchMock.mock.calls.map(([target, options]) => ({ url: target, body: JSON.parse(options.body) }));
  beforeEach(() => {
    ddbSend.mockReset().mockImplementation(async command => command.input.TableName === 'SlackMap'
      ? { Item: { status: 'active', platform_user_id: 'owner-1' } } : { Item: task() });
    smSend.mockReset().mockResolvedValue({ SecretString: SIGNING_SECRET });
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
  });
  test('returns a private ready-to-paste command after consistent ownership and state reads', async () => {
    const context = { callbackWaitsForEmptyEventLoop: true };
    const result = await handler(makeInteractionEvent(payload()), context);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({});
    expect(context.callbackWaitsForEmptyEventLoop).toBe(false);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ url, body: { response_type: 'ephemeral', replace_original: false } });
    expect(posts()[0].body.text).toContain('agentcore runtime shell');
    expect(posts()[0].body.text).toContain(session);
    expect(posts()[0].body.text).not.toContain(SIGNING_SECRET);
    expect(ddbSend.mock.calls.every(([command]) => command._type === 'Get' && command.input.ConsistentRead)).toBe(true);
    expect(ddbSend.mock.calls.filter(([command]) => command.input.TableName === 'Tasks')).toHaveLength(2);
  });
  test.each(['pending', 'revoked', 'deleted', undefined])('inactive link %s never exposes a command', async status => {
    ddbSend.mockImplementation(async command => command.input.TableName === 'SlackMap' ? { Item: { status, platform_user_id: 'owner-1' } } : { Item: task() });
    await handler(makeInteractionEvent(payload()));
    expect(posts()[0].body.text).not.toContain('agentcore runtime shell');
    expect(posts()[0].body.response_type).toBe('ephemeral');
  });
  test.each([
    { user_id: 'other-owner' }, { channel_source: 'api' },
    { channel_metadata: { slack_team_id: 'T2', slack_channel_id: 'C1', slack_user_id: 'U1' } },
    { channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C2', slack_user_id: 'U1' } },
    { channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_user_id: 'U2' } },
    { channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_user_id: 'U1', slack_thread_ts: 'other' } },
    { status: 'COMPLETED' }, { status: 'FAILED' }, { status: 'CANCELLED' }, { status: 'TIMED_OUT' },
    { compute_type: 'ecs' }, { session_id: undefined }, { agent_runtime_arn: arn + '; rm' },
    { agent_heartbeat_at: 'bad' },
  ])('unauthorized or unavailable task %j yields only private guidance', async extra => {
    ddbSend.mockImplementation(async command => command.input.TableName === 'SlackMap' ? { Item: { status: 'active', platform_user_id: 'owner-1' } } : { Item: task(extra) });
    await handler(makeInteractionEvent(payload()));
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.response_type).toBe('ephemeral');
    expect(posts()[0].body.replace_original).toBe(false);
    expect(posts()[0].body.text).not.toContain('agentcore runtime shell');
    expect(posts()[0].body.text).not.toContain(session);
  });
  test.each([{ status: 'COMPLETED' }, { session_id: '987e4567-e89b-12d3-a456-426614174000' }, { agent_runtime_arn: arn.replace('MyCodingAgent', 'AnotherAgent') }])('click-time race %j cannot produce a stale/new-session command', async extra => {
    let reads = 0;
    ddbSend.mockImplementation(async command => command.input.TableName === 'SlackMap' ? { Item: { status: 'active', platform_user_id: 'owner-1' } } : { Item: task(++reads === 1 ? {} : extra) });
    await handler(makeInteractionEvent(payload()));
    expect(posts()[0].body.text).not.toContain('agentcore runtime shell');
  });
  test('missing tasks return private non-disclosing guidance', async () => {
    ddbSend.mockImplementation(async command => command.input.TableName === 'SlackMap' ? { Item: { status: 'active', platform_user_id: 'owner-1' } } : {});
    await handler(makeInteractionEvent(payload()));
    expect(posts()[0].body.text).toContain('Terminal unavailable');
  });
  test.each(['https://evil.example/actions/x', 'https://hooks.slack.com.evil.example/services/x', 'http://hooks.slack.com/services/x', 'https://user@hooks.slack.com/services/x', 'https://hooks.slack.com:123/services/x'])('never posts to untrusted response URL %s', async response_url => {
    await handler(makeInteractionEvent(payload({ response_url })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });
  test('forged task identifiers are rejected before task lookup', async () => {
    await handler(makeInteractionEvent(payload({ actions: [{ action_id: 'connect_terminal:bad; echo attack', block_id: 'x' }] })));
    expect(ddbSend).not.toHaveBeenCalled();
    expect(posts()[0].body.text).not.toContain('agentcore runtime shell');
  });
  test('invalid Slack signatures cause no data reads or private replies', async () => {
    const event = makeInteractionEvent(payload()); event.headers['X-Slack-Signature'] = 'v0=invalid';
    expect((await handler(event)).statusCode).toBe(401);
    expect(ddbSend).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  test('read failures do not expose raw backend errors or replace shared messages', async () => {
    ddbSend.mockRejectedValue(new Error('sensitive backend detail'));
    await handler(makeInteractionEvent(payload()));
    expect(posts()[0].body.text).toContain('Unable to prepare');
    expect(posts()[0].body.text).not.toContain('sensitive');
    expect(posts()[0].body.replace_original).toBe(false);
  });
  test('acknowledges a stalled preparation within the bounded deadline', async () => {
    jest.useFakeTimers();
    try {
      ddbSend.mockImplementation(() => new Promise(() => {}));
      const pending = handler(makeInteractionEvent(payload()));
      await jest.advanceTimersByTimeAsync(1801);
      const result = await pending;
      expect(result.statusCode).toBe(200);
      expect(posts()[0].body.text).toContain('Unable to prepare');
      expect(posts()[0].body.response_type).toBe('ephemeral');
    } finally { jest.useRealTimers(); }
  });
  test('handles null or mixed actions without exposing a command', async () => {
    await handler(makeInteractionEvent(payload({ actions: [null, { action_id: `connect_terminal:${id}` }] })));
    expect(ddbSend).not.toHaveBeenCalled();
    expect(posts()[0].body.text).not.toContain('agentcore runtime shell');
  });
  test('does not read tasks or reply when signature-secret loading exceeds the deadline', async () => {
    jest.useFakeTimers();
    try {
      let release: (value: unknown) => void = () => {};
      smSend.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const pending = handler(makeInteractionEvent(payload()));
      await jest.advanceTimersByTimeAsync(1801);
      expect((await pending).statusCode).toBe(200);
      release({ SecretString: SIGNING_SECRET });
      await jest.advanceTimersByTimeAsync(0);
      expect(ddbSend).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
  test('bounds private-response delivery and still acknowledges Slack', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }));
      const result = await handler(makeInteractionEvent(payload()));
      expect(result.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});
