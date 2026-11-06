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
  'status' | 'compute_type' | 'session_id' | 'agent_runtime_arn' | 'created_at' | 'completed_at' | 'started_at' | 'agent_heartbeat_at' | 'repo' | 'branch_name'>>;
export class TerminalUnavailableError extends Error {}

function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

export function terminalHandle(task: TerminalTask, now = Date.now()): {
  runtimeId: string; region: string; qualifier: string; sessionId: string; expiresAt: string;
} {
  const unavailable = () => new TerminalUnavailableError(
    'Terminal unavailable: this task has no eligible AgentCore session within its connection window.',
  );
  if (!TASK_ID.test(task.task_id) || task.compute_type !== 'agentcore'
    || !['RUNNING', 'AWAITING_APPROVAL', 'COMPLETED'].includes(task.status ?? '')) throw unavailable();
  if (typeof task.session_id !== 'string' || !SESSION_ID.test(task.session_id) || typeof task.agent_runtime_arn !== 'string') throw unavailable();
  const arn = task.agent_runtime_arn.match(RUNTIME_ARN);
  if (!arn) throw unavailable();
  const started = timestamp(task.started_at);
  if (!Number.isFinite(started) || started > now + CLOCK_SKEW_MS || now - started >= MAX_LIFETIME_MS) throw unavailable();
  const completed = task.status === 'COMPLETED';
  let windowStart = started;
  if (completed) {
    const created = timestamp(task.created_at);
    const finished = timestamp(task.completed_at);
    // Task creation precedes compute provisioning. Using it is conservative:
    // queue/startup time counts, and completion never resets the eight-hour cap.
    if (!Number.isFinite(created) || created > started + CLOCK_SKEW_MS || created > now + CLOCK_SKEW_MS
      || !Number.isFinite(finished) || finished < started - CLOCK_SKEW_MS
      || finished > now + CLOCK_SKEW_MS) throw unavailable();
    windowStart = Math.min(created, started);
    if (now - windowStart >= MAX_LIFETIME_MS) throw unavailable();
  }
  if (task.agent_heartbeat_at !== undefined) {
    const heartbeat = timestamp(task.agent_heartbeat_at);
    if (!Number.isFinite(heartbeat) || heartbeat > now + CLOCK_SKEW_MS || heartbeat < started - CLOCK_SKEW_MS
      || !completed && now - started > STARTUP_GRACE_MS && now - heartbeat > STALE_HEARTBEAT_MS) throw unavailable();
  } else if (!completed && now - started > STARTUP_GRACE_MS + STALE_HEARTBEAT_MS) {throw unavailable();}
  return {
    runtimeId: arn[3],
    region: arn[2],
    qualifier: arn[4] ?? 'DEFAULT',
    sessionId: task.session_id,
    expiresAt: new Date(windowStart + MAX_LIFETIME_MS).toISOString(),
  };
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
  const now = Date.now();
  const handle = terminalHandle(task, now);
  const command = terminalCommand(task, developerId, now);
  return [
    '*Connect terminal*',
    `Task: \`${task.task_id}\` · Repo: \`${slackLiteral(task.repo ?? '')}\``,
    `Branch: \`${slackLiteral(task.branch_name ?? '')}\``,
    'Paste into your local terminal using your AWS profile:',
    '```' + command + '```',
    'Requires a compatible AgentCore CLI (`agentcore runtime shell --help`) and your AWS identity’s `bedrock-agentcore:InvokeAgentRuntimeCommandShell` permission.',
    'Ctrl+] detaches; run the same command to reconnect. Ctrl+D or exit closes your debug shell.',
    task.status === 'COMPLETED'
      ? 'Task completed. Use this shell for inspection or independent manual work; changes are not added to the completed task result.'
      : 'This opens a separate shell alongside the agent. The agent keeps running.',
    `Conservative connection window ends: ${handle.expiresAt}. Completion does not extend the environment lifetime.`,
    'Eligibility is based on task metadata, not a live session check. AgentCore may provision fresh compute if the session stopped; the original workspace is not guaranteed.',
  ].join('\n');
}
