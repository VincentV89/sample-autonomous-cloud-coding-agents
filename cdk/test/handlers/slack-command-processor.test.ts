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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';

import { slackThreadBindingPut } from '../../src/handlers/shared/slack-thread-session';
import type { TaskRecord } from '../../src/handlers/shared/types';

import { handler, type MentionEvent, type SlashCommandEvent } from '../../src/handlers/slack-command-processor';

function mention(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    source: 'mention',
    text: 'submit org/repo fix the bug',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    mention_thread_ts: '1000.0001',
    mention_message_ts: '1000.0001',
    ...overrides,
  };
}

function slashCommand(overrides: Partial<SlashCommandEvent> = {}): SlashCommandEvent {
  return {
    source: 'slash',
    text: 'help',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    command: '/bgagent',
    user_name: 'u',
    team_domain: 'acme',
    channel_name: 'general',
    trigger_id: 'T.1',
    response_url: 'https://hooks.slack.com/cmd/X',
    ...overrides,
  };
}

function ordinaryDb(command: { _type: string; input: { TableName: string; Key?: Record<string, string> } }, repo?: string): Promise<Record<string, unknown>> {
  if (command.input.TableName === 'Tasks' || command._type === 'Query' || command.input.Key?.slack_identity?.startsWith('thread-session#')) return Promise.resolve({});
  if (command.input.TableName === 'SlackChannelMap') return Promise.resolve({ Item: { status: 'active', ...(repo && { repo }) } });
  return Promise.resolve({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-command-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset().mockImplementation(ordinaryDb);
    smSend.mockReset();
    fetchMock.mockReset();
    createTaskCoreMock.mockReset();
    smSend.mockResolvedValue({ SecretString: 'xoxb-bot' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  test('slash command without source flag defaults to slash and falls through to default branch', async () => {
    // Legacy shape: no source field — slash ack lambda forwards raw SlackCommandPayload
    const legacy = {
      command: '/bgagent',
      text: 'unknown_sub',
      user_id: 'U1',
      team_id: 'T1',
      channel_id: 'C1',
      user_name: '',
      team_domain: '',
      channel_name: '',
      trigger_id: '',
      response_url: 'https://hooks.slack.com/cmd/X',
    };
    await handler(legacy);
    // Posted the default "Use @Shoof" hint back to the response_url
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('Use `@Shoof`'),
    );
    expect(posted).toBeTruthy();
  });

  test('slash submit tells user to use @mention', async () => {
    await handler(slashCommand({ text: 'submit org/repo fix' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Use `@Shoof` to submit tasks'),
    );
    expect(posted).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit requires linked account (prompts /bgagent link)', async () => {
    // 1. User mapping lookup: not found
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    // 2. swapReaction → getBotToken → installation lookup (for :x: swap)
    ddbSend.mockImplementation(ordinaryDb);
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo and no channel default replies with guidance', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // channel-default lookup returns a row without a repo → no default; then
    // swapReaction → getBotToken installation lookup.
    ddbSend.mockImplementation(ordinaryDb);
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Include owner/repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default and uses full text as description', async () => {
    ddbSend.mockImplementation(command => ordinaryDb(command, 'org/defaultrepo'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/defaultrepo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit fix the spacing on the header' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/defaultrepo');
    expect(reqBody.issue_number).toBeUndefined();
    // The whole message is the description — the first token is NOT dropped.
    expect(reqBody.task_description).toBe('fix the spacing on the header');
  });

  test('mention submit with no repo fails open when the channel lookup throws', async () => {
    ddbSend.mockImplementation(command => {
      if (command.input.TableName === 'SlackChannelMap') throw new Error('ddb blip');
      return ordinaryDb(command);
    });
    await handler(mention({ text: 'submit fix the bug' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Include owner/repo'),
    );
    expect(reply).toBeTruthy();
  });

  test('mention submit creates task via createTaskCore', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // Installation lookup for bot token (checkChannelAccess) + bot token secret
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    // fetch: conversations.info response (public channel with bot as member)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK123', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo#42 add validation' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.issue_number).toBe(42);
    expect(reqBody.task_description).toBe('add validation');
    // Must pin the coding workflow — an absent workflow_ref falls through the
    // resolution ladder to default/agent-v1, which never opens a PR. Mirrors
    // the Jira processor.
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
    expect(ctx.channelSource).toBe('slack');
    expect(ctx.userId).toBe('cognito-1');
    // mention_thread_ts flows to channel_metadata
    expect(ctx.channelMetadata.slack_thread_ts).toBe('1000.0001');
  });

  test('mention submit in private channel bot is not in — replies with invite hint', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockImplementation(ordinaryDb);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('private channel'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit fails open on transient Slack errors (ratelimited, internal_error)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockImplementation(ordinaryDb);
    // conversations.info returns a non-hard failure — task creation should proceed.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('link subcommand persists pending mapping with a link code', async () => {
    ddbSend.mockResolvedValueOnce({}); // Put pending mapping
    await handler(slashCommand({ text: 'link' }));
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toMatch(/^pending#/);
    expect(putCall![0].input.Item.status).toBe('pending');
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('bgagent slack link'),
    );
    expect(posted).toBeTruthy();
  });

  test('help subcommand replies with usage text', async () => {
    await handler(slashCommand({ text: 'help' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Using Shoof'),
    );
    expect(posted).toBeTruthy();
  });

  // ─── Slack file attachment extraction ────────────────────────────────────────

  describe('file attachments', () => {
    beforeEach(() => {
      // Standard setup: linked user, public channel
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockImplementation(ordinaryDb);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
    });

    test('downloads Slack files and passes as inline attachments', async () => {
      // fetch for file download
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('file content')),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({
        text: 'submit org/repo fix the bug',
        files: [{
          id: 'F1',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/screenshot.png',
        }],
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0].type).toBe('image');
      expect(reqBody.attachments[0].content_type).toBe('image/png');
      expect(reqBody.attachments[0].filename).toBe('screenshot.png');
      expect(reqBody.attachments[0].data).toBe(Buffer.from('file content').toString('base64'));
    });

    test('rejects files with unsupported MIME types', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'virus.exe',
          mimetype: 'application/x-executable',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/virus.exe',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('unsupported type'),
      );
      expect(reply).toBeTruthy();
    });

    test('rejects files exceeding 10 MB size limit', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'huge.png',
          mimetype: 'image/png',
          size: 11 * 1024 * 1024, // 11 MB
          url_private_download: 'https://files.slack.com/files/F1/huge.png',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('too large'),
      );
      expect(reply).toBeTruthy();
    });

    test('reports all file errors atomically', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [
          { id: 'F1', name: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, url_private_download: 'https://files.slack.com/files/F1/big.png' },
          { id: 'F2', name: 'bad.exe', mimetype: 'application/x-executable', size: 100, url_private_download: 'https://files.slack.com/files/F2/bad.exe' },
        ],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('2 attachment errors'),
      );
      expect(reply).toBeTruthy();
    });

    test('proceeds without attachments when no files are present', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      await handler(mention({ text: 'submit org/repo fix' }));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });
  });
  describe('thread context submission', () => {
    beforeEach(() => {
      ddbSend.mockImplementation(async (command: { _type: string; input: { TableName: string; Key?: { slack_identity?: string; task_id?: string } } }) => {
        if (command._type === 'Query' || command.input.Key?.slack_identity?.startsWith('thread-session#')) return {};
        if (command.input.TableName === 'Tasks') {
          return command.input.Key?.task_id === '01M666YYHRAB6SE77VS1SFKMFK'
            ? { Item: { user_id: 'cognito-1', repo: 'org/repo', development_session_id: '01M666YYHRAB6SE77VS1SFKMFK', development_latest_task_id: '01M666YYHRAB6SE77VS1SFKMFK' } } : {};
        }
        return {
          Item: command.input.TableName === 'SlackMap'
            ? { status: 'active', platform_user_id: 'cognito-1' }
            : { status: 'active', bot_user_id: 'UBOT' },
        };
      });
      fetchMock.mockImplementation(async (url: string) => String(url).includes('conversations.replies')
        ? new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1000.0001', user: 'U1', text: 'Previous requirement: keep the dashboard blue' },
            { ts: '1100.0001', user: 'UBOT', bot_id: 'B1', text: 'Blocker: test login' },
          ],
        }))
        : { ok: true, json: async () => ({ ok: true, channel: { is_member: true, is_private: false } }) });
      createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'TASK1' } }) });
    });
    const followup = (text: string, extra: Partial<MentionEvent> = {}) => mention({ text, mention_message_ts: '1200.0001', ...extra });
    test('default follow-up includes context while retaining explicit repo, workflow and session', async () => {
      await handler(followup('submit org/repo develop 01M666YYHRAB6SE77VS1SFKMFK Fix that blocker'));
      const [request, ctx] = createTaskCoreMock.mock.calls[0];
      expect(request).toMatchObject({ repo: 'org/repo', development_action: 'develop', development_session_id: '01M666YYHRAB6SE77VS1SFKMFK', workflow_ref: 'coding/new-task-v1' });
      expect(request.task_description).toContain('Blocker: test login');
      expect(request.task_description.endsWith('Fix that blocker')).toBe(true);
      expect(ctx.channelMetadata).toMatchObject({ slack_history_status: 'included', slack_history_count: '2', slack_history_truncated: 'false', slack_thread_ts: '1000.0001' });
    });
    test('off does not fetch history and does not carry over to a second sender', async () => {
      await handler(followup('submit org/repo --history=off develop Make it green'));
      expect(createTaskCoreMock.mock.calls[0][0].task_description).toBe('Make it green');
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
      await handler(followup('submit org/repo develop Keep it blue', { user_id: 'U2' }));
      expect(createTaskCoreMock.mock.calls[1][1].channelMetadata.slack_history_status).toBe('included');
    });

    test('a historical promote command cannot switch current task routing or action', async () => {
      fetchMock.mockImplementation(async (url: string) => String(url).includes('conversations.replies')
        ? new Response(JSON.stringify({ ok: true, messages: [{ ts: '1000.0001', user: 'U1', text: 'promote 01M666YYHRAB6SE77VS1SFKMFK attacker/other' }] }))
        : { ok: true, json: async () => ({ ok: true }) });
      await handler(followup('submit org/repo Explain that error'));
      const request = createTaskCoreMock.mock.calls[0][0];
      expect(request.repo).toBe('org/repo');
      expect(request.development_action).toBeUndefined();
      expect(request.development_session_id).toBeUndefined();
      expect(request.task_description.endsWith('Explain that error')).toBe(true);
    });

    test('history alone cannot become an empty current command authorization', async () => {
      await handler(followup('submit org/repo --history=on'));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
    });
    test('issue-only requests keep their issue target and an accurate acknowledgement preview', async () => {
      await handler(followup('submit org/repo#42 --history=on'));
      const [request, ctx] = createTaskCoreMock.mock.calls[0];
      expect(request.issue_number).toBe(42);
      expect(request.task_description.endsWith('Work on GitHub issue #42.')).toBe(true);
      expect(ctx.channelMetadata.slack_request_preview).toBe('Work on GitHub issue #42.');
    });
    test('promote routing is parsed before history, never from an earlier request', async () => {
      await handler(followup('submit org/repo --history=on promote 01M666YYHRAB6SE77VS1SFKMFK'));
      expect(createTaskCoreMock.mock.calls[0][0]).toMatchObject({ repo: 'org/repo', development_action: 'promote', development_session_id: '01M666YYHRAB6SE77VS1SFKMFK' });
    });
    test.each(['--history=no', '--history=on --history=off'])('invalid controls %s do not create a task', async flag => {
      await handler(followup(`submit org/repo ${flag} develop fix`));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
    });
    test('missing scopes reports reauthorization/off and never submits partial context', async () => {
      fetchMock.mockImplementation(async (url: string) => String(url).includes('conversations.replies')
        ? new Response(JSON.stringify({ ok: false, error: 'missing_scope' }))
        : { ok: true, json: async () => ({ ok: true }) });
      await handler(followup('submit org/repo fix it'));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const posted = fetchMock.mock.calls.filter(([url]) => String(url).includes('chat.postMessage'));
      expect(JSON.parse(posted[0][1].body).text).toMatch(/reauthorize.*--history=off/);
    });
    test('unlinked senders never fetch history or create tasks', async () => {
      ddbSend.mockResolvedValue({});
      await handler(followup('submit org/repo fix it'));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
    });
    test('private channel access denial prevents history reads', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: { is_private: true, is_member: false } }) });
      await handler(followup('submit org/repo fix it'));
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
    });
    test('workspace token lookup is bound to the triggering workspace', async () => {
      await handler(followup('submit org/repo fix it', { team_id: 'T2', channel_id: 'C2' }));
      expect(ddbSend.mock.calls.some(([command]) => command.input.TableName === 'SlackInstall' && command.input.Key.team_id === 'T2')).toBe(true);
      const [url] = fetchMock.mock.calls.find(([requestUrl]) => String(requestUrl).includes('conversations.replies'))!;
      expect(new URL(url).searchParams.get('channel')).toBe('C2');
      expect(createTaskCoreMock.mock.calls[0][1].channelMetadata.slack_team_id).toBe('T2');
    });
  });
  describe('automatic development continuation', () => {
    let tasks: Map<string, TaskRecord & { development_latest_task_id?: string; slack_pr_latest_task_id?: string }>;
    let bindings: Map<string, Record<string, unknown>>;
    let rejectAdmission: boolean;
    let barrier: (() => Promise<void>) | undefined;
    beforeEach(() => {
      tasks = new Map(); bindings = new Map(); rejectAdmission = false; barrier = undefined;
      ddbSend.mockImplementation(async (command: { _type: string; input: { TableName: string; Key?: Record<string, string>; ExpressionAttributeValues?: Record<string, string> } }) => {
        const { TableName, Key } = command.input;
        if (command._type === 'Query') return { Items: [...tasks.values()].filter(task => task.user_id === command.input.ExpressionAttributeValues?.[':owner']) };
        if (TableName === 'Tasks') return { Item: tasks.get(Key?.task_id ?? '') };
        if (TableName === 'SlackMap') {
          const key = Key?.slack_identity ?? '';
          return { Item: key.startsWith('thread-session#') ? bindings.get(key) : { status: 'active', platform_user_id: key.endsWith('#U2') ? 'cognito-2' : 'cognito-1' } };
        }
        if (TableName === 'SlackChannelMap') return { Item: { status: 'active', repo: 'org/default' } };
        return { Item: { status: 'active', bot_user_id: 'UBOT' } };
      });
      fetchMock.mockImplementation(async (url: string) => String(url).includes('conversations.replies')
        ? new Response(JSON.stringify({ ok: true, messages: [{ ts: '1000.0001', user: 'U1', text: 'Earlier game request' }] }))
        : { ok: true, json: async () => ({ ok: true, channel: { is_member: true, is_private: false } }) });
      // Handler test oracle: admission is atomic; real transaction construction is
      // covered by create-task-core tests, including its existing session lock.
      createTaskCoreMock.mockImplementation(async (request, ctx) => {
        if (barrier) await barrier();
        if (rejectAdmission) return { statusCode: 400, body: JSON.stringify({ error: { message: 'Repository admission denied' } }) };
        const id = ctx.taskId;
        const sessionId = request.development_session_id ?? id;
        const task = { task_id: id, user_id: ctx.userId, repo: request.repo, status: 'COMPLETED', ...(request.development_action && { development_action: request.development_action, development_session_id: sessionId, development_latest_task_id: id, production_branch: 'main' }), resolved_workflow: { id: request.workflow_ref, version: '1.0.0' }, channel_source: 'slack', channel_metadata: { ...ctx.channelMetadata, ...(!request.development_action && { slack_pr_root_task_id: ctx.slackThreadReservation.prRootTaskId ?? id }) }, ...(!request.development_action && { branch_name: 'bgagent/pr-15', pr_number: request.pr_number ?? 15, pr_url: `https://github.com/${request.repo}/pull/${request.pr_number ?? 15}`, slack_pr_latest_task_id: id }) } as unknown as TaskRecord;
        const put = slackThreadBindingPut(ctx.slackThreadReservation, 'SlackMap', task, 9999999999);
        const key = put.Item!.slack_identity as string;
        const old = bindings.get(key);
        if (tasks.has(id) || (old?.revision !== ctx.slackThreadReservation.expectedRevision)) {
          return { statusCode: 409, body: JSON.stringify({ error: { message: 'Thread changed concurrently; retry' } }) };
        }
        tasks.set(id, task);
        if (request.development_session_id) tasks.get(sessionId)!.development_latest_task_id = id;
        if (ctx.slackThreadReservation.prRootTaskId) tasks.get(ctx.slackThreadReservation.prRootTaskId)!.slack_pr_latest_task_id = id;
        bindings.set(key, put.Item!);
        return { statusCode: 201, body: JSON.stringify({ data: { task_id: id, development_session_id: sessionId } }) };
      });
    });
    const command = (text: string, ts: string, extra: Partial<MentionEvent> = {}) => mention({ text: `submit ${text}`, mention_message_ts: ts, ...extra });
    const latestBinding = () => [...bindings.values()][0];
    async function start() {
      await handler(command('org/repo develop Build a game', '1000.0001'));
      return [...tasks.keys()][0];
    }
    test('plain follow-up inherits develop without requiring the develop control', async () => {
      const id = await start();
      await handler(command('--history=off Add scoring', '1001.0001'));
      expect(createTaskCoreMock.mock.calls[1][0]).toMatchObject({ repo: 'org/repo', development_action: 'develop', development_session_id: id });
    });
    test('ordinary PR threads route plain follow-ups through the existing PR iteration workflow', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      const original = [...tasks.keys()][0];
      await handler(command('--history=off Fix the review findings', '1001.0001'));
      expect(createTaskCoreMock.mock.calls[1][0]).toMatchObject({ repo: 'org/repo', workflow_ref: 'coding/pr-iteration-v1', pr_number: 15, task_description: 'Fix the review findings' });
      expect(createTaskCoreMock.mock.calls[1][0].development_action).toBeUndefined();
      expect(latestBinding().pr_root_task_id).toBe(original);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
    });
    test('PR history-on and history-off requests use the same verified PR workflow', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      await handler(command('--history=off Fix the review', '1001.0001'));
      await handler(command('Address the earlier feedback', '1002.0001'));
      expect(createTaskCoreMock.mock.calls[2][0]).toMatchObject({ workflow_ref: 'coding/pr-iteration-v1', pr_number: 15 });
      expect(createTaskCoreMock.mock.calls[2][1].channelMetadata.slack_history_status).toBe('included');
    });
    test('an explicit new issue target does not silently iterate the previously bound PR', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      await handler(command('org/repo#42 --history=off Fix the new issue', '1001.0001'));
      expect(createTaskCoreMock.mock.calls[1][0]).toMatchObject({ repo: 'org/repo', issue_number: 42, workflow_ref: 'coding/new-task-v1' });
      expect(createTaskCoreMock.mock.calls[1][0].pr_number).toBeUndefined();
    });
    test('fresh without develop starts a new ordinary PR task and preserves the old root', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      const original = [...tasks.keys()][0];
      await handler(command('--session=new --history=off Build a separate fix', '1001.0001'));
      expect(createTaskCoreMock.mock.calls[1][0]).toMatchObject({ repo: 'org/repo', workflow_ref: 'coding/new-task-v1' });
      expect(createTaskCoreMock.mock.calls[1][0].pr_number).toBeUndefined();
      expect(latestBinding().pr_root_task_id).not.toBe(original);
      expect(tasks.has(original)).toBe(true);
    });
    test('missing saved PR task preserves the previous binding without admission', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      const original = { ...latestBinding() };
      tasks.delete(original.pr_root_task_id as string);
      await handler(command('--history=off Fix the review', '1001.0001'));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(latestBinding()).toEqual(original);
    });
    test('ordinary PR event retries are idempotent and cannot rebind a newer default', async () => {
      await handler(command('org/repo Fix the bug', '1000.0001'));
      const repeated = command('--history=off Fix the review', '1001.0001');
      await handler(repeated);
      await handler(command('--session=new --history=off Start separate work', '1002.0001'));
      const newer = { ...latestBinding() };
      await handler(repeated);
      expect(createTaskCoreMock).toHaveBeenCalledTimes(3);
      expect(latestBinding()).toEqual(newer);
    });
    test('omitted repo/session continues the saved branch with history disabled', async () => {
      const sessionId = await start();
      await handler(command('--history=off develop Add scoring', '1001.0001'));
      const [request, ctx] = createTaskCoreMock.mock.calls[1];
      expect(request).toMatchObject({ repo: 'org/repo', development_session_id: sessionId, development_action: 'develop', task_description: 'Add scoring' });
      expect(ctx.slackThreadReservation.expectedRevision).toBe(sessionId);
      expect(ctx.channelMetadata.slack_history_status).toBe('disabled');
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.replies'))).toBe(false);
      expect(latestBinding().session_id).toBe(sessionId);
      expect(latestBinding().revision).toBe(ctx.taskId);
    });
    test('history enabled and disabled both reuse the same session', async () => {
      const sessionId = await start();
      await handler(command('--history=off develop Add scoring', '1001.0001'));
      await handler(command('develop Fix the earlier error', '1002.0001'));
      expect(createTaskCoreMock.mock.calls[2][0].development_session_id).toBe(sessionId);
      expect(createTaskCoreMock.mock.calls[2][1].channelMetadata.slack_history_status).toBe('included');
    });
    test('fresh session inherits the repo, becomes the new default, and preserves old work', async () => {
      const old = await start();
      await handler(command('--session=new --history=off develop Build a fresh game', '1001.0001'));
      const fresh = createTaskCoreMock.mock.calls[1][1].taskId;
      expect(createTaskCoreMock.mock.calls[1][0]).toMatchObject({ repo: 'org/repo', development_action: 'develop' });
      expect(createTaskCoreMock.mock.calls[1][0].development_session_id).toBeUndefined();
      expect(fresh).not.toBe(old);
      expect(tasks.has(old)).toBe(true);
      await handler(command('--history=off develop Fix controls', '1002.0001'));
      expect(createTaskCoreMock.mock.calls[2][0].development_session_id).toBe(fresh);
      expect(latestBinding().session_id).toBe(fresh);
    });
    test('explicit different repo selects a fresh default', async () => {
      const old = await start();
      await handler(command('other/repo --history=off develop Build another app', '1001.0001'));
      expect(createTaskCoreMock.mock.calls[1][0].development_session_id).toBeUndefined();
      expect(latestBinding().repo).toBe('other/repo');
      expect(latestBinding().session_id).not.toBe(old);
    });
    test('explicit session without repo resolves trusted repo and overrides the default', async () => {
      const old = await start();
      await handler(command('--session=new --history=off develop Fresh work', '1001.0001'));
      await handler(command(`--history=off develop ${old} Continue old work`, '1002.0001'));
      expect(createTaskCoreMock.mock.calls[2][0]).toMatchObject({ repo: 'org/repo', development_session_id: old });
      expect(latestBinding().session_id).toBe(old);
    });
    test('failed admission preserves the prior binding', async () => {
      const old = await start(); const previous = { ...latestBinding() };
      rejectAdmission = true;
      await handler(command('--session=new --history=off develop Fresh work', '1001.0001'));
      expect(latestBinding()).toEqual(previous);
      rejectAdmission = false;
      await handler(command('--history=off develop Keep working', '1002.0001'));
      expect(createTaskCoreMock.mock.calls[2][0].development_session_id).toBe(old);
    });
    test('a second sender has a separate default and cannot select the first sender session', async () => {
      const first = await start();
      await handler(command('org/repo --history=off develop Another game', '1001.0001', { user_id: 'U2' }));
      expect(bindings.size).toBe(2);
      const calls = createTaskCoreMock.mock.calls.length;
      await handler(command(`--history=off develop ${first} Try another user session`, '1002.0001', { user_id: 'U2' }));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(calls);
      await handler(command('--history=off develop Continue my game', '1003.0001'));
      expect(createTaskCoreMock.mock.calls.at(-1)![0].development_session_id).toBe(first);
    });
    test('retrying an older message does not move a newer thread default backwards', async () => {
      await start();
      await handler(command('--session=new --history=off develop Fresh work', '1001.0001'));
      const latest = { ...latestBinding() }; const calls = createTaskCoreMock.mock.calls.length;
      await handler(command('org/repo develop Build a game', '1000.0001'));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(calls);
      expect(latestBinding()).toEqual(latest);
    });
    test('an older unadmitted retry cannot restore a prior explicit session', async () => {
      const old = await start();
      await handler(command('--session=new --history=off develop Fresh work', '1002.0001'));
      const current = { ...latestBinding() };
      await handler(command(`--history=off develop ${old} Delayed old command`, '1001.0001'));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(2);
      expect(latestBinding()).toEqual(current);
    });
    test('overlapping session=new submissions cannot install competing defaults', async () => {
      await start();
      let release!: () => void; let waiting = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      barrier = async () => { waiting++; if (waiting === 2) release(); await gate; };
      // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- exactly two requests exercise the admission race
      await Promise.all([
        handler(command('--session=new --history=off develop New A', '1001.0001')),
        handler(command('--session=new --history=off develop New B', '1002.0001')),
      ]);
      expect(tasks.size).toBe(2); // old root + exactly one accepted fresh task
      expect(bindings.size).toBe(1);
      expect(tasks.has(latestBinding().session_id as string)).toBe(true);
    });
    test('overlapping retries of one message create only one task', async () => {
      let release!: () => void; let waiting = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      barrier = async () => { waiting++; if (waiting === 2) release(); await gate; };
      const event = command('org/repo --session=new --history=off develop Fresh game', '1000.0001');
      // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- exactly two requests exercise the admission race
      await Promise.all([handler(event), handler(event)]);
      expect(tasks.size).toBe(1);
      expect(bindings.size).toBe(1);
      expect(createTaskCoreMock.mock.calls[0][1].taskId).toBe(createTaskCoreMock.mock.calls[1][1].taskId);
    });
    test('session=new plus an explicit ID is rejected without admission', async () => {
      const old = await start();
      await handler(command(`--session=new --history=off develop ${old} Conflicting request`, '1001.0001'));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    });
    test('promotion still requires an explicit session ID', async () => {
      await start();
      await handler(command('--history=off promote', '1001.0001'));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(latestBinding().session_id).toBe([...tasks.keys()][0]);
    });
  });
});
