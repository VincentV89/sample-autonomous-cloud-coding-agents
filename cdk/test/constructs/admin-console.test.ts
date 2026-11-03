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
import { Template } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { AdminConsole } from '../../src/constructs/admin-console';

let template: Template;
beforeAll(() => {
  const stack = new Stack(new App(), 'ConsoleTest');
  const api = new apigw.RestApi(stack, 'Api');
  const pool = new cognito.UserPool(stack, 'Pool');
  const table = new dynamodb.Table(stack, 'Table', { partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING } });
  new AdminConsole(stack, 'Console', { api, userPool: pool, taskTable: table, repoTable: table, slackInstallations: table, slackChannels: table, jiraWorkspaces: table, jiraProjects: table });
  template = Template.fromStack(stack);
});
test('assets are private and accessed through OAC', () => {
  template.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
});
test('browser client is public and authorization-code only', () => {
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false, AllowedOAuthFlows: ['code'], AllowedOAuthScopes: ['openid', 'email'] });
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'console-admins' });
});
test('console operations are Cognito protected with no console test-invoke grants', () => {
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as { Properties: { HttpMethod: string; AuthorizationType: string } }[];
  for (const method of methods.filter(m => m.Properties.HttpMethod !== 'OPTIONS')) expect(method.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
  expect(JSON.stringify(template.findResources('AWS::Lambda::Permission'))).not.toContain('test-invoke-stage');
});
test('admin handler cannot retrieve secrets or execute CLI commands', () => {
  const functions = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { Handler: string; Environment?: { Variables: Record<string, string> } } }[];
  const handler = functions.find(f => f.Properties.Environment?.Variables.REPO_TABLE_NAME);
  expect(handler).toBeDefined();
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).not.toContain('secretsmanager:GetSecretValue');
  expect(policies).not.toContain('ssm:SendCommand');
});
test('authenticated API traffic is never cached', () => {
  const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: { CacheBehaviors: { PathPattern: string; CachePolicyId: string; AllowedMethods: string[] }[] } } };
  const api = distribution.Properties.DistributionConfig.CacheBehaviors.find(b => b.PathPattern === 'api/*');
  expect(api?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  expect(api?.AllowedMethods).toContain('POST');
});
