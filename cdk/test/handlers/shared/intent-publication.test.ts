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

import type { IntentGitHub } from '../../../src/handlers/shared/intent-github';
import { publishIntentArtifact } from '../../../src/handlers/shared/intent-publication';
import type { IntentStore } from '../../../src/handlers/shared/intent-store';
import type { IntentWorkspace } from '../../../src/handlers/shared/intent-workspace';

test('a GitHub failure leaves a resumable approval with immutable content', async () => {
  let current: IntentWorkspace = {
    id: 'conference',
    repo: 'org/repo',
    owner: 'owner',
    idea: 'Registration',
    members: {},
    revision: 0,
    baseCommit: 'a'.repeat(40),
    checkpoints: [],
    versions: [],
    questions: {
      'intent-capture': [{
        id: 'audience',
        prompt: 'Who can register?',
        options: [],
        answer: { value: 'Members', by: 'owner', deferred: false },
      }],
    },
  };
  const save = jest.fn(async (value: IntentWorkspace, prior: number) => {
    expect(prior).toBe(current.revision);
    current = value;
  });
  const checkpoint = jest.fn().mockRejectedValueOnce(new Error('GitHub unavailable')).mockResolvedValue('b'.repeat(40));
  const store = { save } as unknown as IntentStore;
  const git = { checkpoint } as unknown as IntentGitHub;
  await expect(publishIntentArtifact(store, git, current, 'owner', 0, 'checkpoint')).rejects.toThrow('unavailable');
  expect(current.pending?.markdown).toContain('Members');
  expect(current.checkpoints).toEqual([]);
  const completed = await publishIntentArtifact(store, git, current, 'owner', 0, 'checkpoint');
  expect(checkpoint.mock.calls[1][0]).toEqual(checkpoint.mock.calls[0][0]);
  expect(completed.pending).toBeUndefined();
  expect(completed.checkpoints[0]).toMatchObject({ commit: 'b'.repeat(40), stage: 'intent-capture' });
  await expect(publishIntentArtifact(store, git, completed, 'owner', 0, 'checkpoint')).resolves.toBe(completed);
  expect(checkpoint).toHaveBeenCalledTimes(2);
});
