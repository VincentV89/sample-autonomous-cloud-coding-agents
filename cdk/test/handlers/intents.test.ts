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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../../src/handlers/intents';
import type { IntentWorkspace } from '../../src/handlers/shared/intent-workspace';

const send = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({
  makeDocClient: () => ({ send: (...args: unknown[]) => send(...args) }),
  makeClient: () => ({ send: jest.fn() }),
}));

const intent: IntentWorkspace = {
  id: 'conference',
  owner: 'owner-1',
  repo: 'org/eventflow',
  idea: 'Conference registration',
  members: { 'contributor-1': 'contributor', 'reviewer-1': 'reviewer' },
  revision: 0,
  baseCommit: 'a'.repeat(40),
  productionBranch: 'trunk',
  checkpoints: [],
  questions: { 'intent-capture': [{ id: 'scope', prompt: 'Who can register?', options: [] }] },
  versions: [{ version: 1, commit: 'b'.repeat(40), path: 'aidlc/intents/conference/v1/intent.md', markdown: '# Approved' }],
};

function event(user?: string, mutation?: object): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { 'sub': user, 'cognito:groups': 'console-admins' } } },
    pathParameters: { id: intent.id },
    httpMethod: mutation ? 'POST' : 'GET',
    body: mutation ? JSON.stringify(mutation) : null,
  } as unknown as APIGatewayProxyEvent;
}

async function api(user?: string, mutation?: object): Promise<APIGatewayProxyResult> {
  return await handler(event(user, mutation)) as APIGatewayProxyResult;
}

beforeEach(() => {
  send.mockReset().mockResolvedValue({ Item: intent });
});

test('an administrator without intent membership cannot discover the workspace', async () => {
  expect((await api()).statusCode).toBe(401);
  const forbidden = await api('admin-1');
  expect(forbidden.statusCode).toBe(404);
  expect(forbidden.body).not.toContain(intent.idea);
});

test('reviewers can read and comment, but cannot answer, approve, or start a build', async () => {
  expect((await api('reviewer-1')).statusCode).toBe(200);
  expect((await api('reviewer-1', { action: 'comment', revision: 0, value: 'Review note' })).statusCode).toBe(200);
  expect((await api('reviewer-1', { action: 'answer', revision: 0, question: 'scope', value: 'Anyone', deferred: false })).statusCode).toBe(400);
  expect((await api('reviewer-1', { action: 'checkpoint', revision: 0 })).statusCode).toBe(400);
  await expect(handler({ operation: 'resolve', user: 'reviewer-1', reference: 'conference@v1' }))
    .resolves.toEqual({ error: 'Published intent not found.' });
});

test('answer autosave protects concurrent edits with the persisted revision', async () => {
  const request = { action: 'answer', revision: 0, question: 'scope', value: 'Anyone', deferred: false };
  expect((await api('contributor-1', request)).statusCode).toBe(200);
  expect(send.mock.calls[1][0].input).toMatchObject({
    ConditionExpression: '#revision = :previous',
    ExpressionAttributeValues: { ':previous': 0 },
    Item: { revision: 1 },
  });
  send.mockResolvedValueOnce({ Item: { ...intent, revision: 1 } });
  expect((await api('contributor-1', request)).statusCode).toBe(409);
});

test('handoff returns only the exact approved version selected by an authorized member', async () => {
  await expect(handler({ operation: 'resolve', user: 'contributor-1', reference: 'conference@v1' }))
    .resolves.toEqual({ repo: intent.repo, commit: intent.versions[0].commit, path: intent.versions[0].path, productionBranch: 'trunk' });
  await expect(handler({ operation: 'resolve', user: 'owner-1', reference: 'conference@v2' }))
    .resolves.toEqual({ error: 'Published intent not found.' });
});
