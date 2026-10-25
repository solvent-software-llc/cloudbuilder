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
        expect(config.aws.region).toBe("us-east-1");
        expect(config.aws.hostedZoneId).toBe("HS1234");
        expect(config.environments).toEqual([
            {
                name: "production",
                subdomain: undefined,
                branch: "main",
                domain: "solventsoftware.com",
            },
        ]);
        expect(config.site).toBeUndefined();
        expect(config.github).toBeUndefined();
    });
    it("parses config with all values set", () => {
        const config = load(fixture("all-values"));
        expect(config.slug).toBe("solvent-software");
        expect(config.domain).toBe("solventsoftware.com");
        expect(config.name).toBe("solvent software");
        expect(config.www).toBe(false);
        expect(config.site).toStrictEqual({ publicEnv: { PUBLIC_KEY: "value" } });
        expect(config.aws.region).toBe("us-east-1");
        expect(config.aws.hostedZoneId).toBe("HS1234");
        expect(config.environments).toEqual([
            {
                name: "production",
                subdomain: undefined,
                branch: "main",
                domain: "solventsoftware.com",
                site: { stackName: "custom-stack", bucketName: "custom-bucket" },
            },
            {
                name: "preview build",
                subdomain: "preview",
                branch: "dev",
                domain: "preview.solventsoftware.com",
                site: {
                    stackName: "solvent-software-preview-site",
                    bucketName: "solvent-software-preview-site",
                },
            },
        ]);
        expect(config.github).toEqual({
            org: "solvent-software-llc",
            repos: ["solvent-software-site"],
        });
    });
    it("derives site names when site is an empty block", () => {
        const config = load(fixture("site-defaults"));
        expect(config.site).toStrictEqual({ publicEnv: {} });
        expect(config.environments.map((e) => e.site)).toEqual([
            { stackName: "solvent-software-site", bucketName: "solventsoftware.com-site" },
            {
                stackName: "solvent-software-preview-site",
                bucketName: "solvent-software-preview-site",
            },
        ]);
    });
    it("prefers per-environment site names over site.* and defaults", () => {
        const config = load(fixture("env-overrides"));
        expect(config.environments.map((e) => e.site)).toEqual([
            { stackName: "prod-stack", bucketName: "prod-bucket" },
            { stackName: "staging-stack", bucketName: "staging-bucket" },
        ]);
    });
    it("throws on V1 keys that moved under site", () => {
        expect(() => load(fixture("v1-keys"))).toThrow(
            /"aws.bucket_name" moved to "site.bucket_name"/,
        );
    });
    it("throws when an environment sets site without a top-level site block", () => {
        expect(() => load(fixture("env-site-without-site"))).toThrow(
            /environments\[\]\.site is set .* no top-level site block/,
        );
    });
    it("throws when more than one environment has no subdomain", () => {
        expect(() => load(fixture("two-production"))).toThrow(
            /more than one environment has no subdomain/,
        );
    });
    it("throws when two environments share a subdomain", () => {
        expect(() => load(fixture("duplicate-subdomain"))).toThrow(
            /subdomain "preview" is used by more than one environment/,
        );
    });
    it("throws when two environments share a bucket name", () => {
        expect(() => load(fixture("duplicate-bucket"))).toThrow(
            /bucket name "shared-bucket" is used by more than one environment/,
        );
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

describe("load: api", () => {
    it("parses the api block with defaults and per-environment overrides", () => {
        const config = load(fixture("api"));
        expect(config.site).toBeUndefined();
        expect(config.api).toStrictEqual({
            module: "api",
            main: "./cmd/lambda",
            architecture: "arm64",
            memoryMb: 512,
            timeoutSeconds: 10,
            migrate: undefined,
        });
        expect(config.environments.map((e) => e.api)).toEqual([
            {
                stackName: "solvent-software-api",
                domain: "api.solventsoftware.com",
                env: { LOG_LEVEL: "warn", PAGE_SIZE: "50" },
                secrets: { TOKEN_SIGNING_KEY: "/solvent/api/token-key" },
            },
            {
                stackName: "preview-api",
                domain: "api.preview.solventsoftware.com",
                env: { LOG_LEVEL: "info", PAGE_SIZE: "50" },
                secrets: { TOKEN_SIGNING_KEY: "/solvent/api/preview/token-key" },
            },
            undefined,
        ]);
    });
    it("parses api.migrate with a default timeout", () => {
        const config = load(fixture("api-migrate"));
        expect(config.api?.migrate).toStrictEqual({
            main: "./cmd/migrate",
            timeoutSeconds: 300,
        });
    });
    it("leaves api undefined everywhere without an api block", () => {
        const config = load(fixture("all-values"));
        expect(config.api).toBeUndefined();
        expect(config.environments.every((e) => e.api === undefined)).toBe(true);
    });
    it.each([
        ["api-secret-value", /must be an SSM parameter name .*never the secret value/],
        ["api-reserved-env", /api\.env key "AWS_REGION" is reserved/],
        ["api-timeout", /api\.timeout must be an integer from 1 to 30/],
        ["api-subdomain", /subdomain "api" collides with the production API host/],
        ["api-param-collision", /secret "KEY" .* exposed as KEY_PARAM/],
        ["api-stack-collision", /stack name "solvent-software-site" is used by more than one stack/],
        ["env-api-without-api", /environments\[\]\.api is set .* no top-level api block/],
        ["api-migrate-timeout", /api\.migrate_timeout must be an integer from 1 to 600/],
        ["api-migrate-path", /api\.migrate "cmd\/migrate" must be a package path/],
        ["api-migrate-same-main", /api\.migrate must be a different package from api\.main/],
        ["api-migrate-timeout-without-migrate", /api\.migrate_timeout is set but api\.migrate is not/],
    ])("rejects %s", (name, error) => {
        expect(() => load(fixture(name))).toThrow(error);
    });
});

describe("load: database", () => {
    it("parses the database block with defaults and per-environment overrides", () => {
        const config = load(fixture("database"));
        expect(config.environments.map((e) => e.database)).toStrictEqual([
            {
                stackName: "solvent-software-db",
                postgresVersion: "18",
                instanceClass: "db.t4g.small",
                storageGb: 30,
                maxStorageGb: 100,
                backupRetentionDays: 14,
            },
            {
                stackName: "preview-db",
                postgresVersion: "17",
                instanceClass: "db.t4g.micro",
                storageGb: 30,
                maxStorageGb: 100,
                backupRetentionDays: 7,
            },
            // enabled: false
            undefined,
            // no API, so no database
            undefined,
        ]);
    });
    it("leaves database undefined everywhere without a database block", () => {
        const config = load(fixture("api-migrate"));
        expect(config.environments.every((e) => e.database === undefined)).toBe(true);
    });
    it("allows DB_* env vars when there is no database", () => {
        const config = load(fixture("api-db-env-without-database"));
        expect(config.environments[0].api?.env).toEqual({ DB_HOST: "elsewhere.example.com" });
    });
    it.each([
        ["database-without-api", /database requires an api block with api\.migrate set/],
        ["database-without-migrate", /database requires an api block with api\.migrate set/],
        ["env-database-without-database", /environments\[\]\.database is set .* no top-level database block/],
        ["database-api-disabled", /environments\[\]\.database .* is set but the environment has no API/],
        ["database-reserved-env", /env var "DB_HOST" .* is reserved because the environment has a database/],
        ["database-instance-class", /database\.instance_class "t4g\.micro" must be an RDS instance class/],
        ["database-postgres-version", /database\.postgres_version "18\.3" must be a major version/],
        ["database-max-storage", /max_storage \(100\) must be at least storage \(200\)/],
        ["database-backup-retention", /database\.backup_retention must be an integer from 1 to 35/],
        ["database-stack-collision", /stack name "solvent-software-api" is used by more than one stack/],
    ])("rejects %s", (name, error) => {
        expect(() => load(fixture(name))).toThrow(error);
    });
});

describe("load: email", () => {
    it("parses identities, lowercased, with a derived stack name", () => {
        const config = load(fixture("email"));
        expect(config.email).toEqual({
            stackName: "solvent-software-email",
            identities: [
                { name: "solventsoftware.com", kind: "domain" },
                { name: "tester@example.com", kind: "address" },
            ],
        });
    });
    it("defaults to verifying just the domain", () => {
        expect(load(fixture("email-defaults")).email?.identities).toEqual([
            { name: "solventsoftware.com", kind: "domain" },
        ]);
    });
    it("leaves email undefined without an email block", () => {
        expect(load(fixture("api-migrate")).email).toBeUndefined();
    });
    it.each([
        ["email-without-api", /email requires an api block/],
        ["email-other-domain", /"otherdomain\.com" must be solventsoftware\.com \(the hosted zone's domain\) or an email address/],
        ["email-bad-address", /"someone@nowhere" is not an email address/],
        ["email-duplicate", /lists "tester@example\.com" more than once/],
        ["email-stack-collision", /stack name "shared-name" is used by more than one stack/],
    ])("rejects %s", (name, error) => {
        expect(() => load(fixture(name))).toThrow(error);
    });
});

describe("resolveEnvironment", () => {
    it("finds the environment matching a branch", () => {
        const config = load(fixture("all-values"));
        expect(resolveEnvironment(config, "dev")).toMatchObject({
            name: "preview build",
            subdomain: "preview",
            branch: "dev",
            site: { stackName: "solvent-software-preview-site" },
        });
    });
    it("throws when no environment matches the branch", () => {
        const config = load(fixture("all-values"));
        expect(() => resolveEnvironment(config, "staging")).toThrow(
            /no environments\[\] entry has branch "staging"/,
        );
    });
});
