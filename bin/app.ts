#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GithubOidc } from "../src/oidc";
import { StaticSite } from "../src/static-site";
import { GithubDeployRole } from "../src/github-deploy-role";
import { Api } from "../src/api";
import { Database } from "../src/database";
import { Email } from "../src/email";
import { DATABASE_PARAMETERS, DatabaseParameter, load } from "../src/config";

const app = new cdk.App();

new GithubOidc(app, "github-oidc-bootstrap");

const configPath = process.env.CONFIG_PATH;
if (configPath) {
    const config = load(configPath);
    if (config.github) {
        const { org: githubOrg, repos } = config.github;
        for (const repoName of repos) {
            // CFN stack names must match /^[A-Za-z][A-Za-z0-9-]*$/, but repo names
            // commonly contain dots (e.g. "example.com") — sanitize for the stack
            // id/name only. The unsanitized repoName still flows into the OIDC
            // trust policy and IAM role name below, where it must match GitHub exactly.
            const stackId = `github-deploy-role-${config.slug}-${repoName}`.replace(
                /[^A-Za-z0-9-]/g,
                "-",
            );
            new GithubDeployRole(app, stackId, {
                config,
                githubOrg,
                repoName,
                env: { region: config.aws.region },
            });
        }
    }
    for (const environment of config.environments) {
        if (!environment.site) continue;
        new StaticSite(app, environment.site.stackName, {
            config,
            environment,
            site: environment.site,
            env: { region: config.aws.region },
            crossRegionReferences: false,
        });
    }
    // Set by api-deploy.yml from the live route (bin/api-maintenance.sh
    // status). Unset means off, so a hand-run `cdk deploy` of an API stack
    // that's in maintenance takes it out of maintenance.
    const apiMaintenance = process.env.API_MAINTENANCE ?? "off";
    if (apiMaintenance !== "on" && apiMaintenance !== "off") {
        throw new Error(`API_MAINTENANCE must be "on" or "off", got "${apiMaintenance}"`);
    }
    // Set by api-deploy.yml from the database stack's SSM parameters, as JSON:
    // {"stack": "<database stack>", "host": ..., "port": ..., ...}. Only the
    // API stack whose environment owns that database gets them; every other
    // API stack with a database keeps its "not set" error annotation.
    let databaseParameters: { stack: string; values: Record<DatabaseParameter, string> } | undefined;
    if (process.env.API_DATABASE_PARAMETERS) {
        const raw = JSON.parse(process.env.API_DATABASE_PARAMETERS);
        const missing = ["stack", ...DATABASE_PARAMETERS].filter(
            (key) => typeof raw[key] !== "string" || !raw[key],
        );
        if (missing.length > 0) {
            throw new Error(`API_DATABASE_PARAMETERS is missing: ${missing.join(", ")}`);
        }
        databaseParameters = {
            stack: raw.stack,
            values: Object.fromEntries(DATABASE_PARAMETERS.map((key) => [key, raw[key]])) as Record<
                DatabaseParameter,
                string
            >,
        };
    }
    for (const environment of config.environments) {
        if (!config.api || !environment.api) continue;
        new Api(app, environment.api.stackName, {
            config,
            apiConfig: config.api,
            environment,
            api: environment.api,
            buildDir: process.env.API_BUILD_DIR,
            migrateBuildDir: process.env.API_MIGRATE_BUILD_DIR,
            databaseParameters:
                environment.database && databaseParameters?.stack === environment.database.stackName
                    ? databaseParameters.values
                    : undefined,
            maintenance: apiMaintenance === "on",
            env: { region: config.aws.region },
        });
    }
    for (const environment of config.environments) {
        if (!environment.database) continue;
        new Database(app, environment.database.stackName, {
            config,
            environment,
            database: environment.database,
            env: { region: config.aws.region },
        });
    }
    if (config.email) {
        new Email(app, config.email.stackName, {
            config,
            email: config.email,
            env: { region: config.aws.region },
        });
    }

}
