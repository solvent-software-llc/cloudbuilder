import { describe, it, expect } from "vitest";
import { load, resolveEnvironment } from "./config";

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
            { name: "production", subdomain: undefined, branch: "main" },
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
            { name: "production", subdomain: undefined, branch: "main" },
            { name: "preview build", subdomain: "preview", branch: "dev" },
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
    it("throws when an environment has no branch", () => {
        expect(() => load(fixture("missing-branch"))).toThrow(
            /environments\[\]\.branch is required/,
        );
    });
    it("throws when two environments share a branch", () => {
        expect(() => load(fixture("duplicate-branch"))).toThrow(
            /branch "main" is used by more than one environment/,
        );
    });
});

describe("resolveEnvironment", () => {
    it("finds the environment matching a branch", () => {
        const config = load(fixture("all-values"));
        expect(resolveEnvironment(config, "dev")).toEqual({
            name: "preview build",
            subdomain: "preview",
            branch: "dev",
        });
    });
    it("throws when no environment matches the branch", () => {
        const config = load(fixture("all-values"));
        expect(() => resolveEnvironment(config, "staging")).toThrow(
            /no environments\[\] entry has branch "staging"/,
        );
    });
});
