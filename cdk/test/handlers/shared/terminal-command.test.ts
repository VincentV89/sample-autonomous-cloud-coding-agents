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
test.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUBMITTED', 'HYDRATING', 'QUEUED', 'FINALIZING'])('does not attach to %s tasks', status => {
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
