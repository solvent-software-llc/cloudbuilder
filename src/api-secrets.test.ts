import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { load } from "./config";
import { Api } from "./api";

const fixture = (name: string) => `${__dirname}/__fixtures__/${name}.yaml`;

// An environment's API stack, as bin/app.ts builds it (without a Lambda
// build, which only adds an error annotation).
function apiTemplate(name: string, environmentIndex = 0): Template {
    const config = load(fixture(name));
    const environment = config.environments[environmentIndex];
    const stack = new Api(new cdk.App(), environment.api!.stackName, {
        config,
        apiConfig: config.api!,
        environment,
        api: environment.api!,
        maintenance: false,
        env: { account: "111111111111", region: "us-east-1" },
    });
    return Template.fromStack(stack);
}

// Every policy statement that reads SSM parameters.
function ssmStatements(template: Template): { Action: unknown; Resource: unknown }[] {
    return Object.values(template.findResources("AWS::IAM::Policy")).flatMap((policy) =>
        policy.Properties.PolicyDocument.Statement.filter((s: { Action: unknown }) =>
            [s.Action].flat().some((a) => String(a).startsWith("ssm:")),
        ),
    );
}

const arn = (name: string) => `arn:aws:ssm:us-east-1:111111111111:parameter${name}`;

describe("API secrets", () => {
    it("lets the function read its parameters one at a time or together", () => {
        const statements = ssmStatements(apiTemplate("api"));
        expect(statements).toEqual([
            expect.objectContaining({
                Action: ["ssm:GetParameter", "ssm:GetParameters"],
                Resource: arn("/solvent/api/token-key"),
            }),
        ]);
    });

    it("scopes an environment's grant to its own parameters", () => {
        const statements = ssmStatements(apiTemplate("api", 1));
        expect(statements).toEqual([
            expect.objectContaining({ Resource: arn("/solvent/api/preview/token-key") }),
        ]);
    });
});
