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

import {
  activeIntentStage,
  answerIntentQuestion,
  checkpointReady,
  intentBranch,
  intentId,
  intentRole,
  renderIntentCheckpoint,
  renderPublishedIntent,
  type IntentWorkspace,
} from '../../../src/handlers/shared/intent-workspace';

const workspace: IntentWorkspace = {
  id: 'example-4ae4716',
  repo: 'org/example',
  idea: 'Registration app',
  owner: 'owner',
  members: { contributor: 'contributor', reviewer: 'reviewer' },
  revision: 0,
  baseCommit: 'a'.repeat(40),
  checkpoints: [],
  questions: { 'intent-capture': [{ id: 'scope', prompt: 'Who can register?', options: [] }] },
  versions: [],
};

test('a retry uses the same planning branch while independent invocations get separate branches', () => {
  const id = intentId(workspace.idea, 'invocation-one');
  expect(intentBranch(id)).toBe(intentBranch(intentId(workspace.idea, 'invocation-one')));
  expect(intentId(workspace.idea, 'invocation-two')).not.toBe(id);
  expect(() => intentBranch('../main')).toThrow('Invalid intent ID');
});

test('membership is independent of administrator access and rejects inherited object keys', () => {
  expect(intentRole(workspace, 'contributor')).toBe('contributor');
  expect(intentRole(workspace, 'admin')).toBeUndefined();
  expect(intentRole(workspace, 'constructor')).toBeUndefined();
  expect(() => answerIntentQuestion(workspace, 'reviewer', 'scope', 'Anyone', false)).toThrow('Contributor');
});

test('a contributor can answer but only the owner can approve an answered stage', () => {
  expect(() => checkpointReady(workspace, 'owner')).toThrow('Answer or defer');
  const answered = answerIntentQuestion(workspace, 'contributor', 'scope', 'Anyone', false);
  expect(answered.revision).toBe(1);
  expect(() => checkpointReady(answered, 'contributor')).toThrow('Owner approval');
  expect(renderIntentCheckpoint(answered, 'owner')).toContain('Anyone');
});

test('publication uses approved snapshots rather than working answers', () => {
  expect(() => renderPublishedIntent(workspace, 'owner')).toThrow('Approve all stages');
  const approved: IntentWorkspace = {
    ...workspace,
    checkpoints: [
      { stage: 'intent-capture', commit: 'a', path: 'a.md', markdown: '# Intent capture\nApproved scope.' },
      { stage: 'requirements', commit: 'b', path: 'b.md', markdown: '# Requirements\nApproved requirements.' },
      { stage: 'acceptance', commit: 'c', path: 'c.md', markdown: '# Acceptance\nApproved checks.' },
    ],
  };
  expect(activeIntentStage(approved)).toBeUndefined();
  expect(renderPublishedIntent(approved, 'owner')).toContain('## Intent capture\nApproved scope.');
  expect(renderPublishedIntent(approved, 'owner')).not.toContain('Who can register?');
});
