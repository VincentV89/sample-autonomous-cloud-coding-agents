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

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseDevelopmentCommand } from '../../../src/handlers/shared/development-command';
import { prepareDevelopmentTask, validProductionBranch } from '../../../src/handlers/shared/development-sessions';

const id = '01M63BWYJJJW7NHH6CW0PFPSVS';
const next = '01M63BWYJJJW7NHH6CW0PFPSVT';
const sha = 'a'.repeat(40);
const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
const root = {
  task_id: id,
  development_session_id: id,
  development_latest_task_id: id,
  user_id: 'user',
  repo: 'owner/repo',
  production_branch: 'main',
  status: 'COMPLETED',
  head_sha: sha,
};
const request = { repo: 'owner/repo', development_action: 'develop' as const, development_session_id: id };
beforeEach(() => send.mockReset());

test('default behavior remains unchanged without development fields', async () => {
  expect(await prepareDevelopmentTask(ddb, 'tasks', {}, 'user', next, 'coding/new-task-v1')).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});
test('starts a private session on a deterministic branch without a PR', async () => {
  const plan = await prepareDevelopmentTask(ddb, 'tasks', { repo: 'owner/repo', development_action: 'develop' }, 'user', id, 'coding/new-task-v1');
  expect(plan).toMatchObject({ isNew: true, sessionId: id, branch: `bgagent/development/${id}`, productionBranch: 'main' });
});
test('continues the verified revision and reserves with a compare-and-swap', async () => {
  send.mockResolvedValue({ Item: root });
  const plan = await prepareDevelopmentTask(ddb, 'tasks', request, 'user', next, 'coding/new-task-v1');
  expect(plan?.metadata.development_expected_sha).toBe(sha);
  expect(plan?.advance).toMatchObject({
    ConditionExpression: 'development_latest_task_id = :previous AND user_id = :owner',
    ExpressionAttributeValues: { ':previous': id, ':next': next, ':owner': 'user' },
  });
  expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
});
test.each([{ ...root, user_id: 'another' }, { ...root, repo: 'another/repo' }, undefined])('rejects inaccessible session %#', async item => {
  send.mockResolvedValue({ Item: item });
  await expect(prepareDevelopmentTask(ddb, 'tasks', request, 'user', next, 'coding/new-task-v1')).rejects.toMatchObject({ statusCode: 404 });
});
test('rejects overlapping iterations', async () => {
  send.mockResolvedValue({ Item: { ...root, status: 'RUNNING' } });
  await expect(prepareDevelopmentTask(ddb, 'tasks', request, 'user', next, 'coding/new-task-v1')).rejects.toMatchObject({ statusCode: 409 });
});
test('freezes promotion atomically with its task reservation', async () => {
  send.mockResolvedValue({ Item: root });
  const plan = await prepareDevelopmentTask(ddb, 'tasks', { ...request, development_action: 'promote' }, 'user', next, 'coding/new-task-v1');
  expect(plan?.advance?.UpdateExpression).toContain('channel_metadata.development_frozen');
  expect(plan?.metadata.development_expected_sha).toBe(sha);
});
test('a partially failed promotion stays frozen but permits promotion retry', async () => {
  send.mockResolvedValue({ Item: { ...root, channel_metadata: { development_frozen: 'true' } } });
  await expect(prepareDevelopmentTask(ddb, 'tasks', request, 'user', next, 'coding/new-task-v1')).rejects.toMatchObject({ statusCode: 409 });
  await expect(prepareDevelopmentTask(ddb, 'tasks', { ...request, development_action: 'promote' }, 'user', next, 'coding/new-task-v1')).resolves.toBeDefined();
});
test('does not create another PR after a promotion returned its URL', async () => {
  send.mockResolvedValue({ Item: { ...root, development_action: 'promote', pr_url: 'https://github.com/owner/repo/pull/1' } });
  await expect(prepareDevelopmentTask(ddb, 'tasks', { ...request, development_action: 'promote' }, 'user', next, 'coding/new-task-v1')).rejects.toMatchObject({ statusCode: 409 });
});
test.each(['--force', '../main', 'a..b', 'a.lock', 'a//b', 'a/', 'a@{b'])('rejects unsafe production ref %s', ref => expect(validProductionBranch(ref)).toBe(false));
test('parses explicit Slack controls without treating prose as promotion', () => {
  expect(parseDevelopmentCommand(`promote ${id}`)).toEqual({ development_action: 'promote', development_session_id: id });
  expect(parseDevelopmentCommand(`develop ${id} add scoring`)).toMatchObject({ development_session_id: id, task_description: 'add scoring' });
  expect(parseDevelopmentCommand('develop build a game')).toMatchObject({ development_action: 'develop', task_description: 'build a game' });
  expect(parseDevelopmentCommand('explain how to promote a branch')).toEqual({ task_description: 'explain how to promote a branch' });
});
