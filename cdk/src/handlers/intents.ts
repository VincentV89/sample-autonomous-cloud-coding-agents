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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { resolveGitHubToken } from './shared/context-hydration';
import { extractUserId } from './shared/gateway';
import { IntentGitHub } from './shared/intent-github';
import { generateIntentQuestions } from './shared/intent-interview';
import { publishIntentArtifact } from './shared/intent-publication';
import { IntentConflictError, IntentStore } from './shared/intent-store';
import {
  activeIntentStage, answerIntentQuestion, intentId, intentRole, renderPublishedIntent,
  type IntentWorkspace, MAX_INTENT_TEXT_LENGTH,
} from './shared/intent-workspace';
import { logger } from './shared/logger';
import { lookupRepo } from './shared/repo-config';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { makeDocClient } from './shared/ua';
import { isValidRepo } from './shared/validation';

const store = new IntentStore(makeDocClient(), process.env.INTENT_TABLE_NAME!);
const MAX_MUTATION_BYTES = 6_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const USER_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

type CreateIntent = { operation: 'create'; user: string; repo: string; idea: string; invocation: string };
type ResolveIntent = { operation: 'resolve'; user: string; reference: string };

async function github(repo: string): Promise<IntentGitHub> {
  return new IntentGitHub(repo, await resolveGitHubToken(process.env.GITHUB_TOKEN_SECRET_ARN!));
}

async function internal(event: CreateIntent | ResolveIntent) {
  if (!USER_PATTERN.test(event.user)) return { error: 'Link your Slack account first.' };
  if (event.operation === 'resolve') {
    const match = /^([a-z0-9][a-z0-9-]{0,80})@v([1-9][0-9]{0,5})$/.exec(event.reference);
    const intent = match && await store.get(match[1]);
    const version = intent && ['owner', 'contributor'].includes(intentRole(intent, event.user) ?? '')
      ? intent.versions.find(item => item.version === Number(match[2])) : undefined;
    if (!intent || !version) return { error: 'Published intent not found.' };
    return { repo: intent.repo, commit: version.commit, path: version.path, productionBranch: intent.productionBranch };
  }
  const idea = event.idea.trim();
  if (!isValidRepo(event.repo) || !idea || idea.length > MAX_INTENT_TEXT_LENGTH) return { error: 'Use /plan owner/repo followed by a brief idea.' };
  if (!(await lookupRepo(event.repo)).onboarded) return { error: 'Register this repository with a Blueprint before planning.' };
  const id = intentId(idea, JSON.stringify([event.user, event.invocation]));
  const existing = await store.get(id);
  if (existing) {
    return existing.owner === event.user && existing.repo === event.repo
      ? { id } : { error: 'Unable to create intent.' };
  }
  const git = await github(event.repo);
  const { branch, commit } = await git.base();
  const intent: IntentWorkspace = {
    id,
    repo: event.repo,
    idea,
    owner: event.user,
    members: {},
    revision: 0,
    baseCommit: commit,
    productionBranch: branch,
    checkpoints: [],
    questions: {},
    versions: [],
  };
  try {
    await store.save(intent);
  } catch (error) {
    if (!(error instanceof IntentConflictError)) throw error;
    const replay = await store.get(id);
    if (!replay || replay.owner !== event.user || replay.repo !== event.repo) throw error;
  }
  return { id };
}

interface IntentMutation {
  readonly action: string;
  readonly revision: number;
  readonly question?: string;
  readonly value?: string;
  readonly deferred?: boolean;
  readonly user?: string;
  readonly role?: 'contributor' | 'reviewer';
}

async function mutate(intent: IntentWorkspace, user: string, body: IntentMutation): Promise<IntentWorkspace> {
  const role = intentRole(intent, user);
  if (body.action === 'checkpoint' || body.action === 'publish') {
    if (role !== 'owner') throw new Error('Owner approval required');
    if (!(await lookupRepo(intent.repo)).onboarded) throw new Error('Repository is no longer onboarded');
    if (body.action === 'publish' && intent.versions.length && intent.versions.at(-1)?.commit === intent.headCommit) {
      return intent;
    }
    return publishIntentArtifact(store, await github(intent.repo), intent, user, body.revision, body.action);
  }
  if (intent.pending || body.revision !== intent.revision) throw new IntentConflictError();
  let next: IntentWorkspace = { ...intent, revision: intent.revision + 1 };
  const stage = activeIntentStage(intent);
  switch (body.action) {
    case 'answer':
      if (typeof body.question !== 'string' || typeof body.value !== 'string' || typeof body.deferred !== 'boolean') {
        throw new Error('Invalid answer');
      }
      next = answerIntentQuestion(intent, user, body.question, body.value, body.deferred);
      break;
    case 'comment': {
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      if (!role || !value || value.length > MAX_INTENT_TEXT_LENGTH) throw new Error('Enter a comment up to 2,000 characters');
      next = { ...next, comments: [...(intent.comments ?? []), { user, value }] };
      break;
    }
    case 'member':
      if (role !== 'owner' || typeof body.user !== 'string' || !USER_PATTERN.test(body.user) || body.user === intent.owner
        || (body.role !== 'contributor' && body.role !== 'reviewer')) throw new Error('Enter a valid member and role');
      next = { ...next, members: { ...intent.members, [body.user]: body.role } };
      break;
    case 'remove-member': {
      if (role !== 'owner' || typeof body.user !== 'string' || !Object.hasOwn(intent.members, body.user)) {
        throw new Error('Select a current member');
      }
      const members = { ...intent.members };
      delete members[body.user];
      const questions = { ...intent.questions };
      if (stage) {
        questions[stage] = questions[stage]?.map(question => question.assignee === body.user
          ? { ...question, assignee: undefined } : question);
      }
      next = { ...next, members, questions };
      break;
    }
    case 'assign': {
      const questions = stage ? intent.questions[stage] ?? [] : [];
      if (role !== 'owner' || !stage || typeof body.user !== 'string'
        || (body.user && !['owner', 'contributor'].includes(intentRole(intent, body.user) ?? ''))
        || !questions.some(question => question.id === body.question)) throw new Error('Invalid assignment');
      next = {
        ...next,
        questions: {
          ...intent.questions,
          [stage]: questions.map(question => question.id === body.question
            ? { ...question, assignee: body.user || undefined } : question),
        },
      };
      break;
    }
    case 'questions':
      if (role !== 'owner' || !stage || intent.questions[stage]?.length) throw new Error('This stage does not need questions');
      if (!(await lookupRepo(intent.repo)).onboarded) throw new Error('Repository is no longer onboarded');
      next = {
        ...next,
        questions: {
          ...intent.questions,
          [stage]: await generateIntentQuestions(
            stage, intent, await (await github(intent.repo)).readme(intent.baseCommit),
          ),
        },
      };
      break;
    case 'revise':
      if (role !== 'owner' || !intent.versions.length || stage) throw new Error('Publish this plan before starting another revision');
      next = { ...next, checkpoints: [], questions: {} };
      break;
    default:
      throw new Error('Unknown intent action');
  }
  await store.save(next, intent.revision);
  return next;
}

export async function handler(event: APIGatewayProxyEvent | CreateIntent | ResolveIntent): Promise<unknown> {
  if (!('requestContext' in event)) {
    try {
      return await internal(event);
    } catch (error) {
      logger.error('Internal intent request failed', { errorType: error instanceof Error ? error.name : 'Unknown' });
      return { error: 'Unable to open the intent. Check repository access and retry.' };
    }
  }
  const requestId = ulid();
  const user = extractUserId(event);
  if (!user) return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
  const id = event.pathParameters?.id;
  if (!id || !ID_PATTERN.test(id)) return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Intent not found.', requestId);
  try {
    const intent = await store.get(id);
    const role = intent && intentRole(intent, user);
    if (!intent || !role) return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Intent not found.', requestId);
    if (event.httpMethod === 'GET') return view(intent, user, requestId);
    if (event.httpMethod !== 'POST' || !event.body || Buffer.byteLength(event.body) > MAX_MUTATION_BYTES) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid intent request.', requestId);
    }
    const body = JSON.parse(event.body) as IntentMutation;
    if (!body || !Number.isSafeInteger(body.revision)) throw new Error('A workspace revision is required');
    return view(await mutate(intent, user, body), user, requestId);
  } catch (error) {
    if (error instanceof IntentConflictError) return errorResponse(409, ErrorCode.VALIDATION_ERROR, error.message, requestId);
    logger.warn('Intent request failed', { requestId, errorType: error instanceof Error ? error.name : 'Unknown' });
    return errorResponse(400, ErrorCode.VALIDATION_ERROR,
      error instanceof Error && error.constructor === Error ? error.message : 'Unable to complete the intent request.', requestId);
  }
}

function view(intent: IntentWorkspace, user: string, requestId: string): APIGatewayProxyResult {
  const { pending, lastOperation: _lastOperation, ...visible } = intent;
  const stage = activeIntentStage(intent);
  return successResponse(200, {
    ...visible,
    currentUser: user,
    role: intentRole(intent, user),
    stage,
    draftMarkdown: !stage ? renderPublishedIntent(intent, intent.owner) : undefined,
    pendingAction: pending && intent.owner === user
      ? { action: pending.stage ? 'checkpoint' : 'publish', revision: intent.revision - 1 } : undefined,
  }, requestId);
}
