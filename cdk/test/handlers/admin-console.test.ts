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

import type { APIGatewayProxyEvent } from 'aws-lambda';
const send = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send }) }));
import { handler } from '../../src/handlers/admin-console';

process.env.REPO_TABLE_NAME = 'Repos';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.CONSOLE_ORIGIN = 'https://console.example.com';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'Slack';
const taskId = '01M66590HPQJAYYSH0V9WW19HS';
function event(resource = 'repos', method = 'GET', admin = true): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    pathParameters: { resource },
    queryStringParameters: null,
    requestContext: { authorizer: { claims: { 'sub': 'user-1', 'cognito:groups': admin ? 'console-admins,team-a' : 'team-a' } } },
  } as unknown as APIGatewayProxyEvent;
}
const data = (response: { body: string }) => JSON.parse(response.body);
beforeEach(() => send.mockReset());

test('unauthenticated callers cannot read console resources', async () => {
  const e = event(); e.requestContext.authorizer = undefined;
  expect((await handler(e)).statusCode).toBe(401); expect(send).not.toHaveBeenCalled();
});
test('ordinary users can read their session but not administer repositories', async () => {
  expect(data(await handler(event('session', 'GET', false))).data.administrator).toBe(false);
  expect((await handler(event('repos', 'GET', false))).statusCode).toBe(403);
  expect((await handler(event('repos', 'POST', false))).statusCode).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
test('integration data is also administrator-only', async () => {
  expect((await handler(event('slack_workspaces', 'GET', false))).statusCode).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
test('lists bounded repo pages and strips unexpected credential fields', async () => {
  send.mockResolvedValue({ Items: [{ repo: 'org/repo', status: 'active', github_token_secret_arn: 'secret', password: 'secret' }], LastEvaluatedKey: { repo: 'org/repo' } });
  const response = data(await handler(event()));
  expect(response.data).toEqual([{ repo: 'org/repo', status: 'active' }]);
  expect(response.pagination.has_more).toBe(true);
  expect(send.mock.calls[0][0].input).toMatchObject({ Limit: 50, TableName: 'Repos' });
});
test('workspace responses never include Slack tokens or secret ARNs', async () => {
  send.mockResolvedValue({ Items: [{ team_id: 'T1', scope: 'files:read', bot_token: 'hidden', bot_token_secret_arn: 'hidden' }] });
  expect(data(await handler(event('slack_workspaces'))).data).toEqual([{ team_id: 'T1', scope: 'files:read' }]);
});
test('rejects malformed and cross-dataset pagination cursors', async () => {
  for (const next_token of ['bad', Buffer.from(JSON.stringify({ dataset: 'jira_projects', key: { repo: 'x' } })).toString('base64url')]) {
    const e = event(); e.queryStringParameters = { next_token };
    expect((await handler(e)).statusCode).toBe(400);
  }
  expect(send).not.toHaveBeenCalled();
});
test('uses the continuation key without widening the table scan', async () => {
  send.mockResolvedValue({ Items: [] }); const e = event();
  e.queryStringParameters = { next_token: Buffer.from(JSON.stringify({ dataset: 'repos', key: { repo: 'org/last' } })).toString('base64url') };
  expect((await handler(e)).statusCode).toBe(200);
  expect(send.mock.calls[0][0].input.ExclusiveStartKey).toEqual({ repo: 'org/last' });
});
test('onboarding is an atomic update preserving existing overrides and creation time', async () => {
  send.mockResolvedValue({ Attributes: { repo: 'org/repo', status: 'active', model_id: 'existing', github_token_secret_arn: 'hidden' } });
  const e = event('repos', 'POST'); e.body = JSON.stringify({ repo: 'org/repo' });
  const response = await handler(e); expect(response.statusCode).toBe(200);
  const input = send.mock.calls[0][0].input;
  expect(input.Key).toEqual({ repo: 'org/repo' });
  expect(input.UpdateExpression).toContain('if_not_exists(onboarded_at, :now)');
  expect(input.UpdateExpression).toContain('REMOVE #ttl');
  expect(input.UpdateExpression).not.toMatch(/model_id|github_token_secret_arn|compute_type/);
  expect(data(response).data).toEqual({ repo: 'org/repo', status: 'active', model_id: 'existing' });
});
test.each([{ repo: 'bad' }, { repo: '../x' }, { repo: 'org/..' }, { repo: 'org/repo', runtime_arn: 'evil' }, null, []])('rejects invalid onboarding body %j', async body => {
  const e = event('repos', 'POST'); e.body = JSON.stringify(body);
  expect((await handler(e)).statusCode).toBe(400); expect(send).not.toHaveBeenCalled();
});
test('storage failure does not report success or leak the exception', async () => {
  send.mockRejectedValue(new Error('private failure detail'));
  const response = await handler(event()); expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('private failure detail');
});
test('unconfigured integrations are explicit failures', async () => {
  expect((await handler(event('jira_projects'))).statusCode).toBe(503);
});
test('task context never grants admin cross-user access', async () => {
  send.mockResolvedValue({ Item: { user_id: 'other', answer_text: 'private' } });
  const e = event('task-context'); e.queryStringParameters = { task_id: taskId };
  const response = await handler(e); expect(response.statusCode).toBe(404); expect(response.body).not.toContain('private');
});
test('owner context includes only the final answer and allowlisted source fields', async () => {
  send.mockResolvedValue({ Item: { user_id: 'user-1', answer_text: 'Done', channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', slack_thread_ts: '123.45', jira_site_url: 'https://example.atlassian.net', jira_issue_key: 'KAN-4', jira_oauth_secret_arn: 'hidden', slack_response_url: 'hidden' } } });
  const e = event('task-context', 'GET', false); e.queryStringParameters = { task_id: taskId };
  const response = data(await handler(e)).data;
  expect(response.answer_text).toBe('Done'); expect(response.slack.channel_id).toBe('C1'); expect(response.jira.issue_key).toBe('KAN-4');
  expect(JSON.stringify(response)).not.toContain('hidden');
});

test('console responses restrict CORS to the configured origin', async () => {
  const response = await handler(event('session'));
  expect(response.headers?.['Access-Control-Allow-Origin']).toBe('https://console.example.com');
  expect(response.headers?.Vary).toBe('Origin');
});
