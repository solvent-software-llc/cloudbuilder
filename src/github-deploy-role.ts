import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Config } from "./config";

export interface GithubDeployRoleProps extends cdk.StackProps {
    config: Config;
    githubOrg: string;
    repoName: string;
    branches?: string[];
}

export class GithubDeployRole extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GithubDeployRoleProps) {
        super(scope, id, props);

        const { config, githubOrg, repoName } = props;
        const branches = props.branches ?? ["main", "dev"];

        // GitHub appends `@<immutable-id>` to the org and/or repo name in the sub
        // claim once either has ever been renamed (anti repo-jacking measure), so
        // both the plain and @id-suffixed forms must be accepted.
        const subs = branches.flatMap((branch) => [
            `repo:${githubOrg}/${repoName}:ref:refs/heads/${branch}`,
            `repo:${githubOrg}@*/${repoName}@*:ref:refs/heads/${branch}`,
        ]);

        // The OIDC provider (github-oidc-bootstrap / src/oidc.ts) is a single,
        // account-wide IAM resource — IAM has no concept of region. Its ARN is
        // fully deterministic from the account id and provider URL, so it's
        // built directly here rather than via Fn::ImportValue: CloudFormation
        // exports are region-scoped, and this stack's region need not match
        // whatever region github-oidc-bootstrap happened to be deployed in.
        const oidcProviderArn = cdk.Arn.format(
            {
                service: "iam",
                region: "",
                account: this.account,
                resource: "oidc-provider",
                resourceName: "token.actions.githubusercontent.com",
            },
            this,
        );

        const role = new iam.CfnRole(this, "DeployRole", {
            roleName: `github-deploy-${config.slug}-${repoName}`,
            assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Principal: {
                            Federated: oidcProviderArn,
                        },
                        Action: "sts:AssumeRoleWithWebIdentity",
                        Condition: {
                            StringEquals: {
                                "token.actions.githubusercontent.com:aud":
                                    "sts.amazonaws.com",
                            },
                            StringLike: {
                                "token.actions.githubusercontent.com:sub": subs,
                            },
                        },
                    },
                ],
            },
            policies: [
                {
                    policyName: "site-deploy",
                    policyDocument: {
                        Version: "2012-10-17",
                        Statement: [
                            {
                                Sid: "CloudFormation",
                                Effect: "Allow",
                                Action: [
                                    "cloudformation:CreateStack",
                                    "cloudformation:UpdateStack",
                                    "cloudformation:DescribeStacks",
                                    "cloudformation:DescribeStackEvents",
                                    "cloudformation:CreateChangeSet",
                                    "cloudformation:DescribeChangeSet",
                                    "cloudformation:ExecuteChangeSet",
                                    "cloudformation:DeleteChangeSet",
                                    "cloudformation:GetTemplate",
                                    "cloudformation:GetTemplateSummary",
                                    "cloudformation:ListStackResources",
                                ],
                                Resource: `arn:aws:cloudformation:*:${this.account}:stack/${config.aws.stackName}/*`,
                            },
                            {
                                Sid: "S3Site",
                                Effect: "Allow",
                                Action: [
                                    "s3:CreateBucket",
                                    "s3:GetBucketPolicy",
                                    "s3:PutBucketPolicy",
                                    "s3:PutBucketVersioning",
                                    "s3:GetBucketVersioning",
                                    "s3:PutBucketPublicAccessBlock",
                                    "s3:GetBucketPublicAccessBlock",
                                    "s3:PutLifecycleConfiguration",
                                    "s3:GetLifecycleConfiguration",
                                    "s3:PutBucketTagging",
                                    "s3:GetBucketTagging",
                                    "s3:GetBucketLocation",
                                    "s3:ListBucket",
                                    "s3:ListBucketVersions",
                                    "s3:PutObject",
                                    "s3:GetObject",
                                    "s3:DeleteObject",
                                ],
                                Resource: [
                                    `arn:aws:s3:::${config.aws.bucketName}`,
                                    `arn:aws:s3:::${config.aws.bucketName}/*`,
                                ],
                            },
                            {
                                // Most CloudFront actions do not support resource-level
                                // IAM permissions, so this cannot be scoped to a single
                                // distribution.
                                Sid: "CloudFront",
                                Effect: "Allow",
                                Action: [
                                    "cloudfront:CreateDistribution",
                                    "cloudfront:GetDistribution",
                                    "cloudfront:UpdateDistribution",
                                    "cloudfront:DeleteDistribution",
                                    "cloudfront:TagResource",
                                    "cloudfront:ListTagsForResource",
                                    "cloudfront:CreateOriginAccessControl",
                                    "cloudfront:GetOriginAccessControl",
                                    "cloudfront:UpdateOriginAccessControl",
                                    "cloudfront:DeleteOriginAccessControl",
                                    "cloudfront:GetResponseHeadersPolicy",
                                    "cloudfront:CreateInvalidation",
                                    "cloudfront:GetInvalidation",
                                    "cloudfront:GetFunction",
                                    "cloudfront:CreateFunction",
                                    "cloudfront:DescribeFunction",
                                    "cloudfront:UpdateFunction",
                                    "cloudfront:PublishFunction",
                                    "cloudfront:DeleteFunction",
                                ],
                                Resource: "*",
                            },
                            {
                                // acm:RequestCertificate has no ARN yet at request time,
                                // so this cannot be scoped tighter than account-wide.
                                Sid: "ACM",
                                Effect: "Allow",
                                Action: [
                                    "acm:RequestCertificate",
                                    "acm:DescribeCertificate",
                                    "acm:AddTagsToCertificate",
                                    "acm:ListTagsForCertificate",
                                    "acm:DeleteCertificate",
                                ],
                                Resource: "*",
                            },
                            {
                                Sid: "Route53",
                                Effect: "Allow",
                                Action: [
                                    "route53:GetHostedZone",
                                    "route53:ChangeResourceRecordSets",
                                    "route53:ListResourceRecordSets",
                                ],
                                Resource: `arn:aws:route53:::hostedzone/${config.aws.hostedZoneId}`,
                            },
                            {
                                // GetChange targets a change ID, not a hosted zone, so
                                // it has no resource to scope to.
                                Sid: "Route53Change",
                                Effect: "Allow",
                                Action: ["route53:GetChange"],
                                Resource: "*",
                            },
                        ],
                    },
                },
            ],
        });

        new cdk.CfnOutput(this, "RoleArn", { value: role.attrArn });
    }
}
