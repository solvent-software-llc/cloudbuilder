import * as fs from "fs";
import * as yaml from "js-yaml";

export interface Environment {
    name: string;
    subdomain?: string;
    branch: string;
}

export interface Config {
    slug: string;
    domain: string;
    name: string;
    www: boolean;
    publicEnv: Record<string, string>;
    aws: {
        region: string;
        hostedZoneId: string;
        stackName: string;
        bucketName: string;
    };
    environments: Environment[];
    github?: {
        org: string;
        repos: string[];
    };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

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

    const stackName = raw.aws.stack_name
        ? raw.aws.stack_name
        : `${raw.slug}-site`;
    const bucketName = raw.aws.bucket_name
        ? raw.aws.bucket_name
        : `${raw.domain}-site`;

    const www = raw.www === undefined ? true : raw.www === true;

    if (!raw.environments) {
        throw new Error(`client.yaml: missing environments`);
    }

    const environments: Environment[] = [];
    const seenBranches = new Set<string>();
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
        environments.push({ name: env.name, subdomain: env.subdomain, branch: env.branch });
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

    const publicEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.public_env ?? {})) {
        if (!k.startsWith("PUBLIC_")) {
            throw new Error(
                `client.yaml: public_env key "${k}" must start with PUBLIC_ or SvelteKit ignores it`,
            );
        }
        publicEnv[k] = String(v);
    }

    return {
        slug: raw.slug,
        domain: raw.domain,
        name: raw.name,
        www: www,
        publicEnv: publicEnv,
        aws: {
            region: raw.aws.region,
            hostedZoneId: raw.aws.hosted_zone_id,
            stackName: stackName,
            bucketName: bucketName,
        },
        environments: environments,
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
