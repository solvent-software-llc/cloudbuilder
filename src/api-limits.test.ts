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

// Every Lambda function's reserved concurrency, keyed by logical id prefix.
function reservedConcurrency(template: Template): Record<string, unknown> {
    const functions = template.findResources("AWS::Lambda::Function");
    return Object.fromEntries(
        Object.entries(functions).map(([id, fn]) => [
            id.replace(/[0-9A-F]{8}$/, ""),
            fn.Properties.ReservedConcurrentExecutions,
        ]),
    );
}

describe("API stack limits", () => {
    it("reserves concurrency for the API function only", () => {
        const reserved = reservedConcurrency(apiTemplate("api-limits"));
        expect(reserved.Function).toBe(20);
        // The migration and maintenance functions stay on the shared pool.
        expect(reserved.MigrateFunction).toBeUndefined();
        expect(reserved.MaintenanceFunction).toBeUndefined();
    });

    it("throttles the default stage", () => {
        apiTemplate("api-limits").hasResourceProperties("AWS::ApiGatewayV2::Stage", {
            StageName: "$default",
            DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
        });
    });

    it("uses an environment's own limits", () => {
        const template = apiTemplate("api-limits", 1);
        expect(reservedConcurrency(template).Function).toBe(2);
        template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
            DefaultRouteSettings: { ThrottlingRateLimit: 2.5, ThrottlingBurstLimit: 10 },
        });
    });

    it("sets neither without the keys", () => {
        const template = apiTemplate("api-migrate");
        expect(Object.values(reservedConcurrency(template)).every((v) => v === undefined)).toBe(true);
        const stages = template.findResources("AWS::ApiGatewayV2::Stage");
        expect(Object.values(stages).every((stage) => stage.Properties.DefaultRouteSettings === undefined)).toBe(true);
    });
});
