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
import type { TaskRecord } from './types';

const TASK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{33,256}$/;
const RUNTIME_ARN = /^arn:(aws|aws-us-gov|aws-cn):bedrock-agentcore:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:runtime\/([A-Za-z][A-Za-z0-9_]{0,100}-[A-Za-z0-9]{10})(?:\/runtime-endpoint\/([A-Za-z0-9_-]{1,64}))?$/;
// Match the orchestrator heartbeat grace/stale windows. These are metadata
// checks, not a live AgentCore shell probe; the local CLI reports connection errors.
const STARTUP_GRACE_MS = 120_000;
const STALE_HEARTBEAT_MS = 240_000;
const MAX_LIFETIME_MS = 28_800_000;
const SHELL_ID_HASH_LENGTH = 12;
const CLOCK_SKEW_MS = 30_000;
export type TerminalTask = Pick<TaskRecord, 'task_id'> & Partial<Pick<TaskRecord,
  'status' | 'compute_type' | 'session_id' | 'agent_runtime_arn' | 'started_at' | 'agent_heartbeat_at' | 'repo' | 'branch_name'>>;
export class TerminalUnavailableError extends Error {}

export function terminalHandle(task: TerminalTask, now = Date.now()): { runtimeId: string; region: string; qualifier: string; sessionId: string } {
  const unavailable = () => new TerminalUnavailableError('Terminal unavailable: this task has no active, recent AgentCore session.');
  if (!TASK_ID.test(task.task_id) || task.compute_type !== 'agentcore' || !['RUNNING', 'AWAITING_APPROVAL'].includes(task.status ?? '')) throw unavailable();
  if (typeof task.session_id !== 'string' || !SESSION_ID.test(task.session_id) || typeof task.agent_runtime_arn !== 'string') throw unavailable();
  const arn = task.agent_runtime_arn.match(RUNTIME_ARN);
  if (!arn) throw unavailable();
  const started = Date.parse(task.started_at ?? '');
  if (!Number.isFinite(started) || started > now + CLOCK_SKEW_MS || now - started >= MAX_LIFETIME_MS) throw unavailable();
  if (task.agent_heartbeat_at !== undefined) {
    const heartbeat = Date.parse(task.agent_heartbeat_at);
    if (!Number.isFinite(heartbeat) || heartbeat > now + CLOCK_SKEW_MS || heartbeat < started - CLOCK_SKEW_MS
      || now - started > STARTUP_GRACE_MS && now - heartbeat > STALE_HEARTBEAT_MS) throw unavailable();
  } else if (now - started > STARTUP_GRACE_MS + STALE_HEARTBEAT_MS) {throw unavailable();}
  return { runtimeId: arn[3], region: arn[2], qualifier: arn[4] ?? 'DEFAULT', sessionId: task.session_id };
}

/** Identifiers only: authentication stays with the developer's local AWS credentials. */
export function terminalCommand(task: TerminalTask, developerId: string, now = Date.now()): string {
  const handle = terminalHandle(task, now);
  if (!developerId || developerId.length > 200) throw new TerminalUnavailableError('Terminal unavailable: invalid developer identity.');
  const shellId = `debug-${task.task_id}-${createHash('sha256').update(developerId).digest('hex').slice(0, SHELL_ID_HASH_LENGTH)}`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return 'agentcore runtime shell' + [
    ['--id', handle.runtimeId], ['--qualifier', handle.qualifier], ['--region', handle.region],
    ['--session-id', handle.sessionId], ['--shell-id', shellId],
  ].map(([flag, value]) => ` \\\n  ${flag} ${quote(value)}`).join('');
}

function slackLiteral(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'").replace(/[\r\n]/g, ' ').slice(0, 200);
}
export function terminalPrivateMessage(task: TerminalTask, developerId: string): string {
  const command = terminalCommand(task, developerId);
  return [
    '*Connect terminal*',
    `Task: \`${task.task_id}\` · Repo: \`${slackLiteral(task.repo ?? '')}\``,
    `Branch: \`${slackLiteral(task.branch_name ?? '')}\``,
    'Paste into your local terminal using your AWS profile:',
    '```' + command + '```',
    'Requires a compatible AgentCore CLI (`agentcore runtime shell --help`) and your AWS identity’s `bedrock-agentcore:InvokeAgentRuntimeCommandShell` permission.',
    'Ctrl+] detaches; run the same command to reconnect. Ctrl+D or exit closes your debug shell.',
    'This opens a separate shell alongside the agent. The agent keeps running. Availability is based on task/heartbeat metadata; the CLI verifies the live connection.',
  ].join('\n');
}
