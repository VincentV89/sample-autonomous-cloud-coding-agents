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

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

let template: Template;
beforeAll(() => {
  const app = new App({ context: { enableBrowserTesting: true } });
  const stack = new AgentStack(app, 'BrowserTestingStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  template = Template.fromStack(stack);
});
test('only the opted-in runtime receives the feature environment flag', () => {
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({ ABCA_BROWSER_ENABLED: 'true' }),
  });
});
test('runtime lifecycle permissions target the regional AWS managed browser ARN', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const entry = Object.entries(policies).find(([id]) => id.startsWith('RuntimeExecutionRoleDefaultPolicy'));
  expect(entry).toBeDefined();
  const statements = entry![1].Properties.PolicyDocument.Statement;
  const lifecycle = statements.find((s: { Action?: string[] }) => s.Action?.includes('bedrock-agentcore:StartBrowserSession'));
  expect(lifecycle.Action).toEqual(['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession']);
  expect(JSON.stringify(lifecycle.Resource)).toContain(':aws:browser/aws.browser.v1');
  expect(lifecycle.Resource).not.toBe('*');
  const stream = statements.find((s: { Action?: string }) => s.Action === 'bedrock-agentcore:ConnectBrowserAutomationStream');
  expect(stream.Resource).toBe('*');
});
test('tenant session roles do not inherit browser service privileges', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const tenantPolicies = Object.entries(policies).filter(([id]) => id.startsWith('AgentSessionRole'));
  expect(tenantPolicies.length).toBeGreaterThan(0);
  expect(JSON.stringify(tenantPolicies)).not.toContain('StartBrowserSession');
  expect(JSON.stringify(tenantPolicies)).not.toContain('ConnectBrowserAutomationStream');
});
