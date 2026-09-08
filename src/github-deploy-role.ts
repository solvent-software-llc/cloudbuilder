import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Config } from "./config";

export interface GithubDeployRoleProps extends cdk.StackProps {
    config: Config;
    githubOrg: string;
    repoName: string;
}

export class GithubDeployRole extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GithubDeployRoleProps) {
        super(scope, id, props);

        const { config, githubOrg, repoName } = props;
        // The trust policy must allow exactly the branches client.yaml actually
        // deploys from — kept in sync with environments[] rather than a
        // hardcoded guess, so a new environment's branch is trusted the moment
        // it's added to client.yaml.
        const branches = config.environments.map((e) => e.branch);

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
                                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
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
                            {
                                // cdk deploy's standard, fully-supported call path: assume
                                // the CDK bootstrap deploy-role for CloudFormation calls
                                // (CreateChangeSet, ExecuteChangeSet, ...) and the
                                // file-publishing-role to upload the synthesized
                                // template/assets, rather than calling those services
                                // directly as this role. The direct-credentials fallback
                                // (used when assumption isn't permitted) was found to
                                // silently report "no changes" for a genuine changeset —
                                // CloudFormation created and described it correctly, but cdk
                                // never called ExecuteChangeSet. Both bootstrap roles trust
                                // the whole account already (Principal: root in their own
                                // trust policy), so granting this doesn't widen the actual
                                // security boundary: cfn-exec-role (assumed via
                                // PassCfnExecRole below) already runs every real
                                // create/update with AdministratorAccess account-wide
                                // regardless of which identity calls CloudFormation — see
                                // "The deploy role's IAM scoping is weaker than it looks" in
                                // CLAUDE.md.
                                Sid: "AssumeCdkBootstrapRoles",
                                Effect: "Allow",
                                Action: ["sts:AssumeRole", "sts:TagSession"],
                                Resource: [
                                    `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
                                    `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
                                ],
                            },
                            {
                                // Kept as a fallback read in case bootstrap-role assumption
                                // above ever fails for some reason — cdk falls back to using
                                // this role's own credentials directly, and would need this.
                                Sid: "CdkBootstrapVersion",
                                Effect: "Allow",
                                Action: ["ssm:GetParameter"],
                                Resource: `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*/version`,
                            },
                            {
                                // Same fallback as above, for uploading the synthesized
                                // template/assets directly if file-publishing-role
                                // assumption ever fails. Bucket name follows CDK's default
                                // bootstrap naming (qualifier "hnb659fds"); update this if
                                // the target account/region was ever bootstrapped with a
                                // custom --qualifier.
                                Sid: "CdkAssetPublishing",
                                Effect: "Allow",
                                Action: [
                                    "s3:GetBucketLocation",
                                    "s3:ListBucket",
                                    "s3:GetObject",
                                    "s3:PutObject",
                                ],
                                Resource: [
                                    `arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}`,
                                    `arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`,
                                ],
                            },
                            {
                                // CloudFormation doesn't execute a changeset as the caller —
                                // it assumes the bootstrap's cfn-exec-role, which carries
                                // AdministratorAccess by default. This PassRole is what makes
                                // that possible, which means every Sid above this point stops
                                // being the real security boundary for anything cdk deploy
                                // creates/updates (they still gate this role's own direct API
                                // calls, e.g. this workflow's S3 sync / CloudFront invalidate
                                // steps, just not stack deployment itself). The actual
                                // boundary is now "which repo/branch can assume this role at
                                // all" — enforced by the trust policy's sub claim above. See
                                // CLAUDE.md for the narrower-but-unbuilt alternative (a custom
                                // --cloudformation-execution-policies bootstrap).
                                Sid: "PassCfnExecRole",
                                Effect: "Allow",
                                Action: ["iam:PassRole"],
                                Resource: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
                            },
                        ],
                    },
                },
            ],
        });

        new cdk.CfnOutput(this, "RoleArn", { value: role.attrArn });
    }
}
