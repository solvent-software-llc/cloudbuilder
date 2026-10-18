import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Config, Environment } from "./config";

export interface ApiProps extends cdk.StackProps {
    config: Config;
    apiConfig: NonNullable<Config["api"]>;
    environment: Environment;
    api: NonNullable<Environment["api"]>;
    // Directory containing the compiled `bootstrap` binary, built by the API
    // deploy workflow. Undefined outside a real deploy (cdk ls, synthesizing
    // other stacks) — see the placeholder handling below.
    buildDir?: string;
}

const PLACEHOLDER_DIR = path.join(__dirname, "..", "assets", "api-placeholder");

// One stack per environment: a Go Lambda behind an HTTP API on its own
// hostname, api.<environment domain>. The site stacks know nothing about it.
// CORS is deliberately NOT configured on the HTTP API — API Gateway's CORS
// applies to every route, and mobile routes must stay off the allow-list — so
// the function handles CORS itself from ALLOWED_ORIGINS. See
// docs/v2-redesign.md, Decisions 2 and 3.
export class Api extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ApiProps) {
        super(scope, id, props);

        const { config, apiConfig, environment, api, buildDir } = props;
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config.aws.hostedZoneId,
            zoneName: config.domain,
        });

        let codeDir = PLACEHOLDER_DIR;
        if (buildDir) {
            if (!fs.existsSync(path.join(buildDir, "bootstrap"))) {
                throw new Error(`API_BUILD_DIR "${buildDir}" has no bootstrap binary`);
            }
            codeDir = buildDir;
        } else {
            // An error annotation fails `cdk deploy`/`cdk synth` of this stack
            // only, so the rest of the app still synthesizes without a build.
            cdk.Annotations.of(this).addError(
                "API_BUILD_DIR is not set, so this stack has no Lambda code to deploy",
            );
        }

        // Exact origins only (no wildcard): the site serves the same hostnames
        // as this environment, plus www for production. Domains always match
        // between the site and API repos' client.yaml.
        const siteHosts =
            config.www && !environment.subdomain
                ? [environment.domain, `www.${environment.domain}`]
                : [environment.domain];

        // Secrets reach the function as parameter NAMES; it reads the values at
        // runtime through the Parameters and Secrets extension, so they never
        // appear in this template or the Lambda console.
        const secretParamEnv = Object.fromEntries(
            Object.entries(api.secrets).map(([key, name]) => [`${key}_PARAM`, name]),
        );

        const logGroup = new logs.LogGroup(this, "FunctionLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const fn = new lambda.Function(this, "Function", {
            description: `${config.slug} ${environment.name} API`,
            runtime: lambda.Runtime.PROVIDED_AL2023,
            architecture:
                apiConfig.architecture === "arm64"
                    ? lambda.Architecture.ARM_64
                    : lambda.Architecture.X86_64,
            // provided.* runtimes ignore the handler; the binary is `bootstrap`.
            handler: "bootstrap",
            code: lambda.Code.fromAsset(codeDir),
            memorySize: apiConfig.memoryMb,
            timeout: cdk.Duration.seconds(apiConfig.timeoutSeconds),
            logGroup,
            environment: {
                ...api.env,
                ...secretParamEnv,
                ALLOWED_ORIGINS: siteHosts.map((host) => `https://${host}`).join(","),
                ENVIRONMENT: environment.name,
                API_DOMAIN: api.domain,
            },
            paramsAndSecrets: lambda.ParamsAndSecretsLayerVersion.fromVersion(
                lambda.ParamsAndSecretsVersions.V1_0_103,
                { parameterStoreTtl: cdk.Duration.minutes(5) },
            ),
        });

        // SecureStrings encrypted with the AWS-managed aws/ssm key need no
        // kms:Decrypt grant: that key's policy already allows decryption via
        // SSM for any principal in the account allowed to call GetParameter.
        const parameterNames = [...new Set(Object.values(api.secrets))];
        if (parameterNames.length > 0) {
            fn.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: ["ssm:GetParameter"],
                    // Names are validated as hierarchical (leading "/"), so the
                    // ARN is just parameter<name>.
                    resources: parameterNames.map(
                        (name) =>
                            `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`,
                    ),
                }),
            );
        }

        // Regional cert: an HTTP API custom domain needs its cert in the API's
        // own region (us-east-1 here anyway; see CLAUDE.md).
        const certificate = new acm.Certificate(this, "ApiCertificate", {
            domainName: api.domain,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        const domainName = new apigwv2.DomainName(this, "ApiDomain", {
            domainName: api.domain,
            certificate,
        });

        // One $default route: the Go app does its own routing (including
        // answering CORS preflights), so API Gateway just proxies everything.
        const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
            apiName: `${api.stackName}`,
            description: `${config.slug} ${environment.name} API`,
            defaultIntegration: new HttpLambdaIntegration("FunctionIntegration", fn),
            defaultDomainMapping: { domainName },
            // Only api.<domain> should reach the function, not the
            // auto-generated execute-api URL.
            disableExecuteApiEndpoint: true,
        });

        const dnsTarget = route53.RecordTarget.fromAlias(
            new targets.ApiGatewayv2DomainProperties(
                domainName.regionalDomainName,
                domainName.regionalHostedZoneId,
            ),
        );
        new route53.ARecord(this, "ApiRecord", {
            zone,
            recordName: api.domain,
            target: dnsTarget,
        });
        new route53.AaaaRecord(this, "ApiRecordIpv6", {
            zone,
            recordName: api.domain,
            target: dnsTarget,
        });

        new cdk.CfnOutput(this, "ApiUrl", { value: `https://${api.domain}` });
        new cdk.CfnOutput(this, "FunctionName", { value: fn.functionName });
        new cdk.CfnOutput(this, "HttpApiId", { value: httpApi.apiId });
    }
}
