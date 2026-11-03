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

import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId, userInGroup } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, paginatedResponse, successResponse } from './shared/response';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const ADMIN_GROUP = 'console-admins';
const MAX_CURSOR_LENGTH = 4096;
const MAX_BODY_BYTES = 2048;
const METHOD_NOT_ALLOWED = 405;
const DATASETS: Record<string, { env: string; fields: string[] }> = {
  repos: { env: 'REPO_TABLE_NAME', fields: ['repo', 'status', 'onboarded_at', 'updated_at', 'compute_type', 'model_id', 'max_turns'] },
  slack_workspaces: { env: 'SLACK_INSTALLATION_TABLE_NAME', fields: ['team_id', 'team_name', 'status', 'scope', 'updated_at'] },
  slack_channels: { env: 'SLACK_CHANNEL_TABLE_NAME', fields: ['channel_identity', 'channel_id', 'team_id', 'repo', 'status'] },
  jira_workspaces: { env: 'JIRA_WORKSPACE_TABLE_NAME', fields: ['jira_cloud_id', 'site_url', 'status', 'updated_at'] },
  jira_projects: { env: 'JIRA_PROJECT_TABLE_NAME', fields: ['jira_project_identity', 'cloud_id', 'project_key', 'repo', 'label_filter', 'status'] },
};
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

/** Bounded, dataset-bound cursor; callers cannot inject DynamoDB expressions. */
function cursor(raw: string | undefined, dataset: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (raw.length > MAX_CURSOR_LENGTH) throw new Error('Invalid pagination token.');
  const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (value.dataset !== dataset || !value.key || typeof value.key !== 'object' || Array.isArray(value.key)) {
    throw new Error('Invalid pagination token.');
  }
  return value.key;
}

/** Explicit allowlist: no secret references, pending link codes, or credential fields. */
export function projectRow(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(k => item[k] !== undefined).map(k => [k, item[k]]));
}

async function handleRequest(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  const userId = extractUserId(event);
  if (!userId) return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
  const admin = userInGroup(event, ADMIN_GROUP);
  const resource = event.pathParameters?.resource ?? 'session';
  if (resource === 'session' && event.httpMethod === 'GET') {
    return successResponse(200, { user_id: userId, administrator: admin }, requestId);
  }
  // Owner-only supplementary data that existing task detail deliberately omits.
  if (resource === 'task-context' && event.httpMethod === 'GET') {
    const taskId = event.queryStringParameters?.task_id;
    if (!taskId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(taskId)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid task ID.', requestId);
    }
    try {
      const result = await ddb.send(new GetCommand({ TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: taskId } }));
      if (!result.Item || result.Item.user_id !== userId) {
        return errorResponse(404, ErrorCode.TASK_NOT_FOUND, 'Task not found.', requestId);
      }
      const item = result.Item;
      const metadata = item.channel_metadata ?? {};
      const slack = { team_id: metadata.slack_team_id, channel_id: metadata.slack_channel_id, thread_ts: metadata.slack_thread_ts };
      const jira = { site_url: metadata.jira_site_url, issue_key: metadata.jira_issue_key };
      return successResponse(200, {
        answer_text: typeof item.answer_text === 'string' ? item.answer_text : null,
        slack: projectRow(slack, ['team_id', 'channel_id', 'thread_ts']),
        jira: projectRow(jira, ['site_url', 'issue_key', 'issue_url']),
      }, requestId);
    } catch (err) {
      logger.error('Console task context failed', { request_id: requestId, error: String(err) });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Unable to read task context.', requestId);
    }
  }
  if (!admin) return errorResponse(403, ErrorCode.FORBIDDEN, 'Administrator permission required.', requestId);
  const config = DATASETS[resource];
  if (!config) return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Unknown console resource.', requestId);
  const table = process.env[config.env];
  if (!table) return errorResponse(503, ErrorCode.INTERNAL_ERROR, 'Integration is not configured.', requestId);
  if (event.httpMethod === 'POST' && resource === 'repos') {
    let body: { repo?: unknown };
    try {
      if (!event.body || Buffer.byteLength(event.body) > MAX_BODY_BYTES) throw new Error();
      body = JSON.parse(event.body);
      if (!body || Array.isArray(body) || Object.keys(body).some(k => k !== 'repo')
        || typeof body.repo !== 'string' || !REPO_PATTERN.test(body.repo)
        || body.repo.split('/')[1] === '.' || body.repo.split('/')[1] === '..') throw new Error();
    } catch {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Provide only a valid owner/repo.', requestId);
    }
    try {
      const now = new Date().toISOString();
      const result = await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { repo: body.repo },
        UpdateExpression: 'SET #status = :active, onboarded_at = if_not_exists(onboarded_at, :now), updated_at = :now REMOVE #ttl',
        ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':active': 'active', ':now': now },
        ReturnValues: 'ALL_NEW',
      }));
      logger.info('Console repository onboarded', { user_id: userId, repo: body.repo, request_id: requestId });
      return successResponse(200, projectRow(result.Attributes ?? {}, config.fields), requestId);
    } catch (err) {
      logger.error('Console repository onboarding failed', { request_id: requestId, error: String(err) });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Repository registration failed.', requestId);
    }
  }
  if (event.httpMethod !== 'GET') return errorResponse(METHOD_NOT_ALLOWED, ErrorCode.VALIDATION_ERROR, 'Method not supported.', requestId);
  let startKey: Record<string, unknown> | undefined;
  try { startKey = cursor(event.queryStringParameters?.next_token, resource); } catch {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid pagination token.', requestId);
  }
  try {
    const names = Object.fromEntries(config.fields.map((field, i) => [`#f${i}`, field]));
    const result = await ddb.send(new ScanCommand({
      TableName: table,
      Limit: 50,
      ExclusiveStartKey: startKey,
      ProjectionExpression: Object.keys(names).join(', '),
      ExpressionAttributeNames: names,
    }));
    const next = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify({ dataset: resource, key: result.LastEvaluatedKey })).toString('base64url') : null;
    return paginatedResponse((result.Items ?? []).map(item => projectRow(item, config.fields)), next, requestId);
  } catch (err) {
    logger.error('Console resource read failed', { resource, request_id: requestId, error: String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Unable to load console data.', requestId);
  }
}

/** Restrict browser access to the console origin while retaining API response envelopes. */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const response = await handleRequest(event);
  response.headers = {
    ...response.headers,
    'Access-Control-Allow-Origin': process.env.CONSOLE_ORIGIN ?? 'null',
    'Vary': 'Origin',
  };
  return response;
}
