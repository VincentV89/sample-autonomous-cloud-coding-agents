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

import { spawnSync } from 'child_process';
import { terminalCommand, terminalHandle, terminalPrivateMessage, type TerminalTask } from '../../../src/handlers/shared/terminal-command';
const now = Date.parse('2026-11-06T04:10:00Z');
const id = '01M6K1S4S1QQ9KT6NXQ8B31RAG';
const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/MyCodingAgent-0123456789';
const session = '123e4567-e89b-12d3-a456-426614174000';
const task = (extra = {}): TerminalTask => ({ task_id: id, status: 'RUNNING', compute_type: 'agentcore', session_id: session, agent_runtime_arn: arn, started_at: new Date(now - 60000).toISOString(), agent_heartbeat_at: new Date(now - 10000).toISOString(), repo: 'org/repo', branch_name: 'bgagent/development/branch', ...extra });
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => jest.restoreAllMocks());
test('generates a ready-to-paste, shell-valid command for the actual runtime session', () => {
  const cmd = terminalCommand(task(), 'developer-1');
  const result = spawnSync('/bin/sh', ['-c', `agentcore() { printf '%s\n' "$@"; }\n${cmd}`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const args = result.stdout.trim().split('\n');
  expect(args.slice(0, 10)).toEqual(['runtime', 'shell', '--id', 'MyCodingAgent-0123456789', '--qualifier', 'DEFAULT', '--region', 'us-east-1', '--session-id', session]);
  expect(args[10]).toBe('--shell-id');
  expect(args[11]).toMatch(new RegExp(`^debug-${id}-[0-9a-f]{12}$`));
  expect(cmd).not.toContain('TOKEN');
});
test('keeps the shell ID stable for reconnects and isolated by developer and task', () => {
  const first = terminalCommand(task(), 'developer-1');
  expect(terminalCommand(task(), 'developer-1')).toBe(first);
  expect(terminalCommand(task(), 'developer-2')).not.toBe(first);
  expect(terminalCommand(task({ task_id: '01M666YYHRAB6SE77VS1SFKMFK' }), 'developer-1')).not.toBe(first);
});
test('parses the intended endpoint qualifier and ARN region, independent of host defaults', () => {
  expect(terminalHandle(task({ agent_runtime_arn: arn.replace('us-east-1', 'ap-southeast-1') + '/runtime-endpoint/PREVIEW' }))).toMatchObject({ region: 'ap-southeast-1', qualifier: 'PREVIEW' });
});
test.each(['FAILED', 'CANCELLED', 'TIMED_OUT', 'SUBMITTED', 'HYDRATING', 'QUEUED', 'FINALIZING'])('does not attach to %s tasks', status => {
  expect(() => terminalCommand(task({ status }), 'developer')).toThrow(/Terminal unavailable/);
});
test.each([
  { compute_type: 'ecs' }, { compute_type: 'lambda-microvm' }, { compute_type: undefined },
  { task_id: 'bad; echo nope' }, { session_id: undefined }, { session_id: id },
  { session_id: session + "'; echo nope" }, { agent_runtime_arn: arn + '; echo nope' },
  { agent_runtime_arn: arn + '/runtime-endpoint/DEFAULT;false' }, { agent_runtime_arn: undefined },
  { started_at: undefined }, { started_at: 'bad' }, { started_at: new Date(now + 60000).toISOString() },
  { started_at: new Date(now - 8 * 3600000).toISOString() }, { agent_heartbeat_at: 'bad' },
  { agent_heartbeat_at: new Date(now + 60000).toISOString() },
  { started_at: new Date(now - 600000).toISOString(), agent_heartbeat_at: new Date(now - 300000).toISOString() },
  { started_at: new Date(now - 600000).toISOString(), agent_heartbeat_at: undefined },
])('rejects missing, stale or unsafe metadata %j', extra => {
  expect(() => terminalCommand(task(extra), 'developer')).toThrow(/Terminal unavailable/);
});
test('accepts startup grace and fresh approval-paused sessions', () => {
  expect(terminalHandle(task({ agent_heartbeat_at: undefined })).sessionId).toBe(session);
  expect(terminalHandle(task({ status: 'AWAITING_APPROVAL' })).sessionId).toBe(session);
});
test('includes copyable command and reconnect guidance while escaping display metadata', () => {
  const text = terminalPrivateMessage(task({ branch_name: '`fake` <@UOTHER>\ninjected' }), 'developer');
  expect(text).toContain('```agentcore runtime shell');
  expect(text).toContain('Ctrl+]');
  expect(text).toContain('separate shell');
  expect(text).not.toContain('<@UOTHER>');
  expect(text).not.toContain('`fake`');
  expect(text).not.toContain('\ninjected');
});

describe('completed task connection window', () => {
  const created = new Date(now - 3 * 3600000).toISOString();
  const started = new Date(now - 2 * 3600000).toISOString();
  const finished = new Date(now - 3600000).toISOString();
  const completed = (extra = {}) => task({
    status: 'COMPLETED',
    created_at: created,
    started_at: started,
    completed_at: finished,
    agent_heartbeat_at: finished,
    ...extra,
  });
  test('allows stale or absent heartbeat after normal completion with the exact original handle', () => {
    for (const heartbeat of [finished, undefined]) {
      const result = terminalHandle(completed({ agent_heartbeat_at: heartbeat }));
      expect(result.sessionId).toBe(session);
      expect(result.expiresAt).toBe(new Date(Date.parse(created) + 8 * 3600000).toISOString());
      expect(terminalCommand(completed({ agent_heartbeat_at: heartbeat }), 'developer')).toContain(session);
    }
  });
  test('normal completion preserves the per-task/developer shell used during the run', () => {
    expect(terminalCommand(completed(), 'developer')).toBe(terminalCommand(task(), 'developer'));
  });
  test.each([
    { created_at: undefined }, { created_at: 'bad' }, { created_at: 17 },
    { completed_at: undefined }, { completed_at: 'bad' }, { completed_at: 17 },
    { started_at: undefined }, { started_at: 'bad' },
    { created_at: new Date(now + 60000).toISOString() },
    { created_at: new Date(now - 1000).toISOString() },
    { completed_at: new Date(now + 60000).toISOString() },
    { completed_at: new Date(now - 4 * 3600000).toISOString() },
    { agent_heartbeat_at: 'bad' }, { agent_heartbeat_at: new Date(now + 60000).toISOString() },
    { session_id: undefined }, { agent_runtime_arn: undefined }, { compute_type: 'ecs' },
  ])('rejects malformed completed metadata %j', extra => {
    expect(() => terminalHandle(completed(extra))).toThrow(/Terminal unavailable/);
  });
  test('does not reset expiry from completion or a much later compute start', () => {
    const freshFinish = new Date(now - 1000).toISOString();
    expect(() => terminalHandle(completed({
      created_at: new Date(now - 8 * 3600000).toISOString(),
      completed_at: freshFinish,
      agent_heartbeat_at: freshFinish,
    }))).toThrow(/Terminal unavailable/);
    expect(terminalHandle(completed({ created_at: new Date(now - 8 * 3600000 + 1).toISOString() })).sessionId).toBe(session);
    expect(() => terminalHandle(completed({ started_at: new Date(now - 9 * 3600000).toISOString() }))).toThrow(/Terminal unavailable/);
  });
  test('states completed-task limits and service re-provisioning without claiming an active agent', () => {
    const text = terminalPrivateMessage(completed(), 'developer');
    expect(text).toContain('Task completed.');
    expect(text).toContain('independent manual work');
    expect(text).not.toContain('agent keeps running');
    expect(text).toContain('not a live session check');
    expect(text).toContain('fresh compute');
    expect(text).toContain('original workspace is not guaranteed');
    expect(text).toContain('Completion does not extend');
  });
  test('a stale running heartbeat is still denied for the same otherwise eligible metadata', () => {
    expect(() => terminalHandle(completed({ status: 'RUNNING' }))).toThrow(/Terminal unavailable/);
    expect(() => terminalHandle(completed({ status: 'AWAITING_APPROVAL' }))).toThrow(/Terminal unavailable/);
  });
});
