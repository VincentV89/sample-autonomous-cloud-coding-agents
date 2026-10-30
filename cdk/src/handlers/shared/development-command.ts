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

import type { CreateTaskRequest } from './types';

/** Explicit, deterministic Slack grammar. Ordinary task prose retains its existing behavior. */
export function parseDevelopmentCommand(text: string): Pick<CreateTaskRequest, 'development_action' | 'development_session_id' | 'task_description'> {
  const promote = /^promote\s+([0-9A-HJKMNP-TV-Z]{26})\s*$/i.exec(text.trim());
  if (promote) return { development_action: 'promote', development_session_id: promote[1].toUpperCase() };
  const develop = /^develop\s+(?:([0-9A-HJKMNP-TV-Z]{26})\s+)?([\s\S]+)$/i.exec(text.trim());
  if (develop) return { development_action: 'develop', ...(develop[1] && { development_session_id: develop[1].toUpperCase() }), task_description: develop[2] };
  return { task_description: text || undefined };
}
