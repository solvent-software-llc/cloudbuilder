import { describe, it, expect } from "vitest";
import { load } from "./config";

const fixture = (name: string) => `${__dirname}/__fixtures__/${name}.yaml`;

describe("load", () => {
    it("parses minimal valid config with defaults", () => {
        const config = load(fixture("minimal"));
        expect(config.slug).toBe("solvent-software");
        expect(config.domain).toBe("solventsoftware.com");
        expect(config.name).toBe("solvent software");
        expect(config.www).toBe(true);
        expect(config.publicEnv).toStrictEqual({});
        expect(config.aws.region).toBe("us-east-1");
        expect(config.aws.hostedZoneId).toBe("HS1234");
        expect(config.aws.stackName).toBe("solvent-software-site");
        expect(config.aws.bucketName).toBe("solventsoftware.com-site");
        expect(config.environments).toEqual([
            { name: "production", subdomain: undefined },
        ]);
        expect(config.github).toBeUndefined();
    });
    it("parses config with all values set", () => {
        const config = load(fixture("all-values"));
        expect(config.slug).toBe("solvent-software");
        expect(config.domain).toBe("solventsoftware.com");
        expect(config.name).toBe("solvent software");
        expect(config.www).toBe(false);
        expect(config.publicEnv).toStrictEqual({ PUBLIC_KEY: "value" });
        expect(config.aws.region).toBe("us-east-1");
        expect(config.aws.hostedZoneId).toBe("HS1234");
        expect(config.aws.stackName).toBe("custom-stack");
        expect(config.aws.bucketName).toBe("custom-bucket");
        expect(config.environments).toEqual([
            { name: "production", subdomain: undefined },
            { name: "preview build", subdomain: "preview" },
        ]);
        expect(config.github).toEqual({
            org: "solvent-software-llc",
            repos: ["solvent-software-site"],
        });
    });
    it("throws on missing required value", () => {
        expect(() => load(fixture("missing-slug"))).toThrow(
            /missing required key "slug"/,
        );
    });
});
