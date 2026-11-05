import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { load } from "./config";
import { Api } from "./api";
import { Email } from "./email";

const fixture = (name: string) => `${__dirname}/__fixtures__/${name}.yaml`;
const env = { account: "111111111111", region: "us-east-1" };

// The production API stack for a fixture, as bin/app.ts builds it (without a
// Lambda build, which only adds an error annotation).
function apiTemplate(name: string): Template {
    const config = load(fixture(name));
    const environment = config.environments[0];
    const stack = new Api(new cdk.App(), environment.api!.stackName, {
        config,
        apiConfig: config.api!,
        environment,
        api: environment.api!,
        maintenance: false,
        env,
    });
    return Template.fromStack(stack);
}

function emailTemplate(name: string): Template {
    const config = load(fixture(name));
    return Template.fromStack(new Email(new cdk.App(), config.email!.stackName, { config, email: config.email!, env }));
}

describe("email stack", () => {
    const template = emailTemplate("email");

    it("has no configuration set, topic or alarms unless they're set", () => {
        template.resourceCountIs("AWS::SES::ConfigurationSet", 0);
        template.resourceCountIs("AWS::SNS::Topic", 0);
        template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    });

    it("creates one SES identity per configured identity", () => {
        template.resourceCountIs("AWS::SES::EmailIdentity", 2);
        template.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "solventsoftware.com" });
        template.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "tester@example.com" });
    });

    it("adds the domain's three DKIM records to the hosted zone", () => {
        template.resourceCountIs("AWS::Route53::RecordSet", 3);
        template.allResourcesProperties("AWS::Route53::RecordSet", {
            Type: "CNAME",
            HostedZoneId: "HS1234",
        });
    });
});

describe("email stack with suppression and alarms", () => {
    const template = emailTemplate("email-reputation");

    it("suppresses bounces and complaints in a configuration set every identity uses by default", () => {
        template.hasResourceProperties("AWS::SES::ConfigurationSet", {
            Name: "solvent-software-email",
            SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
        });
        const identities = template.findResources("AWS::SES::EmailIdentity");
        expect(Object.keys(identities)).toHaveLength(2);
        for (const identity of Object.values(identities)) {
            expect(identity.Properties.ConfigurationSetAttributes).toEqual({
                ConfigurationSetName: { Ref: expect.stringMatching(/^ConfigurationSet/) },
            });
        }
    });

    it("can suppress just one reason", () => {
        emailTemplate("email-suppress-bounce").hasResourceProperties("AWS::SES::ConfigurationSet", {
            SuppressionOptions: { SuppressedReasons: ["BOUNCE"] },
        });
    });

    it("emails each alarm recipient", () => {
        template.resourceCountIs("AWS::SNS::Topic", 1);
        template.resourceCountIs("AWS::SNS::Subscription", 2);
        for (const address of ["ops@example.com", "oncall@example.com"]) {
            template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: address });
        }
    });

    it.each([
        ["Reputation.BounceRate", 0.025],
        ["Reputation.ComplaintRate", 0.0005],
    ])("alarms on %s at half SES's review rate by default, in both directions", (metricName, threshold) => {
        const topic = { Ref: Match.stringLikeRegexp("^Alarms") };
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
            Namespace: "AWS/SES",
            MetricName: metricName,
            Threshold: threshold,
            ComparisonOperator: "GreaterThanOrEqualToThreshold",
            TreatMissingData: "notBreaching",
            AlarmActions: [topic],
            OKActions: [topic],
        });
    });

    it("uses configured thresholds", () => {
        const custom = emailTemplate("email-alarm-thresholds");
        custom.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Reputation.BounceRate", Threshold: 0.04 });
        custom.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Reputation.ComplaintRate", Threshold: 0.0008 });
    });
});

describe("API stack email access", () => {
    it("lets the API function send from every identity, and nothing else", () => {
        const template = apiTemplate("email");
        const arn = (name: string) => ({
            "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:ses:us-east-1:111111111111:identity/${name}`]],
        });
        template.hasResourceProperties("AWS::IAM::Policy", {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    {
                        Action: ["ses:SendEmail", "ses:SendRawEmail"],
                        Effect: "Allow",
                        Resource: [arn("solventsoftware.com"), arn("tester@example.com")],
                    },
                ]),
            },
        });
    });

    it("also covers the configuration set when there is one", () => {
        const template = apiTemplate("email-reputation");
        const arn = (resource: string) => ({
            "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:ses:us-east-1:111111111111:${resource}`]],
        });
        template.hasResourceProperties("AWS::IAM::Policy", {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    {
                        Action: ["ses:SendEmail", "ses:SendRawEmail"],
                        Effect: "Allow",
                        Resource: [
                            arn("identity/solventsoftware.com"),
                            arn("identity/tester@example.com"),
                            arn("configuration-set/solvent-software-email"),
                        ],
                    },
                ]),
            },
        });
    });

    it("grants no SES access without an email block", () => {
        const policies = apiTemplate("api-migrate").findResources("AWS::IAM::Policy");
        expect(JSON.stringify(policies)).not.toContain("ses:");
    });
});
