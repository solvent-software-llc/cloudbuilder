#!/usr/bin/env node
// Runs this CDK app against the client.yaml of the repo you're in, so the
// stacks deployed by hand (deploy roles, databases) can be deployed from a
// client repo without a cloudbuilder checkout:
//
//   npx github:solvent-software-llc/cloudbuilder#v2 deploy <stack>
//
// Any arguments are passed to the CDK CLI. `--config <path>` overrides the
// default client.yaml at the git root. See README's "Running cloudbuilder from
// a client repo".
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// npx may hoist this package's dependencies out of packageDir, so resolve
// them the way Node would from here rather than assuming node_modules/.bin.
const require = createRequire(path.join(packageDir, "package.json"));

function fail(message) {
    console.error(`cloudbuilder: ${message}`);
    process.exit(1);
}

function repoRoot() {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return process.cwd();
    }
}

const args = process.argv.slice(2);
let configPath;
const configIndex = args.indexOf("--config");
if (configIndex !== -1) {
    configPath = args[configIndex + 1];
    if (!configPath) fail("--config needs a path to a client.yaml");
    args.splice(configIndex, 2);
}
if (args.length === 0) {
    fail("usage: cloudbuilder [--config <client.yaml>] <cdk command> [stack] [cdk options]");
}
configPath = path.resolve(configPath ?? path.join(repoRoot(), "client.yaml"));
if (!existsSync(configPath)) {
    fail(`no client.yaml at ${configPath} (run from a client repo, or pass --config)`);
}

// An explicit --app instead of cdk.json's `npx ts-node bin/app.ts`, whose
// `npx` wouldn't find hoisted dependencies; `-r` resolves the ts-node hook
// like a require from packageDir, which does. No absolute paths: the CDK CLI
// splits --app on spaces, quoted or not, and Node or the npx cache can live
// under a path with spaces (e.g. ~/Library/Application Support). Transpile
// only, because this install has no @types packages; `npm test` and tsc
// type-check in development.
const app = "node -r ts-node/register/transpile-only bin/app.ts";

// Run from packageDir so the relative --app resolves and cdk.out lands there,
// not in the client repo.
const result = spawnSync(
    process.execPath,
    [require.resolve("aws-cdk/bin/cdk"), ...args, "--app", app],
    {
        cwd: packageDir,
        stdio: "inherit",
        env: { ...process.env, CONFIG_PATH: configPath },
    },
);
process.exit(result.status ?? 1);
