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

import { TaskStatus, type TaskStatusType } from '../../../src/constructs/task-status';
import { type ActionsBlock, renderSlackBlocks, type SlackBlock } from '../../../src/handlers/shared/slack-blocks';

/** Narrow to a section block and return its text; throws if block isn't a section. */
function sectionText(block: SlackBlock): string {
  if (block.type !== 'section') {
    throw new Error(`expected section block, got ${block.type}`);
  }
  return block.text.text;
}

/** Narrow to an actions block; throws if block isn't one. */
function actionsBlock(block: SlackBlock): ActionsBlock {
  if (block.type !== 'actions') {
    throw new Error(`expected actions block, got ${block.type}`);
  }
  return block;
}

describe('renderSlackBlocks', () => {
  const baseTask = {
    task_id: '01HXYZ123',
    repo: 'org/repo',
    task_description: 'Fix the login bug',
    pr_url: undefined as string | undefined,
    error_message: undefined as string | undefined,
    cost_usd: undefined as number | undefined,
    duration_s: undefined as number | undefined,
    status: TaskStatus.SUBMITTED as TaskStatusType,
  };

  test('development completion exposes the session and verified SHA without a PR button', () => {
    const task = {
      ...baseTask,
      development_session_id: 'SESSION',
      development_action: 'develop' as const,
      branch_name: 'bgagent/development/SESSION',
      head_sha: 'a'.repeat(40),
    };
    const message = renderSlackBlocks('task_completed', task);
    expect(sectionText(message.blocks[0])).toContain('SESSION');
    expect(sectionText(message.blocks[0])).toContain('a'.repeat(40));
    expect(message.blocks.some(block => block.type === 'actions')).toBe(false);
  });

  test('renders task_created message', () => {
    const msg = renderSlackBlocks('task_created', baseTask);
    expect(msg.text).toContain('org/repo');
    expect(msg.blocks).toHaveLength(1);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rocket:');
    expect(text).toContain('Fix the login bug');
    expect(text).toContain('01HXYZ123');
  });

  test('coding result shows summary and reported checks without a deployment link', () => {
    const task = { ...baseTask, completion_summary: { summary: 'Added keyboard controls.', verification: ['Build passed'] } };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[1])).toContain('Added keyboard controls.');
    expect(sectionText(msg.blocks[1])).toContain('Checks (agent reported):');
    expect(msg.blocks.some(block => block.type === 'actions')).toBe(false);
    expect(msg.text).toContain('Added keyboard controls.');
  });

  test('preview link and PR coexist without implying deployment verification', () => {
    const task = {
      ...baseTask,
      pr_url: 'https://github.com/org/repo/pull/42',
      completion_summary: {
        summary: 'Deployed a development preview.',
        development_url: 'https://example.cloudfront.net/',
        verification: ['Build passed', 'HTTP 200'],
      },
    };
    const msg = renderSlackBlocks('task_completed', task);
    const buttons = actionsBlock(msg.blocks[2]).elements;
    expect(buttons.map(button => button.text.text)).toEqual(['Open development preview', 'View PR #42']);
    expect(msg.text).toContain('https://example.cloudfront.net/');
  });

  test('blocked deployment warns even though the commit was saved successfully', () => {
    const task = {
      ...baseTask,
      completion_summary: {
        summary: 'Code saved; deployment could not run.', blockers: ['CloudFormation AccessDenied'],
      },
    };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain(':warning:');
    expect(msg.text).toContain('Work needs attention');
    expect(msg.text).not.toContain('Task completed');
    expect(sectionText(msg.blocks[1])).toContain('CloudFormation AccessDenied');
  });

  test('question-only outcome does not invent checks or saved commits', () => {
    const msg = renderSlackBlocks('task_completed', { ...baseTask, completion_summary: { summary: 'The score resets because game state is recreated.' } });
    const text = msg.blocks.map(sectionText).join('\n');
    expect(text).not.toContain('Checks');
    expect(text).not.toContain('Saved:');
    expect(text).toContain('The score resets');
  });

  test.each(['javascript:alert(1)', 'https://user:pass@example.com/', 'https://example.com/?token=secret', 'https://example.com/#secret', 'https://example.com/<@here>', 'https://example.com/***'])('rejects unsafe preview URL %s', development_url => {
    const msg = renderSlackBlocks('task_completed', { ...baseTask, completion_summary: { summary: 'Work saved.', development_url } });
    expect(msg.blocks.some(block => block.type === 'actions')).toBe(false);
    expect(msg.text).not.toContain(development_url);
  });

  test('model-provided Slack syntax cannot ping users or inject links', () => {
    const msg = renderSlackBlocks('task_completed', {
      ...baseTask,
      completion_summary: {
        summary: '<!here> <@U123> <https://evil.example|click> & @channel', blockers: ['<!everyone>'],
      },
    });
    const text = sectionText(msg.blocks[1]);
    expect(text).not.toContain('<');
    expect(text).not.toContain('@channel');
    expect(text).toContain('&lt;');
    const block = msg.blocks[1];
    if (block.type !== 'section') throw new Error('expected section');
    expect(block.text.verbatim).toBe(true);
  });

  test('long escaped text remains bounded and keeps blockers visible', () => {
    const msg = renderSlackBlocks('task_completed', {
      ...baseTask,
      completion_summary: {
        summary: '&'.repeat(10000),
        verification: ['x'.repeat(10000), 'test', 'test', 'ignored'],
        blockers: ['Deployment blocked'],
      },
    });
    expect(sectionText(msg.blocks[1]).length).toBeLessThan(3000);
    expect(sectionText(msg.blocks[1])).toContain('Deployment blocked');
    expect(sectionText(msg.blocks[1])).not.toContain('ignored');
  });

  test('renders task_completed message with PR URL', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, pr_url: 'https://github.com/org/repo/pull/42', cost_usd: 0.47, duration_s: 272 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(msg.text).toContain('completed');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain('$0.47');
    expect(text).toContain('4m 32s');
    // PR link is in the button, not inline text (avoids Slack unfurl cards)
    const actions = actionsBlock(msg.blocks[1]);
    const button = actions.elements[0];
    expect(button.text.text).toContain('#42');
    if (!('url' in button)) throw new Error('expected link button with url');
    expect(button.url).toBe('https://github.com/org/repo/pull/42');
  });

  test('renders task_failed message with error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType, error_message: 'Repo not found' };
    const msg = renderSlackBlocks('task_failed', task);
    expect(msg.text).toContain('failed');
    expect(sectionText(msg.blocks[0])).toContain('Repo not found');
  });

  test('renders task_failed message with metadata error', () => {
    const task = { ...baseTask, status: TaskStatus.FAILED as TaskStatusType };
    const msg = renderSlackBlocks('task_failed', task, { error: 'timeout' });
    expect(sectionText(msg.blocks[0])).toContain('timeout');
  });

  test('renders task_cancelled message', () => {
    const msg = renderSlackBlocks('task_cancelled', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':no_entry_sign:');
  });

  test('renders task_timed_out message with duration', () => {
    const task = { ...baseTask, duration_s: 28800 };
    const msg = renderSlackBlocks('task_timed_out', task);
    expect(sectionText(msg.blocks[0])).toContain('8h');
  });

  test('renders session_started message', () => {
    const msg = renderSlackBlocks('session_started', baseTask);
    expect(sectionText(msg.blocks[0])).toContain(':hourglass_flowing_sand:');
  });

  test('renders unknown event type gracefully', () => {
    const msg = renderSlackBlocks('hydration_complete', baseTask);
    expect(sectionText(msg.blocks[0])).toContain('hydration_complete');
  });

  test('truncates long descriptions', () => {
    const task = { ...baseTask, task_description: 'A'.repeat(300) };
    const msg = renderSlackBlocks('task_created', task);
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(350);
    expect(text).toContain('...');
  });

  test('formats duration in hours', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 3661 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('1h 1m');
  });

  test('formats duration in minutes and seconds', () => {
    const task = { ...baseTask, status: TaskStatus.COMPLETED as TaskStatusType, duration_s: 125 };
    const msg = renderSlackBlocks('task_completed', task);
    expect(sectionText(msg.blocks[0])).toContain('2m 5s');
  });

  // -------------------------------------------------------------------
  // PR #79 test gap #32 — task_stranded + agent_error renderers
  // -------------------------------------------------------------------

  test('renders task_stranded message with prior_status from event metadata', () => {
    // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
    // ``prior_status`` on the event metadata (see
    // reconcile-stranded-tasks.ts). The renderer must surface
    // prior_status so operators can tell whether the task hung in
    // HYDRATING vs RUNNING at a glance — without it, the reviewer's
    // "generic Event: ..." UX regression would resurface.
    const msg = renderSlackBlocks('task_stranded', baseTask, {
      code: 'STRANDED_NO_HEARTBEAT',
      prior_status: 'RUNNING',
      age_seconds: 1800,
    });
    expect(msg.text).toBe('Task stranded for org/repo');
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).toContain('org/repo');
    expect(text).toContain('last status: RUNNING');
  });

  test('renders task_stranded message gracefully without metadata', () => {
    // Missing prior_status (e.g. legacy event written before the
    // reconciler started stamping it) must not crash; the renderer
    // omits the parenthetical and produces a clean message.
    const msg = renderSlackBlocks('task_stranded', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':warning:');
    expect(text).toContain('Task stranded');
    expect(text).not.toContain('last status:');
  });

  test('renders agent_error message with error_type and message_preview', () => {
    // ``agent/src/progress_writer.py::write_agent_error`` carries
    // ``error_type`` and ``message_preview`` on the event metadata.
    // Pre-PR-#79 this fell to the default branch
    // (``Event: agent_error for org/repo``) — a UX regression.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'TimeoutError',
      message_preview: 'Tool call timed out after 30s',
    });
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).toContain('org/repo');
    expect(text).toContain('TimeoutError');
    expect(text).toContain('Tool call timed out after 30s');
  });

  test('renders agent_error message without metadata (legacy event shape)', () => {
    // Defense-in-depth: an agent_error event with no metadata at all
    // must still produce a sensible Slack message. The error_type and
    // preview fields drop out cleanly without leaking ``undefined``.
    const msg = renderSlackBlocks('agent_error', baseTask);
    const text = sectionText(msg.blocks[0]);
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('Agent error');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('_Type:_');
  });

  test('agent_error truncates long message_preview to keep Slack message readable', () => {
    // The preview cap is 200 chars — protects channel UX from a
    // pathological agent that emits a 4 KB error message.
    const msg = renderSlackBlocks('agent_error', baseTask, {
      error_type: 'BigError',
      message_preview: 'X'.repeat(500),
    });
    const text = sectionText(msg.blocks[0]);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain('...');
  });
  test.each([
    ['included', '3', 'false', 'Thread history: 3 message(s) included.'],
    ['included', '20', 'true', 'Thread history: 20 message(s) included (truncated).'],
    ['disabled', '0', 'false', 'Thread history: off for this request.'],
    ['none', '0', 'false', 'Thread history: no earlier messages.'],
  ])('task acknowledgement exposes %s context status', (status, count, truncated, expected) => {
    const msg = renderSlackBlocks('task_created', { ...baseTask, channel_metadata: { slack_history_status: status, slack_history_count: count, slack_history_truncated: truncated } });
    expect(sectionText(msg.blocks[0])).toContain(expected);
  });

  test('history acknowledgement previews the current request rather than the context wrapper', () => {
    const msg = renderSlackBlocks('task_created', { ...baseTask, task_description: 'Earlier untrusted history', channel_metadata: { slack_history_status: 'included', slack_history_count: '2', slack_request_preview: 'Fix the latest login bug' } });
    expect(sectionText(msg.blocks[0])).toContain('Fix the latest login bug');
    expect(sectionText(msg.blocks[0])).not.toContain('Earlier untrusted history');
  });
  test.each(['new', 'reused'])('acknowledges the %s session identity', mode => {
    const msg = renderSlackBlocks('task_created', { ...baseTask, development_session_id: '01M666YYHRAB6SE77VS1SFKMFK', channel_metadata: { slack_session_mode: mode } });
    expect(sectionText(msg.blocks[0])).toContain(`Session: \`01M666YYHRAB6SE77VS1SFKMFK\` (${mode})`);
  });
  test.each(['new', 'reused'])('acknowledges %s PR workflow identity', mode => {
    const msg = renderSlackBlocks('task_created', { ...baseTask, pr_number: mode === 'reused' ? 15 : undefined, channel_metadata: { slack_workflow_mode: 'pr', slack_session_mode: mode } });
    expect(sectionText(msg.blocks[0])).toContain(`Workflow: PR (${mode})`);
    if (mode === 'reused') expect(sectionText(msg.blocks[0])).toContain('PR #15');
  });
});
