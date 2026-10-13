import * as fs from "fs";
import * as yaml from "js-yaml";

export interface Environment {
    name: string;
    subdomain?: string;
    branch: string;
    // Fully-qualified host this environment serves (`<subdomain>.<domain>`, or
    // the bare domain for production).
    domain: string;
    // Present iff the config has a top-level `site:` block. Each environment
    // gets its own stack, bucket, and distribution.
    site?: {
        stackName: string;
        bucketName: string;
    };
    // Present iff the config has a top-level `api:` block and this environment
    // doesn't opt out with `api.enabled: false`.
    api?: {
        stackName: string;
        // Always api.<environment domain>.
        domain: string;
        env: Record<string, string>;
        // Env var key -> SSM SecureString parameter name. The function receives
        // the name as <KEY>_PARAM and reads the value at runtime.
        secrets: Record<string, string>;
    };
}

export interface Config {
    slug: string;
    domain: string;
    name: string;
    www: boolean;
    aws: {
        region: string;
        hostedZoneId: string;
    };
    environments: Environment[];
    // A client.yaml only deploys a static site if it says so explicitly — the
    // API repo's client.yaml shares slug/domain/environments but has no site.
    site?: {
        publicEnv: Record<string, string>;
    };
    // Build/runtime settings shared by every environment's API stack. The
    // deploy workflow builds one binary from these and every environment runs it.
    api?: {
        // Directory containing go.mod, relative to the repo root.
        module: string;
        // Package to build, relative to module.
        main: string;
        architecture: "arm64" | "x86_64";
        memoryMb: number;
        timeoutSeconds: number;
    };
    github?: {
        org: string;
        repos: string[];
    };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const STACK_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by the API stack itself, or reserved by the Lambda runtime.
const RESERVED_ENV_KEYS = new Set(["ALLOWED_ORIGINS", "ENVIRONMENT", "API_DOMAIN"]);
const RESERVED_ENV_PREFIXES = ["AWS_", "LAMBDA_", "_"];
// Hierarchical SSM names only, so the parameter ARN is simply
// arn:...:parameter<name>.
const SSM_NAME_RE = /^(\/[A-Za-z0-9_.-]+)+$/;
// API Gateway HTTP API caps integration timeouts at 30s.
const MAX_API_TIMEOUT_SECONDS = 30;

function parseEnvKeys(raw: unknown, where: string): [string, unknown][] {
    if (raw === undefined) return [];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`client.yaml: ${where} must be a mapping`);
    }
    const entries = Object.entries(raw);
    for (const [key] of entries) {
        if (!ENV_KEY_RE.test(key)) {
            throw new Error(`client.yaml: ${where} key "${key}" is not a valid env var name`);
        }
        if (
            RESERVED_ENV_KEYS.has(key) ||
            RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
        ) {
            throw new Error(`client.yaml: ${where} key "${key}" is reserved`);
        }
    }
    return entries;
}

function parseEnvVars(raw: unknown, where: string): Record<string, string> {
    return Object.fromEntries(
        parseEnvKeys(raw, where).map(([key, value]) => [key, String(value)]),
    );
}

function parseSecrets(raw: unknown, where: string): Record<string, string> {
    return Object.fromEntries(
        parseEnvKeys(raw, where).map(([key, value]) => {
            if (typeof value !== "string" || !SSM_NAME_RE.test(value)) {
                throw new Error(
                    `client.yaml: ${where}.${key} must be an SSM parameter name like "/client/api/key" (never the secret value itself)`,
                );
            }
            return [key, value];
        }),
    );
}

function parseIntInRange(raw: unknown, fallback: number, min: number, max: number, where: string): number {
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
        throw new Error(`client.yaml: ${where} must be an integer from ${min} to ${max}`);
    }
    return raw;
}

export function load(path: string): Config {
    const raw = yaml.load(fs.readFileSync(path, "utf-8")) as any;

    for (const key of ["slug", "domain", "aws"]) {
        if (!raw[key]) throw new Error(`client.yaml: missing required key "${key}"`);
    }

    if (!SLUG_RE.test(raw.slug)) {
        throw new Error(`client.yaml: slug "${raw.slug}" fails ${SLUG_RE}`);
    }

    for (const key of ["region", "hosted_zone_id"]) {
        if (!raw.aws[key])
            throw new Error(`client.yaml: missing required key aws.${key}`);
    }

    const www = raw.www === undefined ? true : raw.www === true;

    // V1 keys that moved under `site:` in V2. Fail loudly rather than silently
    // ignore them, or a V1 config would quietly deploy with default names.
    const moved: [boolean, string, string][] = [
        [raw.public_env !== undefined, "public_env", "site.public_env"],
        [raw.aws.stack_name !== undefined, "aws.stack_name", "site.stack_name"],
        [raw.aws.bucket_name !== undefined, "aws.bucket_name", "site.bucket_name"],
    ];
    for (const env of raw.environments ?? []) {
        for (const key of ["stack_name", "bucket_name"]) {
            moved.push([
                env[key] !== undefined,
                `environments[].${key}`,
                `environments[].site.${key}`,
            ]);
        }
    }
    for (const [present, from, to] of moved) {
        if (present) {
            throw new Error(`client.yaml: "${from}" moved to "${to}" in V2`);
        }
    }

    const rawSite = raw.site;
    if (rawSite !== undefined && (rawSite === null || typeof rawSite !== "object")) {
        throw new Error(`client.yaml: site must be a mapping (use "site: {}" for all defaults)`);
    }

    const rawApi = raw.api;
    let apiConfig: Config["api"];
    if (rawApi !== undefined) {
        if (rawApi === null || typeof rawApi !== "object") {
            throw new Error(`client.yaml: api must be a mapping`);
        }
        if (typeof rawApi.module !== "string" || !rawApi.module) {
            throw new Error(`client.yaml: missing required key api.module`);
        }
        if (rawApi.module.startsWith("/") || rawApi.module.split("/").includes("..")) {
            throw new Error(`client.yaml: api.module "${rawApi.module}" must be a path inside the repo`);
        }
        const main = rawApi.main ?? "./cmd/lambda";
        if (typeof main !== "string" || !main.startsWith("./") || main.split("/").includes("..")) {
            throw new Error(`client.yaml: api.main "${main}" must be a package path like "./cmd/lambda", relative to api.module`);
        }
        const architecture = rawApi.architecture ?? "arm64";
        if (architecture !== "arm64" && architecture !== "x86_64") {
            throw new Error(`client.yaml: api.architecture must be "arm64" or "x86_64"`);
        }
        apiConfig = {
            module: rawApi.module,
            main,
            architecture,
            memoryMb: parseIntInRange(rawApi.memory, 256, 128, 10240, "api.memory"),
            timeoutSeconds: parseIntInRange(
                rawApi.timeout, 10, 1, MAX_API_TIMEOUT_SECONDS, "api.timeout",
            ),
        };
    }

    if (!raw.environments) {
        throw new Error(`client.yaml: missing environments`);
    }

    const environments: Environment[] = [];
    const seenBranches = new Set<string>();
    const seenSubdomains = new Set<string | undefined>();
    const seenStackNames = new Set<string>();
    const seenBucketNames = new Set<string>();
    for (const env of raw.environments) {
        if (env.subdomain && !LABEL_RE.test(env.subdomain)) {
            throw new Error(
                `client.yaml: environments[].subdomain "${env.subdomain}" must be a single DNS label`,
            );
        }
        if (!env.branch) {
            throw new Error(
                `client.yaml: environments[].branch is required (environment "${env.name}" has none)`,
            );
        }
        if (seenBranches.has(env.branch)) {
            throw new Error(
                `client.yaml: environments[].branch "${env.branch}" is used by more than one environment`,
            );
        }
        seenBranches.add(env.branch);
        // Two environments on the same host would both claim the same Route53
        // record and CloudFront alias. This also limits production (no
        // subdomain) to a single entry.
        if (seenSubdomains.has(env.subdomain)) {
            throw new Error(
                env.subdomain
                    ? `client.yaml: environments[].subdomain "${env.subdomain}" is used by more than one environment`
                    : `client.yaml: more than one environment has no subdomain (only production may omit it)`,
            );
        }
        seenSubdomains.add(env.subdomain);

        const domain = env.subdomain ? `${env.subdomain}.${raw.domain}` : raw.domain;
        // Stack names share one namespace across site and API stacks.
        const claimStackName = (stackName: string) => {
            if (!STACK_NAME_RE.test(stackName)) {
                throw new Error(
                    `client.yaml: stack name "${stackName}" (environment "${env.name}") fails ${STACK_NAME_RE}`,
                );
            }
            if (seenStackNames.has(stackName)) {
                throw new Error(
                    `client.yaml: stack name "${stackName}" is used by more than one stack`,
                );
            }
            seenStackNames.add(stackName);
        };

        let site: Environment["site"];
        if (!rawSite) {
            if (env.site !== undefined) {
                throw new Error(
                    `client.yaml: environments[].site is set (environment "${env.name}") but there is no top-level site block`,
                );
            }
        } else {
            // Production keeps V1's names (and their V1 defaults) so an existing V1
            // production stack can be updated in place. Every other environment
            // gets its own, derived from the subdomain rather than `name` (which
            // may contain spaces).
            const stackName =
                env.site?.stack_name ??
                (env.subdomain
                    ? `${raw.slug}-${env.subdomain}-site`
                    : (rawSite.stack_name ?? `${raw.slug}-site`));
            const bucketName =
                env.site?.bucket_name ??
                (env.subdomain
                    ? `${raw.slug}-${env.subdomain}-site`
                    : (rawSite.bucket_name ?? `${raw.domain}-site`));

            claimStackName(stackName);
            if (seenBucketNames.has(bucketName)) {
                throw new Error(
                    `client.yaml: bucket name "${bucketName}" is used by more than one environment`,
                );
            }
            seenBucketNames.add(bucketName);
            site = { stackName, bucketName };
        }

        let api: Environment["api"];
        if (!rawApi) {
            if (env.api !== undefined) {
                throw new Error(
                    `client.yaml: environments[].api is set (environment "${env.name}") but there is no top-level api block`,
                );
            }
        } else {
            // api.<subdomain>.<domain> is always derived, so an environment whose
            // own subdomain is "api" would collide with production's API host.
            if (env.subdomain === "api") {
                throw new Error(
                    `client.yaml: environments[].subdomain "api" collides with the production API host api.${raw.domain}`,
                );
            }
            const rawEnvApi = env.api ?? {};
            if (rawEnvApi === null || typeof rawEnvApi !== "object") {
                throw new Error(`client.yaml: environments[].api (environment "${env.name}") must be a mapping`);
            }
            if (rawEnvApi.enabled !== false) {
                const stackName =
                    rawEnvApi.stack_name ??
                    (env.subdomain
                        ? `${raw.slug}-${env.subdomain}-api`
                        : (rawApi.stack_name ?? `${raw.slug}-api`));
                claimStackName(stackName);

                const where = `environments[].api (environment "${env.name}")`;
                const envVars = {
                    ...parseEnvVars(rawApi.env, "api.env"),
                    ...parseEnvVars(rawEnvApi.env, `${where}.env`),
                };
                const secrets = {
                    ...parseSecrets(rawApi.secrets, "api.secrets"),
                    ...parseSecrets(rawEnvApi.secrets, `${where}.secrets`),
                };
                // Each secret is exposed to the function as <KEY>_PARAM (the
                // parameter name, never the value) — it must not shadow a plain
                // env var.
                for (const key of Object.keys(secrets)) {
                    if (`${key}_PARAM` in envVars) {
                        throw new Error(
                            `client.yaml: secret "${key}" (environment "${env.name}") is exposed as ${key}_PARAM, which collides with an env var of the same name`,
                        );
                    }
                }
                api = { stackName, domain: `api.${domain}`, env: envVars, secrets };
            }
        }

        environments.push({
            name: env.name,
            subdomain: env.subdomain,
            branch: env.branch,
            domain,
            site,
            api,
        });
    }

    let github: Config["github"];
    if (raw.github) {
        if (!raw.github.org) {
            throw new Error(`client.yaml: missing required key github.org`);
        }
        if (raw.github.repos !== undefined && !Array.isArray(raw.github.repos)) {
            throw new Error(`client.yaml: github.repos must be a list`);
        }
        github = {
            org: raw.github.org,
            repos: raw.github.repos ?? [],
        };
    }

    let site: Config["site"];
    if (rawSite) {
        const publicEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawSite.public_env ?? {})) {
            if (!k.startsWith("PUBLIC_")) {
                throw new Error(
                    `client.yaml: site.public_env key "${k}" must start with PUBLIC_ or SvelteKit ignores it`,
                );
            }
            publicEnv[k] = String(v);
        }
        site = { publicEnv };
    }

    return {
        slug: raw.slug,
        domain: raw.domain,
        name: raw.name,
        www: www,
        aws: {
            region: raw.aws.region,
            hostedZoneId: raw.aws.hosted_zone_id,
        },
        environments: environments,
        site: site,
        api: apiConfig,
        github: github,
    };
}

export function resolveEnvironment(config: Config, branch: string): Environment {
    const env = config.environments.find((e) => e.branch === branch);
    if (!env) {
        const known = config.environments.map((e) => e.branch).join(", ");
        throw new Error(
            `client.yaml: no environments[] entry has branch "${branch}" (known branches: ${known})`,
        );
    }
    return env;
}
