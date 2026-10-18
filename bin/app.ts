#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GithubOidc } from "../src/oidc";
import { StaticSite } from "../src/static-site";
import { GithubDeployRole } from "../src/github-deploy-role";
import { Api } from "../src/api";
import { load } from "../src/config";

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
    for (const environment of config.environments) {
        if (!config.api || !environment.api) continue;
        new Api(app, environment.api.stackName, {
            config,
            apiConfig: config.api,
            environment,
            api: environment.api,
            buildDir: process.env.API_BUILD_DIR,
            env: { region: config.aws.region },
        });
    }

}
