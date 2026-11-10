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

import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type IntentWorkspace } from './intent-workspace';

const MAX_WORKSPACE_BYTES = 300_000;

export class IntentConflictError extends Error {
  constructor() {
    super('This intent changed. Reload it before trying again.');
  }
}

export class IntentStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(id: string): Promise<IntentWorkspace | undefined> {
    const { Item } = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { id },
      ConsistentRead: true,
    }));
    return Item as IntentWorkspace | undefined;
  }

  async save(workspace: IntentWorkspace, previousRevision?: number): Promise<void> {
    if (workspace.revision !== (previousRevision ?? -1) + 1) {
      throw new Error('Invalid intent revision transition');
    }
    // Keep headroom for DynamoDB's item encoding and future edits. Returning
    // a controlled failure is preferable to silently dropping a prior version.
    const encoded = JSON.stringify(workspace);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_WORKSPACE_BYTES) {
      throw new Error('This intent reached its storage limit.');
    }
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: JSON.parse(encoded) as Record<string, unknown>,
        ConditionExpression: previousRevision === undefined
          ? 'attribute_not_exists(id)' : '#revision = :previous',
        ...(previousRevision === undefined ? {} : {
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':previous': previousRevision },
        }),
      }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        throw new IntentConflictError();
      }
      throw error;
    }
  }
}
