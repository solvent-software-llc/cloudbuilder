#!/usr/bin/env node
// Resolves a git branch to its client.yaml environment and writes the values
// the deploy workflow needs (stack name, region, key prefix, target domain)
// to $GITHUB_OUTPUT. Branch -> environment matching (including the "no
// environment declares this branch" error) lives here, in the same code that
// already owns environments[] parsing, rather than being re-implemented with
// yq in the workflow.
//
// Also writes .env (from client.yaml's public_env) into the site repo root,
// since that's the one place in the whole deploy pipeline that has both the
// parsed config and runs before `npm run build`. Plain .env, not
// .env.production: `npm run check` runs svelte-kit sync in dev mode, and
// Vite loads .env in every mode. Values are quoted so a value containing a
// "#" isn't parsed as a comment.
import * as fs from "fs";
import * as path from "path";
import { load, resolveEnvironment } from "../src/config";

const configPath = process.env.CONFIG_PATH;
const branch = process.env.BRANCH;
const githubOutput = process.env.GITHUB_OUTPUT;

if (!configPath) throw new Error("CONFIG_PATH is required");
if (!branch) throw new Error("BRANCH is required");
if (!githubOutput) throw new Error("GITHUB_OUTPUT is required");

const config = load(configPath);
const environment = resolveEnvironment(config, branch);

const prefix = environment.subdomain ? `${environment.subdomain}/` : "";
const targetDomain = environment.subdomain
    ? `${environment.subdomain}.${config.domain}`
    : config.domain;

const outputs = {
    stack: config.aws.stackName,
    region: config.aws.region,
    environment: environment.name,
    prefix,
    "target-domain": targetDomain,
};

fs.appendFileSync(
    githubOutput,
    Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
);

// configPath is CONFIG_PATH from the workflow, always
// `${{ github.workspace }}/${{ inputs.config-path }}` — its directory is the
// site repo root, which is where `npm run build` runs from later.
const envPath = path.join(path.dirname(configPath), ".env");
const envEntries = Object.entries(config.publicEnv);
fs.writeFileSync(
    envPath,
    envEntries.map(([key, value]) => `${key}="${value}"\n`).join(""),
);
console.log(
    envEntries.length > 0
        ? `Wrote ${envPath} with: ${envEntries.map(([key]) => key).join(", ")}`
        : `Wrote ${envPath} (client.yaml has no public_env keys)`,
);
