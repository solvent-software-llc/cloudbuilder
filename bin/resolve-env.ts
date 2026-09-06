#!/usr/bin/env node
// Resolves a git branch to its client.yaml environment and writes the values
// the deploy workflow needs (stack name, region, key prefix, target domain)
// to $GITHUB_OUTPUT. Branch -> environment matching (including the "no
// environment declares this branch" error) lives here, in the same code that
// already owns environments[] parsing, rather than being re-implemented with
// yq in the workflow.
import * as fs from "fs";
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
