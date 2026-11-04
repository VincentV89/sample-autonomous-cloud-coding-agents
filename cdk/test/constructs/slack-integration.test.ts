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

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { SlackIntegration } from '../../src/constructs/slack-integration';

describe('SlackIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    new SlackIntegration(stack, 'SlackIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates three Slack DynamoDB tables (installation + user mapping + channel mapping)', () => {
    // TaskTable + TaskEventsTable + SlackInstallation + SlackUserMapping + SlackChannelMapping = 5
    template.resourceCountIs('AWS::DynamoDB::Table', 5);
  });

  test('command processor receives the channel-mapping table env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          SLACK_CHANNEL_MAPPING_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('omitted attachment bucket adds no storage configuration or S3 permissions', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.Environment?.Variables?.ATTACHMENTS_BUCKET_NAME).toBeUndefined();
    }
    const policies = template.findResources('AWS::IAM::Policy');
    expect(JSON.stringify(policies)).not.toContain('s3:');
  });

  test('creates 6 Lambda functions', () => {
    // oauth-callback, events, commands, command-processor, link, interactions
    // (outbound notify runs on FanOutConsumer as a dispatcher, not its own fn)
    template.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test('creates API Gateway resources under /slack', () => {
    // Verify /slack/* routes exist
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'slack',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'commands',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'events',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'link',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'interactions',
    });
  });

  test('slash command handler has 3-second timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 3,
      Environment: {
        Variables: Match.objectLike({
          SLACK_SIGNING_SECRET_ARN: Match.anyValue(),
          SLACK_COMMAND_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('construct no longer owns a TaskEventsTable stream consumer', () => {
    // This construct used to own ``SlackNotifyFn`` plus its
    // own ``DynamoEventSource`` on ``TaskEventsTable``. Outbound Slack
    // delivery now runs through ``FanOutConsumer`` as a per-channel
    // dispatcher so ``TaskEventsTable`` stays within the DynamoDB
    // one-reader-per-shard practical limit. The assertion pins that the
    // migration did not regress: this construct must not create any
    // ``AWS::Lambda::EventSourceMapping`` at all.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('creates 3 Secrets Manager secrets for Slack App credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('signing secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client ID'),
    });
  });

  test('OAuth callback has Secrets Manager permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:CreateSecret',
            Effect: 'Allow',
            Condition: {
              StringLike: { 'secretsmanager:Name': 'bgagent/slack/*' },
            },
          }),
        ]),
      },
    });
  });
});

describe('SlackIntegration attachment storage', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'AttachmentsTestStack');
    new SlackIntegration(stack, 'SlackIntegration', {
      api: new apigw.RestApi(stack, 'Api'),
      userPool: new cognito.UserPool(stack, 'UserPool'),
      taskTable: new dynamodb.Table(stack, 'Tasks', {
        partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      }),
      taskEventsTable: new dynamodb.Table(stack, 'Events', {
        partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
        stream: dynamodb.StreamViewType.NEW_IMAGE,
      }),
      attachmentsBucket: s3.Bucket.fromBucketName(stack, 'Attachments', 'task-attachments'),
    });
    template = Template.fromStack(stack);
  });

  test('only the command processor receives the attachment bucket', () => {
    const configured = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([, fn]) => fn.Properties.Environment?.Variables?.ATTACHMENTS_BUCKET_NAME);
    expect(configured).toHaveLength(1);
    expect(configured[0][0]).toContain('CommandProcessorFn');
    expect(configured[0][1].Properties.Environment.Variables.ATTACHMENTS_BUCKET_NAME).toBe('task-attachments');
  });

  test('only the command processor can put and delete attachment-prefix objects', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const processor = Object.entries(functions).find(([id]) => id.includes('CommandProcessorFn'))![1];
    const roleId = processor.Properties.Role['Fn::GetAtt'][0];
    const s3Policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(policy => JSON.stringify(policy.Properties.PolicyDocument).includes('s3:'));
    expect(s3Policies).toHaveLength(1);
    expect(s3Policies[0].Properties.Roles).toEqual([{ Ref: roleId }]);
    const statements = s3Policies[0].Properties.PolicyDocument.Statement
      .filter((statement: { Action: unknown }) => JSON.stringify(statement.Action).includes('s3:'));
    expect(statements).toEqual([{
      Effect: 'Allow',
      Action: ['s3:PutObject', 's3:DeleteObject'],
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::task-attachments/attachments/*']] },
    }]);
  });
});
