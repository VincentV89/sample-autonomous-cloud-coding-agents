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

import { type IntentGitHub } from './intent-github';
import { type IntentStore, IntentConflictError } from './intent-store';
import {
  checkpointReady, renderIntentCheckpoint, renderPublishedIntent,
  type IntentWorkspace,
} from './intent-workspace';

type PublicationAction = 'checkpoint' | 'publish';

/**
 * Reserve the immutable input before touching GitHub. A retried request
 * continues the same operation and recovers a commit made before a timeout.
 */
export async function publishIntentArtifact(
  store: IntentStore,
  github: IntentGitHub,
  workspace: IntentWorkspace,
  user: string,
  revision: number,
  action: PublicationAction,
): Promise<IntentWorkspace> {
  if (workspace.owner !== user) throw new Error('Owner approval required');
  const operation = `${workspace.id}-${revision}-${action}`;
  if (workspace.lastOperation === operation) return workspace;
  let reserved = workspace;
  if (workspace.pending?.operation !== operation) {
    if (workspace.pending || workspace.revision !== revision) throw new IntentConflictError();
    const version = workspace.versions.length + 1;
    const stage = action === 'checkpoint' ? checkpointReady(workspace, user) : undefined;
    const markdown = stage ? renderIntentCheckpoint(workspace, user) : renderPublishedIntent(workspace, user);
    reserved = {
      ...workspace,
      revision: revision + 1,
      pending: {
        operation,
        stage,
        version,
        markdown,
        parent: workspace.headCommit ?? workspace.baseCommit,
        path: `aidlc/intents/${workspace.id}/v${version}/${stage ?? 'intent'}.md`,
      },
    };
    await store.save(reserved, revision);
  }
  const pending = reserved.pending!;
  const commit = await github.checkpoint({ ...pending, id: reserved.id });
  const { pending: _pending, ...rest } = reserved;
  const artifact = { commit, path: pending.path, markdown: pending.markdown };
  const complete: IntentWorkspace = {
    ...rest,
    revision: reserved.revision + 1,
    headCommit: commit,
    lastOperation: operation,
    checkpoints: pending.stage
      ? [...reserved.checkpoints, { ...artifact, stage: pending.stage }]
      : reserved.checkpoints,
    versions: pending.stage
      ? reserved.versions
      : [...reserved.versions, { ...artifact, version: pending.version }],
  };
  await store.save(complete, reserved.revision);
  return complete;
}
