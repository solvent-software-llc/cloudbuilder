import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export class GithubOidc extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const provider = new iam.CfnOIDCProvider(this, "GitHubOIDCProvider", {
            url: "https://token.actions.githubusercontent.com",
            clientIdList: ["sts.amazonaws.com"],
            thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
        });
        provider.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
        provider.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
        new cdk.CfnOutput(this, "OIDCProviderArn", {
            value: provider.ref,
            exportName: "github-actions-oidc-provider-arn",
        });
    }
}
