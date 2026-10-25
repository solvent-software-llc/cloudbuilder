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

describe("email stack", () => {
    const config = load(fixture("email"));
    const template = Template.fromStack(
        new Email(new cdk.App(), config.email!.stackName, { config, email: config.email!, env }),
    );

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

    it("grants no SES access without an email block", () => {
        const policies = apiTemplate("api-migrate").findResources("AWS::IAM::Policy");
        expect(JSON.stringify(policies)).not.toContain("ses:");
    });
});
