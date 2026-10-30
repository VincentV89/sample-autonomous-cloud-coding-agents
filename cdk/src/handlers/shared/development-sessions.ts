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

import { DynamoDBDocumentClient, GetCommand, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { CreateTaskRequest, TaskRecord } from './types';

export class DevelopmentAdmissionError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Keep refs out of option syntax and Git's revision-expression grammar.
export function validProductionBranch(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
    && !value.split('/').some(p => p.startsWith('.') || p.endsWith('.lock') || p.endsWith('.'));
}

type DevelopmentTask = {
  sessionId: string;
  branch: string;
  productionBranch: string;
  isNew: boolean;
  metadata: Record<string, string>;
  advance?: NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']>;
};
type SessionRoot = TaskRecord & { development_latest_task_id?: string };

/** The first task anchors a session. Its CAS pointer serializes iterations without a new table or index. */
export async function prepareDevelopmentTask(
  ddb: DynamoDBDocumentClient, table: string, body: CreateTaskRequest,
  userId: string, taskId: string, workflowId: string,
): Promise<DevelopmentTask | undefined> {
  if (body.development_action === undefined) {
    if (body.development_session_id !== undefined || body.production_branch !== undefined) {
      throw new DevelopmentAdmissionError(400, 'A development_action is required with development session options.');
    }
    return undefined;
  }
  if (!['develop', 'promote'].includes(body.development_action)
    || workflowId !== 'coding/new-task-v1' || !body.repo || body.pr_number !== undefined) {
    throw new DevelopmentAdmissionError(400, 'Development actions require a repository and coding/new-task-v1, without pr_number.');
  }
  if (body.production_branch !== undefined && !validProductionBranch(body.production_branch)) {
    throw new DevelopmentAdmissionError(400, 'Invalid production_branch. Supply a Git branch name.');
  }
  let sessionId = taskId;
  let productionBranch = body.production_branch ?? 'main';
  let expectedSha = '';
  let advance: DevelopmentTask['advance'];
  const isNew = body.development_session_id === undefined;
  if (isNew && body.development_action === 'promote') {
    throw new DevelopmentAdmissionError(400, 'Promotion requires development_session_id.');
  }
  if (!isNew) {
    sessionId = body.development_session_id!;
    if (typeof sessionId !== 'string') throw new DevelopmentAdmissionError(400, 'Invalid development_session_id.');
    if (!SESSION_ID.test(sessionId)) throw new DevelopmentAdmissionError(400, 'Invalid development_session_id.');
    const rootResult = await ddb.send(new GetCommand({
      TableName: table, Key: { task_id: sessionId }, ConsistentRead: true,
    }));
    const root = rootResult.Item as SessionRoot | undefined;
    // Deliberately identical response for absent and inaccessible sessions.
    if (!root || root.user_id !== userId || root.repo !== body.repo
      || root.development_session_id !== sessionId || !root.development_latest_task_id) {
      throw new DevelopmentAdmissionError(404, 'Development session not found for this user and repository.');
    }
    if (!root.production_branch || !validProductionBranch(root.production_branch)) {
      throw new DevelopmentAdmissionError(409, 'The saved production branch is invalid. Start a new session.');
    }
    productionBranch = root.production_branch;
    if (body.production_branch && body.production_branch !== productionBranch) {
      throw new DevelopmentAdmissionError(400, 'The production branch is fixed when the session starts.');
    }
    const latest = root.development_latest_task_id === sessionId ? root :
      (await ddb.send(new GetCommand({
        TableName: table, Key: { task_id: root.development_latest_task_id }, ConsistentRead: true,
      }))).Item as TaskRecord | undefined;
    if (!latest || !TERMINAL.has(latest.status)) {
      throw new DevelopmentAdmissionError(409, 'A development task is still active. Wait for it to finish or cancel it.');
    }
    if (latest.development_action === 'promote' && latest.pr_url) {
      throw new DevelopmentAdmissionError(409, `This session was promoted: ${latest.pr_url}. Start a new development session.`);
    }
    // Once promotion starts the branch is frozen, including retries after partial failures.
    if (root.channel_metadata?.development_frozen === 'true' && body.development_action !== 'promote') {
      throw new DevelopmentAdmissionError(409, 'This session is frozen for promotion. Start a new development session.');
    }
    expectedSha = latest.head_sha ?? latest.channel_metadata?.development_expected_sha ?? '';
    if (body.development_action === 'promote' && !expectedSha) {
      throw new DevelopmentAdmissionError(409, 'No verified remote development commit is available to promote.');
    }
    advance = {
      TableName: table,
      Key: { task_id: sessionId },
      UpdateExpression: 'SET development_latest_task_id = :next' + (body.development_action === 'promote' ? ', channel_metadata.development_frozen = :frozen' : ''),
      ConditionExpression: 'development_latest_task_id = :previous AND user_id = :owner',
      ExpressionAttributeValues: {
        ':next': taskId,
        ':previous': root.development_latest_task_id,
        ':owner': userId,
        ...(body.development_action === 'promote' && { ':frozen': 'true' }),
      },
    };
  }
  return {
    sessionId,
    productionBranch,
    isNew,
    advance,
    branch: `bgagent/development/${sessionId}`,
    metadata: {
      development_session_id: sessionId,
      development_action: body.development_action,
      development_expected_sha: expectedSha,
      development_production_branch: productionBranch,
    },
  };
}
