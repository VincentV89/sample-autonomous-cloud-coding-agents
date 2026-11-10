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

import { intentBranch } from './intent-workspace';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REPOSITORY_CONTEXT_LENGTH = 8_000;

interface GitRef {
  object: { sha: string };
}

interface GitCommit {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

class GitHubIntentError extends Error {
  constructor(readonly status: number) {
    super(`GitHub returned HTTP ${status} for the intent operation`);
  }
}

export class IntentGitHub {
  private readonly url: string;

  constructor(repo: string, private readonly token: string) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)
      || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid repository');
    this.url = `https://api.github.com/repos/${repo}`;
  }

  private async request<T>(route: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(this.url + route, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new GitHubIntentError(response.status);
    return await response.json() as T;
  }

  async base(): Promise<{ branch: string; commit: string }> {
    const { default_branch: branch } = await this.request<{ default_branch: string }>('');
    const { sha: commit } = await this.request<GitCommit>(`/commits/${encodeURIComponent(branch)}`);
    return { branch, commit };
  }

  async readme(commit: string): Promise<string> {
    try {
      const file = await this.request<{ content: string; encoding: string }>(`/readme?ref=${commit}`);
      return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8').slice(0, MAX_REPOSITORY_CONTEXT_LENGTH) : '';
    } catch (error) {
      if (error instanceof GitHubIntentError && error.status === 404) return '';
      throw error;
    }
  }

  async checkpoint(input: {
    id: string; parent: string; path: string; markdown: string; operation: string;
  }): Promise<string> {
    const branch = intentBranch(input.id);
    const refPath = `/git/ref/heads/${branch}`;
    const message = `Record intent checkpoint ${input.operation}`;
    let current: GitRef;
    try {
      current = await this.request<GitRef>(refPath);
    } catch (error) {
      if (!(error instanceof GitHubIntentError) || error.status !== 404) throw error;
      try {
        current = await this.request<GitRef>('/git/refs', 'POST', {
          ref: `refs/heads/${branch}`, sha: input.parent,
        });
      } catch (createError) {
        if (!(createError instanceof GitHubIntentError) || createError.status !== 422) throw createError;
        current = await this.request<GitRef>(refPath);
      }
    }
    if (current.object.sha !== input.parent) {
      const previous = await this.request<GitCommit>(`/git/commits/${current.object.sha}`);
      if (previous.message === message && previous.parents.length === 1 && previous.parents[0].sha === input.parent) {
        const file = await this.request<{ content: string; encoding: string }>(
          `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${previous.sha}`,
        );
        if (file.encoding === 'base64' && Buffer.from(file.content, 'base64').toString('utf8') === input.markdown) {
          return previous.sha;
        }
      }
      throw new Error('The planning branch changed outside this operation.');
    }
    const parent = await this.request<GitCommit>(`/git/commits/${input.parent}`);
    const tree = await this.request<{ sha: string }>('/git/trees', 'POST', {
      base_tree: parent.tree.sha,
      tree: [{ path: input.path, mode: '100644', type: 'blob', content: input.markdown }],
    });
    const commit = await this.request<GitCommit>('/git/commits', 'POST', {
      message, tree: tree.sha, parents: [input.parent],
    });
    await this.request<GitRef>(`/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
    return commit.sha;
  }
}
