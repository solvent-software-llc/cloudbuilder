#!/usr/bin/env node
// Resolves a git branch to its client.yaml environment and writes the values
// a deploy workflow needs (stack name, region, target domain, ...) to
// $GITHUB_OUTPUT. TARGET picks which deploy: "site" (default,
// static-site-deploy.yml) or "api" (api-deploy.yml). Branch -> environment
// matching (including the "no environment declares this branch" error) lives
// here, in the same code that already owns environments[] parsing, rather than
// being re-implemented with yq in the workflow.
//
// For the site target, also writes .env (from client.yaml's site.public_env)
// into the site repo root, since that's the one place in the whole deploy
// pipeline that has both the parsed config and runs before `npm run build`.
// Plain .env, not
// .env.production: `npm run check` runs svelte-kit sync in dev mode, and
// Vite loads .env in every mode. Values are quoted so a value containing a
// "#" isn't parsed as a comment.
import * as fs from "fs";
import * as path from "path";
import { load, resolveEnvironment } from "../src/config";

const configPath = process.env.CONFIG_PATH;
const branch = process.env.BRANCH;
const target = process.env.TARGET ?? "site";
const githubOutput = process.env.GITHUB_OUTPUT;

if (!configPath) throw new Error("CONFIG_PATH is required");
if (!branch) throw new Error("BRANCH is required");
if (!githubOutput) throw new Error("GITHUB_OUTPUT is required");
if (target !== "site" && target !== "api") {
    throw new Error(`TARGET must be "site" or "api", got "${target}"`);
}

const config = load(configPath);
const environment = resolveEnvironment(config, branch);

function writeOutputs(outputs: Record<string, string>) {
    fs.appendFileSync(
        githubOutput!,
        Object.entries(outputs)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
    );
}

if (target === "api") {
    if (!config.api) {
        throw new Error(`${configPath} has no api block, so there is no API to deploy`);
    }
    if (!environment.api) {
        throw new Error(
            `environment "${environment.name}" (branch "${branch}") sets api.enabled: false, so there is no API to deploy`,
        );
    }
    writeOutputs({
        stack: environment.api.stackName,
        region: config.aws.region,
        environment: environment.name,
        "api-domain": environment.api.domain,
        module: config.api.module,
        main: config.api.main,
        // Go's GOARCH spelling of the Lambda architecture.
        goarch: config.api.architecture === "arm64" ? "arm64" : "amd64",
    });
    process.exit(0);
}

if (!config.site || !environment.site) {
    throw new Error(`${configPath} has no site block, so there is no site to deploy`);
}

writeOutputs({
    stack: environment.site.stackName,
    region: config.aws.region,
    environment: environment.name,
    "target-domain": environment.domain,
});

// configPath is CONFIG_PATH from the workflow, always
// `${{ github.workspace }}/${{ inputs.config-path }}` — its directory is the
// site repo root, which is where `npm run build` runs from later.
const envPath = path.join(path.dirname(configPath), ".env");
const envEntries = Object.entries(config.site.publicEnv);
fs.writeFileSync(
    envPath,
    envEntries.map(([key, value]) => `${key}="${value}"\n`).join(""),
);
console.log(
    envEntries.length > 0
        ? `Wrote ${envPath} with: ${envEntries.map(([key]) => key).join(", ")}`
        : `Wrote ${envPath} (client.yaml has no site.public_env keys)`,
);
