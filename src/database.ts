import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Config, Environment } from "./config";

export interface DatabaseProps extends cdk.StackProps {
    config: Config;
    environment: Environment;
    database: NonNullable<Environment["database"]>;
}

// One instance per environment means these never need to vary. The `app`
// role is created by the client's migrations; see docs/database.md.
export const DATABASE_NAME = "app";
export const APP_USER = "app";
const MASTER_USER = "postgres";
const PORT = 5432;

// Where a database stack publishes what its API stack needs. The API stack
// resolves these at deploy time, which keeps `cdk synth` offline; see
// docs/database.md ("Wiring the API stacks to the database").
export type DatabaseParameter = "host" | "port" | "resource-id" | "secret-arn";
export function databaseParameterName(stackName: string, key: DatabaseParameter): string {
    return `/cloudbuilder/${stackName}/${key}`;
}

// One per environment with an API: a publicly reachable RDS Postgres instance
// in its own small VPC. Deployed by hand, never by a workflow — it holds the
// environment's data. Public on purpose so the API Lambdas can stay outside
// any VPC (no NAT); access is TLS plus IAM auth for the API and a generated
// master password for migrations. See docs/database.md, Decision 1.
export class Database extends cdk.Stack {
    constructor(scope: Construct, id: string, props: DatabaseProps) {
        super(scope, id, props);

        const { config, environment, database } = props;
        const stackName = database.stackName;

        // RDS needs a subnet group spanning two AZs. Public subnets only, so
        // no NAT gateway; VPCs and internet gateways cost nothing.
        const vpc = new ec2.Vpc(this, "Vpc", {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            ],
        });

        // Lambda's outbound IPs aren't predictable, so there's nothing to
        // allow-list: authentication and TLS are the boundary.
        const securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
            vpc,
            description: `${config.slug} ${environment.name} Postgres`,
            allowAllOutbound: false,
        });
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(PORT), "Postgres over TLS");

        // Major version only: RDS picks the minor version and upgrades it
        // (autoMinorVersionUpgrade), and the template never pins one that a
        // later deploy would try to roll back to.
        const engine = rds.DatabaseInstanceEngine.postgres({
            version: rds.PostgresEngineVersion.of(database.postgresVersion, database.postgresVersion),
        });

        const parameterGroup = new rds.ParameterGroup(this, "Parameters", {
            engine,
            description: `${config.slug} ${environment.name} Postgres`,
            // The default from Postgres 15 on, set anyway: with a public
            // endpoint, refusing plaintext connections isn't optional.
            parameters: { "rds.force_ssl": "1" },
        });

        const instance = new rds.DatabaseInstance(this, "Instance", {
            engine,
            // client.yaml uses RDS's own spelling (db.t4g.micro); InstanceType
            // takes it without the prefix.
            instanceType: new ec2.InstanceType(database.instanceClass.replace(/^db\./, "")),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            publiclyAccessible: true,
            securityGroups: [securityGroup],
            port: PORT,
            parameterGroup,
            caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
            databaseName: DATABASE_NAME,
            // A Secrets Manager secret holding the generated password plus
            // host, port, and dbname. Only migrations and humans use it.
            credentials: rds.Credentials.fromGeneratedSecret(MASTER_USER),
            iamAuthentication: true,
            storageType: rds.StorageType.GP3,
            allocatedStorage: database.storageGb,
            maxAllocatedStorage: database.maxStorageGb,
            storageEncrypted: true,
            multiAz: false,
            autoMinorVersionUpgrade: true,
            backupRetention: cdk.Duration.days(database.backupRetentionDays),
            copyTagsToSnapshot: true,
            enablePerformanceInsights: true,
            // Deleting the stack fails until protection is turned off by hand,
            // and even then leaves a final snapshot.
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
        });

        // CloudFormation's validation flags both halves of Decision 1. They're
        // the point, not an oversight.
        cdk.Validations.of(securityGroup).acknowledge({
            id: "CloudFormation-Validate::W2508",
            reason: "Open to 0.0.0.0/0 by design: Lambda egress IPs can't be allow-listed (docs/database.md, Decision 1)",
        });
        cdk.Validations.of(instance).acknowledge({
            id: "CloudFormation-Validate::W9011",
            reason: "Publicly accessible by design so the API Lambdas need no VPC or NAT (docs/database.md, Decision 1)",
        });

        const parameters: Record<DatabaseParameter, string> = {
            host: instance.dbInstanceEndpointAddress,
            port: instance.dbInstanceEndpointPort,
            "resource-id": instance.instanceResourceId!,
            "secret-arn": instance.secret!.secretArn,
        };
        for (const [key, value] of Object.entries(parameters) as [DatabaseParameter, string][]) {
            new ssm.StringParameter(this, `Parameter-${key}`, {
                parameterName: databaseParameterName(stackName, key),
                description: `${config.slug} ${environment.name} database ${key}, read by its API stack`,
                stringValue: value,
            });
        }

        new cdk.CfnOutput(this, "Endpoint", { value: instance.dbInstanceEndpointAddress });
        new cdk.CfnOutput(this, "SecretArn", { value: instance.secret!.secretArn });
    }
}
