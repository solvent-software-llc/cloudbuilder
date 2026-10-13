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
    github?: {
        org: string;
        repos: string[];
    };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const STACK_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

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
        if (!rawSite) {
            if (env.site !== undefined) {
                throw new Error(
                    `client.yaml: environments[].site is set (environment "${env.name}") but there is no top-level site block`,
                );
            }
            environments.push({ name: env.name, subdomain: env.subdomain, branch: env.branch, domain });
            continue;
        }

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

        if (!STACK_NAME_RE.test(stackName)) {
            throw new Error(
                `client.yaml: stack name "${stackName}" (environment "${env.name}") fails ${STACK_NAME_RE}`,
            );
        }
        if (seenStackNames.has(stackName)) {
            throw new Error(
                `client.yaml: stack name "${stackName}" is used by more than one environment`,
            );
        }
        seenStackNames.add(stackName);
        if (seenBucketNames.has(bucketName)) {
            throw new Error(
                `client.yaml: bucket name "${bucketName}" is used by more than one environment`,
            );
        }
        seenBucketNames.add(bucketName);

        environments.push({
            name: env.name,
            subdomain: env.subdomain,
            branch: env.branch,
            domain,
            site: { stackName, bucketName },
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
