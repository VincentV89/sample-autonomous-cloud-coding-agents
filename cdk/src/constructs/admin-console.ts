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

import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const HSTS_DAYS = 365;
const DOMAIN_SUFFIX_LENGTH = 12;
const HANDLER_TIMEOUT_SECONDS = 30;

export interface AdminConsoleProps {
  readonly api: apigw.RestApi;
  readonly userPool: cognito.UserPool;
  readonly taskTable: dynamodb.ITable;
  readonly repoTable: dynamodb.ITable;
  readonly slackInstallations: dynamodb.ITable;
  readonly slackChannels: dynamodb.ITable;
  readonly jiraWorkspaces: dynamodb.ITable;
  readonly jiraProjects: dynamodb.ITable;
}

/** Optional browser console. Tokens are forwarded only to the existing API. */
export class AdminConsole extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AdminConsoleProps) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Assets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const stack = Stack.of(this);
    const rewrite = new cloudfront.Function(this, 'ApiPath', {
      code: cloudfront.FunctionCode.fromInline("function handler(event) { var request = event.request; request.uri = request.uri.substring(4) || '/'; return request; }"),
    });
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(HSTS_DAYS), override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.amazoncognito.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
          override: true,
        },
      },
    });
    // Read the configured name, rather than Ref(Stage), so the API deployment
    // can depend on the console origin for CORS without a dependency cycle.
    const stage = props.api.deploymentStage.node.defaultChild as apigw.CfnStage;
    if (!stage.stageName) throw new Error('Admin console requires a named API stage.');
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(`${props.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`, {
            originPath: `/${stage.stageName}`,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: rewrite }],
        },
      },
    });
    const origin = `https://${this.distribution.distributionDomainName}`;
    const url = `${origin}/`;
    const domain = props.userPool.addDomain('ConsoleDomain', {
      cognitoDomain: { domainPrefix: `abca-console-${stack.account}-${this.node.addr.slice(0, DOMAIN_SUFFIX_LENGTH)}` },
    });
    const client = props.userPool.addClient('ConsoleClient', {
      generateSecret: false,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [url],
        logoutUrls: [url],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });
    new cognito.CfnUserPoolGroup(this, 'Administrators', { userPoolId: props.userPool.userPoolId, groupName: 'console-admins', description: 'Repository and integration administrators for the platform console' });
    const fn = new NodejsFunction(this, 'Handler', {
      entry: path.join(__dirname, '../handlers/admin-console.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(HANDLER_TIMEOUT_SECONDS),
      environment: {
        CONSOLE_ORIGIN: origin,
        TASK_TABLE_NAME: props.taskTable.tableName,
        REPO_TABLE_NAME: props.repoTable.tableName,
        SLACK_INSTALLATION_TABLE_NAME: props.slackInstallations.tableName,
        SLACK_CHANNEL_TABLE_NAME: props.slackChannels.tableName,
        JIRA_WORKSPACE_TABLE_NAME: props.jiraWorkspaces.tableName,
        JIRA_PROJECT_TABLE_NAME: props.jiraProjects.tableName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [props.taskTable.tableArn] }));
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [props.repoTable, props.slackInstallations, props.slackChannels, props.jiraWorkspaces, props.jiraProjects].map(t => t.tableArn) }));
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [props.repoTable.tableArn] }));
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', { cognitoUserPools: [props.userPool] });
    const resource = props.api.root.addResource('console', {
      defaultCorsPreflightOptions: {
        allowOrigins: [origin],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    }).addResource('{resource}');
    for (const method of ['GET', 'POST']) {
      resource.addMethod(method, new apigw.LambdaIntegration(fn, { allowTestInvoke: false }), {
        authorizer, authorizationType: apigw.AuthorizationType.COGNITO,
      });
    }
    new deploy.BucketDeployment(this, 'Publish', {
      destinationBucket: this.bucket,
      sources: [deploy.Source.asset(path.join(__dirname, '../../console')), deploy.Source.jsonData('config.json', { clientId: client.userPoolClientId, authDomain: domain.baseUrl(), redirectUri: url })],
      distribution: this.distribution,
      distributionPaths: ['/*'],
      cacheControl: [deploy.CacheControl.noStore()],
    });
    // BucketDeployment's framework-owned singleton lives at stack scope.
    for (const child of stack.node.children) {
      if (!child.node.id.startsWith('Custom::CDKBucketDeployment')) continue;
      NagSuppressions.addResourceSuppressions(child, [
        { id: 'AwsSolutions-IAM4', reason: 'CDK asset deployment uses the framework basic Lambda logging policy.' },
        { id: 'AwsSolutions-IAM5', reason: 'CDK asset deployment needs generated asset/destination object grants and CloudFront invalidation permissions.' },
        { id: 'AwsSolutions-L1', reason: 'CDK owns the asset deployment singleton runtime.' },
      ], true);
    }
    new CfnOutput(this, 'Url', { value: url, description: 'Authenticated platform admin console' });
    NagSuppressions.addResourceSuppressions(this.bucket, [{ id: 'AwsSolutions-S1', reason: 'Console assets contain no credentials or user data; origin is private and OAC restricted.' }]);
    NagSuppressions.addResourceSuppressions(this.distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'Operators may access the console globally; Cognito protects API data.' },
      { id: 'AwsSolutions-CFR2', reason: 'API requests use the existing regional API WAF; static assets contain no user data.' },
      { id: 'AwsSolutions-CFR3', reason: 'Static access logging is not enabled; API operations have existing access logs and actor audit logs.' },
      { id: 'AwsSolutions-CFR4', reason: 'CloudFront default domain certificate is used for the operator console.' },
      { id: 'AwsSolutions-CFR7', reason: 'Origin Access Control is used instead of legacy OAI.' },
    ]);
    NagSuppressions.addResourceSuppressions(fn, [{ id: 'AwsSolutions-IAM4', reason: 'Lambda basic execution managed policy writes operational logs.' }], true);
  }
}
