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

import { createHash } from 'node:crypto';

const MAX_SLUG_LENGTH = 44;
const INVOCATION_HASH_LENGTH = 16;
export const MAX_INTENT_TEXT_LENGTH = 2_000;

export const AIDLC_REVISION = 'ab95815fa00647fe611c746619a6f34e385ca62c';
export const INTENT_STAGES = ['intent-capture', 'requirements', 'acceptance'] as const;
export type IntentStage = typeof INTENT_STAGES[number];
export type IntentRole = 'owner' | 'contributor' | 'reviewer';

export interface IntentQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly assignee?: string;
  readonly answer?: { readonly value: string; readonly by: string; readonly deferred: boolean };
}

export interface IntentCheckpoint {
  readonly stage: IntentStage;
  readonly commit: string;
  readonly path: string;
  readonly markdown: string;
}

export interface PublishedIntent {
  readonly version: number;
  readonly commit: string;
  readonly path: string;
  readonly markdown: string;
}

export interface IntentWorkspace {
  readonly id: string;
  readonly repo: string;
  readonly idea: string;
  readonly owner: string;
  readonly members: Readonly<Record<string, Exclude<IntentRole, 'owner'>>>;
  readonly revision: number;
  readonly baseCommit: string;
  readonly productionBranch?: string;
  readonly headCommit?: string;
  readonly lastOperation?: string;
  readonly checkpoints: readonly IntentCheckpoint[];
  readonly questions: Readonly<Partial<Record<IntentStage, readonly IntentQuestion[]>>>;
  readonly versions: readonly PublishedIntent[];
  readonly comments?: readonly { readonly user: string; readonly value: string }[];
  readonly pending?: {
    readonly operation: string;
    readonly stage?: IntentStage;
    readonly version: number;
    readonly parent: string;
    readonly path: string;
    readonly markdown: string;
  };
}

export function intentRole(intent: IntentWorkspace, user: string): IntentRole | undefined {
  if (user === intent.owner) return 'owner';
  return Object.hasOwn(intent.members, user) ? intent.members[user] : undefined;
}

export function intentBranch(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error('Invalid intent ID');
  return `bgagent/intents/${id}`;
}

export function intentId(idea: string, invocation: string): string {
  const slug = idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_SLUG_LENGTH);
  const suffix = createHash('sha256').update(invocation).digest('hex').slice(0, INVOCATION_HASH_LENGTH);
  return `${slug || 'intent'}-${suffix}`;
}

export function activeIntentStage(intent: IntentWorkspace): IntentStage | undefined {
  return INTENT_STAGES.find(stage => !intent.checkpoints.some(checkpoint => checkpoint.stage === stage));
}

export function answerIntentQuestion(
  intent: IntentWorkspace, user: string, questionId: string, value: string, deferred: boolean,
): IntentWorkspace {
  if (intent.pending) throw new Error('An approval or publication is in progress');
  const role = intentRole(intent, user);
  if (role !== 'owner' && role !== 'contributor') throw new Error('Contributor permission required');
  const stage = activeIntentStage(intent);
  if (!stage) throw new Error('All stages are approved');
  const questions = intent.questions[stage] ?? [];
  const question = questions.find(candidate => candidate.id === questionId);
  if (!question) throw new Error('Question is outside the active stage');
  if (role !== 'owner' && question.assignee && question.assignee !== user) throw new Error('Question is assigned to someone else');
  const answer = value.trim();
  if ((!deferred && !answer) || answer.length > MAX_INTENT_TEXT_LENGTH) throw new Error('Answer must contain 1 to 2,000 characters');
  return {
    ...intent,
    revision: intent.revision + 1,
    questions: {
      ...intent.questions,
      [stage]: questions.map(candidate => candidate.id === questionId
        ? { ...candidate, answer: { value: answer, by: user, deferred } }
        : candidate),
    },
  };
}

export function checkpointReady(intent: IntentWorkspace, user: string): IntentStage {
  if (intentRole(intent, user) !== 'owner') throw new Error('Owner approval required');
  const stage = activeIntentStage(intent);
  if (!stage) throw new Error('All stages are approved');
  const questions = intent.questions[stage] ?? [];
  if (!questions.length || questions.some(question => !question.answer)) throw new Error('Answer or defer each question before approval');
  return stage;
}

function plainText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
}

export function renderIntentCheckpoint(intent: IntentWorkspace, user: string): string {
  const stage = checkpointReady(intent, user);
  const decisions = (intent.questions[stage] ?? []).map(question => [
    `- **${plainText(question.prompt)}**`,
    question.answer!.deferred
      ? `  - Deferred${question.answer!.value ? `: ${plainText(question.answer!.value)}` : ''}`
      : `  - ${plainText(question.answer!.value)}`,
  ].join('\n'));
  return [`# ${stage}`, '', ...decisions, ''].join('\n');
}

export function renderPublishedIntent(intent: IntentWorkspace, user: string): string {
  if (intentRole(intent, user) !== 'owner') throw new Error('Owner approval required');
  if (activeIntentStage(intent)) throw new Error('Approve all stages before publishing');
  return [
    '# Approved intent',
    '',
    plainText(intent.idea),
    '',
    `Repository: ${intent.repo}`,
    `Base commit: ${intent.baseCommit}`,
    `AI-DLC workflow revision: ${AIDLC_REVISION}`,
    '',
    ...intent.checkpoints.map(checkpoint => checkpoint.markdown.replace(/^# /, '## ')),
  ].join('\n');
}
