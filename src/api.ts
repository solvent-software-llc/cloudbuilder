import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as triggers from "aws-cdk-lib/triggers";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Config, DatabaseParameter, Environment } from "./config";
import { APP_USER, DATABASE_NAME } from "./database";
import { emailIdentityArn } from "./email";

export interface ApiProps extends cdk.StackProps {
    config: Config;
    apiConfig: NonNullable<Config["api"]>;
    environment: Environment;
    api: NonNullable<Environment["api"]>;
    // Directory containing the compiled `bootstrap` binary, built by the API
    // deploy workflow. Undefined outside a real deploy (cdk ls, synthesizing
    // other stacks) — see the placeholder handling below.
    buildDir?: string;
    // Same, for the migration binary when api.migrate is set.
    migrateBuildDir?: string;
    // The environment's database stack's SSM parameters, read by the API
    // deploy workflow (API_DATABASE_PARAMETERS). Undefined outside a real
    // deploy, handled like a missing buildDir.
    databaseParameters?: Record<DatabaseParameter, string>;
    // Whether the $default route targets the maintenance function. The deploy
    // workflow reads the live route and passes its state through, so a deploy
    // never turns maintenance on or off — only api-maintenance.yml does.
    maintenance: boolean;
}

const PLACEHOLDER_DIR = path.join(__dirname, "..", "assets", "api-placeholder");
const MAINTENANCE_DIR = path.join(__dirname, "..", "assets", "api-maintenance");

// One stack per environment: a Go Lambda behind an HTTP API on its own
// hostname, api.<environment domain>. The site stacks know nothing about it.
// CORS is deliberately NOT configured on the HTTP API — API Gateway's CORS
// applies to every route, and mobile routes must stay off the allow-list — so
// the function handles CORS itself from ALLOWED_ORIGINS. See
// docs/v2-redesign.md, Decisions 2 and 3.
export class Api extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ApiProps) {
        super(scope, id, props);

        const {
            config,
            apiConfig,
            environment,
            api,
            buildDir,
            migrateBuildDir,
            databaseParameters,
            maintenance,
        } = props;
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config.aws.hostedZoneId,
            zoneName: config.domain,
        });

        const codeDir = (dir: string | undefined, envVar: string) => {
            if (!dir) {
                // An error annotation fails `cdk deploy`/`cdk synth` of this stack
                // only, so the rest of the app still synthesizes without a build.
                cdk.Annotations.of(this).addError(
                    `${envVar} is not set, so this stack has no Lambda code to deploy`,
                );
                return PLACEHOLDER_DIR;
            }
            if (!fs.existsSync(path.join(dir, "bootstrap"))) {
                throw new Error(`${envVar} "${dir}" has no bootstrap binary`);
            }
            return dir;
        };
        const architecture =
            apiConfig.architecture === "arm64"
                ? lambda.Architecture.ARM_64
                : lambda.Architecture.X86_64;
        const paramsAndSecrets = lambda.ParamsAndSecretsLayerVersion.fromVersion(
            lambda.ParamsAndSecretsVersions.V1_0_103,
            { parameterStoreTtl: cdk.Duration.minutes(5) },
        );

        // Exact origins only (no wildcard): the site serves the same hostnames
        // as this environment, plus www for production. Domains always match
        // between the site and API repos' client.yaml.
        const siteHosts =
            config.www && !environment.subdomain
                ? [environment.domain, `www.${environment.domain}`]
                : [environment.domain];
        const allowedOrigins = siteHosts.map((host) => `https://${host}`).join(",");

        // Secrets reach the function as parameter NAMES; it reads the values at
        // runtime through the Parameters and Secrets extension, so they never
        // appear in this template or the Lambda console.
        const secretParamEnv = Object.fromEntries(
            Object.entries(api.secrets).map(([key, name]) => [`${key}_PARAM`, name]),
        );

        // The environment's database (docs/database.md). The API connects as
        // the `app` role with IAM auth tokens; migrations connect as the
        // master user from its secret. Both get host/port/name.
        let database: Record<DatabaseParameter, string> | undefined;
        if (environment.database) {
            database = databaseParameters;
            if (!database) {
                cdk.Annotations.of(this).addError(
                    `API_DATABASE_PARAMETERS has no values for database stack ${environment.database.stackName}, so this stack can't reach its database`,
                );
                // Never deployed (the annotation blocks it); ARN-shaped only so
                // template validation doesn't add noise.
                database = {
                    host: "unset",
                    port: "0",
                    "resource-id": "unset",
                    "secret-arn": `arn:aws:secretsmanager:${this.region}:${this.account}:secret:unset`,
                };
            }
        }
        const apiDatabaseEnv: Record<string, string> = {};
        const migrateDatabaseEnv: Record<string, string> = {};
        if (database) {
            const shared = { DB_HOST: database.host, DB_PORT: database.port, DB_NAME: DATABASE_NAME };
            Object.assign(apiDatabaseEnv, shared, { DB_USER: APP_USER });
            Object.assign(migrateDatabaseEnv, shared, { DB_SECRET_ARN: database["secret-arn"] });
        }

        const logGroup = new logs.LogGroup(this, "FunctionLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const fn = new lambda.Function(this, "Function", {
            description: `${config.slug} ${environment.name} API`,
            runtime: lambda.Runtime.PROVIDED_AL2023,
            architecture,
            // provided.* runtimes ignore the handler; the binary is `bootstrap`.
            handler: "bootstrap",
            code: lambda.Code.fromAsset(codeDir(buildDir, "API_BUILD_DIR")),
            memorySize: apiConfig.memoryMb,
            timeout: cdk.Duration.seconds(apiConfig.timeoutSeconds),
            logGroup,
            // Caps instances, and so database connections. It's set aside
            // from the account's pool, which must keep at least 100
            // unreserved: on an account at the starting quota of 10 it can't
            // be set at all (README's "Limiting traffic").
            reservedConcurrentExecutions: api.maxConcurrency,
            environment: {
                ...api.env,
                ...secretParamEnv,
                ALLOWED_ORIGINS: allowedOrigins,
                ENVIRONMENT: environment.name,
                API_DOMAIN: api.domain,
                ...apiDatabaseEnv,
            },
            paramsAndSecrets,
        });
        const secretReaders: lambda.Function[] = [fn];
        // Sending through SES from the client's identities (README's
        // "Sending email"). The API function only: migrations and the
        // maintenance function never send. While the account is in the SES
        // sandbox, recipients must be verified identities too, so test
        // addresses go in email.identities and are covered here.
        if (config.email) {
            fn.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: ["ses:SendEmail", "ses:SendRawEmail"],
                    resources: config.email.identities.map((identity) =>
                        emailIdentityArn(this, identity.name),
                    ),
                }),
            );
        }
        if (database) {
            // IAM auth: lets this role mint connection tokens for the `app`
            // role on this environment's instance only.
            fn.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: ["rds-db:connect"],
                    resources: [
                        `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${database["resource-id"]}/${APP_USER}`,
                    ],
                }),
            );
        }

        // Migrations: a second Go binary that CloudFormation invokes once per
        // deploy (whenever its code changes) through a CDK trigger, before the
        // API function is updated. It gets the same env and secrets, so it
        // reaches the same database. A returned error fails the deploy and
        // CloudFormation rolls the stack back, leaving the old API code
        // serving — but it can't roll the schema back, so migrations must
        // work with the code already running. See README's "Database
        // migrations".
        if (apiConfig.migrate) {
            const migrateFn = new lambda.Function(this, "MigrateFunction", {
                description: `${config.slug} ${environment.name} API migrations`,
                runtime: lambda.Runtime.PROVIDED_AL2023,
                architecture,
                handler: "bootstrap",
                code: lambda.Code.fromAsset(codeDir(migrateBuildDir, "API_MIGRATE_BUILD_DIR")),
                memorySize: apiConfig.memoryMb,
                timeout: cdk.Duration.seconds(apiConfig.migrate.timeoutSeconds),
                logGroup: new logs.LogGroup(this, "MigrateLogs", {
                    retention: logs.RetentionDays.ONE_MONTH,
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                }),
                environment: {
                    ...api.env,
                    ...secretParamEnv,
                    ENVIRONMENT: environment.name,
                    ...migrateDatabaseEnv,
                },
                paramsAndSecrets,
            });
            secretReaders.push(migrateFn);
            if (database) {
                // The master credentials, read through the same extension.
                // The secret uses the AWS-managed aws/secretsmanager key, so no
                // kms:Decrypt grant is needed.
                migrateFn.addToRolePolicy(
                    new iam.PolicyStatement({
                        actions: ["secretsmanager:GetSecretValue"],
                        resources: [database["secret-arn"]],
                    }),
                );
            }
            // Not TriggerFunction: it uses one `timeout` for both the function
            // and the trigger's wait on it, so the wait could give up just as
            // a slow migration finishes. The trigger provider is a Lambda
            // capped at 15 minutes, hence config.ts's 10-minute migrate cap.
            new triggers.Trigger(this, "MigrateTrigger", {
                handler: migrateFn,
                timeout: cdk.Duration.seconds(apiConfig.migrate.timeoutSeconds + 60),
                executeBefore: [fn],
            });
        }

        // SecureStrings encrypted with the AWS-managed aws/ssm key need no
        // kms:Decrypt grant: that key's policy already allows decryption via
        // SSM for any principal in the account allowed to call GetParameter.
        const parameterNames = [...new Set(Object.values(api.secrets))];
        if (parameterNames.length > 0) {
            for (const reader of secretReaders) {
                reader.addToRolePolicy(
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

        // Throttling on the auto-created $default stage, so it's set on the
        // stage's resource rather than through HttpStage props; it's an
        // in-place update. Stage-wide only: every request goes through the
        // single $default route, so there's no per-route limit to set.
        if (api.throttle) {
            const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
            stage.defaultRouteSettings = {
                throttlingRateLimit: api.throttle.rate,
                throttlingBurstLimit: api.throttle.burst,
            };
        }

        // Maintenance mode: a second, always-deployed function that answers
        // every request with a 503 (assets/api-maintenance/index.mjs), and its
        // own integration. Switching the $default route between the two
        // integrations is the on/off switch; see README's "API maintenance
        // mode" and bin/api-maintenance.sh.
        const maintenanceLogGroup = new logs.LogGroup(this, "MaintenanceLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const maintenanceFn = new lambda.Function(this, "MaintenanceFunction", {
            description: `${config.slug} ${environment.name} API maintenance response`,
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            handler: "index.handler",
            code: lambda.Code.fromAsset(MAINTENANCE_DIR),
            memorySize: 128,
            timeout: cdk.Duration.seconds(3),
            logGroup: maintenanceLogGroup,
            environment: { ALLOWED_ORIGINS: allowedOrigins },
        });
        const maintenanceIntegration = new apigwv2.HttpIntegration(this, "MaintenanceIntegration", {
            httpApi,
            integrationType: apigwv2.HttpIntegrationType.AWS_PROXY,
            integrationUri: maintenanceFn.functionArn,
            payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        });
        // Same source ARN HttpLambdaIntegration grants the main function.
        maintenanceFn.addPermission("ApiGatewayInvoke", {
            principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            sourceArn: this.formatArn({
                service: "execute-api",
                resource: httpApi.apiId,
                resourceName: "*/*",
            }),
        });

        // The route and the function's integration come from defaultIntegration
        // above, and are looked up rather than built by hand so their logical
        // ids stay put: replacing the route would make CloudFormation create a
        // second $default route before deleting the first, which fails.
        const defaultRoute = httpApi.node.findChild("DefaultRoute") as apigwv2.HttpRoute;
        const functionIntegration = defaultRoute.node.findChild(
            "FunctionIntegration",
        ) as apigwv2.HttpIntegration;
        if (maintenance) {
            (defaultRoute.node.defaultChild as apigwv2.CfnRoute).target =
                `integrations/${maintenanceIntegration.integrationId}`;
        }

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
        // Read by bin/api-maintenance.sh to find and switch the route.
        new cdk.CfnOutput(this, "DefaultRouteId", { value: defaultRoute.routeId });
        new cdk.CfnOutput(this, "FunctionIntegrationId", {
            value: functionIntegration.integrationId,
        });
        new cdk.CfnOutput(this, "MaintenanceIntegrationId", {
            value: maintenanceIntegration.integrationId,
        });
    }
}
