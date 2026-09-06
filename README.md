# cloudbuilder

A CDK app (`bin/app.ts`) that defines three kinds of stacks:

- `github-oidc-bootstrap` (`src/oidc.ts`) — a one-time, account-wide GitHub
  Actions OIDC provider. Only ever one of these per AWS account.
- a per-client static site stack (`src/static-site.ts`) — S3 bucket, ACM
  certificate, CloudFront distribution (with a URL-rewrite function for
  clean URLs and subdomain routing), and Route53 records. Described by a
  `client.yaml` file and only synthesized when `CONFIG_PATH` is set.
- a per-repo GitHub deploy-role stack (`src/github-deploy-role.ts`) — an
  IAM role a client's GitHub Actions workflow can assume via the OIDC
  provider to deploy that client's site stack. One is synthesized per
  entry in `client.yaml`'s `github.repos` list.

Because the app can contain multiple stacks at once, `cdk` commands must
name the stack to act on explicitly — running e.g. `cdk deploy` with no
stack name and `CONFIG_PATH` set will refuse to run and list the available
stacks instead of deploying all of them.

The per-client and per-repo stacks are re-deployable — running `cdk deploy`
again after editing `client.yaml` (or the CDK source) updates the existing
stack rather than creating a new one.

## Prerequisites

- Node.js and npm installed, dependencies installed via `npm install`.
- AWS credentials for the client's target account active in your shell
  (e.g. via `AWS_PROFILE` or exported env vars), with permissions to manage
  S3, CloudFront, ACM, Route53, and (for the one-time bootstrap only) IAM.
- The target account/region must already be CDK-bootstrapped:
  ```
  npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
  ```
- An existing Route53 hosted zone for the client's domain, and its
  hosted zone ID.

## `client.yaml` schema

| Key                     | Required | Description                                                                 |
|-------------------------|----------|-------------------------------------------------------------------------------|
| `slug`                  | yes      | Lowercase, hyphenated identifier (3-32 chars). Used to name AWS resources.  |
| `domain`                | yes      | Root domain, e.g. `example.com`.                                            |
| `name`                  | no       | Human-readable client name.                                                 |
| `www`                   | no       | Also provision `www.<domain>` (and per-environment `www.` subdomains). Defaults to `true`. |
| `public_env`            | no       | Map of `PUBLIC_`-prefixed build-time env vars (e.g. for SvelteKit).         |
| `aws.region`            | yes      | AWS region the stack is deployed to.                                       |
| `aws.hosted_zone_id`    | yes      | Route53 hosted zone ID for `domain`.                                        |
| `aws.stack_name`        | no       | CloudFormation stack name. Defaults to `<slug>-site`.                       |
| `aws.bucket_name`       | no       | S3 bucket name. Defaults to `<domain>-site`.                                |
| `environments`          | yes      | List of `{ name, branch, subdomain? }`. One entry with no `subdomain` is the production/root site; entries with a `subdomain` are routed to `<subdomain>.<domain>` and served from the `/<subdomain>` prefix in the bucket. Each `branch` must be unique — it's what a deploy workflow run resolves against to pick this environment, and what scopes the GitHub OIDC deploy role's trust policy. |
| `github.org`            | no*      | GitHub org/user the client's repos live under. Required if `github` is set. |
| `github.repos`          | no       | List of repo names allowed to deploy this client's site. One `github-deploy-role-<slug>-<repo>` stack is synthesized per entry. Defaults to `[]`. |

See `example/client.yaml` for a working example.

> **Known limitation:** the ACM certificate is created in `aws.region`, but
> CloudFront requires certificates to live in `us-east-1`. Until this is
> fixed, set `aws.region: us-east-1` in every `client.yaml`.

## Account bootstrap (one-time)

Before onboarding the *first* client in a given AWS account, create the
GitHub Actions OIDC provider once, manually, with an admin-capable
credential (never from a GitHub Actions workflow itself):
```
npx cdk deploy github-oidc-bootstrap
```
No `client.yaml` or `CONFIG_PATH` is needed for this — it's account-wide,
not per-client. Its output `OIDCProviderArn` (also exported as
`github-actions-oidc-provider-arn`) is what per-project deploy-role stacks
should reference in their trust policy. Any such role's trust policy must
still scope its `token.actions.githubusercontent.com:sub` condition to the
specific repo/branch that should be allowed to assume it — this stack only
establishes that AWS will accept GitHub's tokens at all.

## Onboarding a new client

1. Create a hosted zone for the client's domain in Route53 (or confirm one
   already exists) and note its hosted zone ID.
2. Write a `client.yaml` for the client (copy `example/client.yaml` as a
   starting point).
3. Confirm the target AWS account/region is bootstrapped (see
   Prerequisites) and that the account bootstrap above has already been run.
4. Preview the changes:
   ```
   CONFIG_PATH=path/to/client.yaml npx cdk diff <stack-name>
   ```
5. Deploy:
   ```
   CONFIG_PATH=path/to/client.yaml npx cdk deploy <stack-name>
   ```
   `<stack-name>` is `aws.stack_name` from `client.yaml` (or `<slug>-site`
   if unset) — required because with `CONFIG_PATH` set the app contains
   both this stack and `github-oidc-bootstrap`, so `cdk` refuses to guess
   which one you mean.
   This creates the S3 bucket, requests and DNS-validates the ACM
   certificate, creates the CloudFront distribution, and creates the
   Route53 A/AAAA records. Certificate validation can take several minutes.
6. Note the stack outputs — `BucketName`, `DistributionId`, `SiteUrl` — and
   wire them into the client's site-build pipeline (uploading built assets
   to the bucket and invalidating the CloudFront distribution after each
   deploy is outside the scope of this repo).
7. For each GitHub repo that should be able to deploy this client's site,
   add it to `github.repos` in `client.yaml`, then deploy its role:
   ```
   CONFIG_PATH=path/to/client.yaml npx cdk deploy github-deploy-role-<slug>-<repo>
   ```
   This creates an IAM role (`github-deploy-<slug>-<repo>`) that
   `github.org/<repo>`'s GitHub Actions workflow can assume via OIDC —
   scoped to pushes to exactly the branches listed in `environments[].branch`,
   and permitted to manage only this client's CloudFormation stack, S3
   bucket, and Route53 hosted zone (CloudFront and ACM cannot be scoped to a
   single resource; see the comments in `src/github-deploy-role.ts`). Note
   the `RoleArn` output and put it in that repo's deploy workflow.

## Updating an existing client

Edit the client's `client.yaml` (e.g. to add a new environment/subdomain,
toggle `www`, change `public_env`) and re-run:
```
CONFIG_PATH=path/to/client.yaml npx cdk diff <stack-name>
CONFIG_PATH=path/to/client.yaml npx cdk deploy <stack-name>
```
`cdk deploy` diffs against the currently deployed stack and only updates
what changed.

## Development

```
npm test                                                             # run config parsing tests
npx cdk synth github-oidc-bootstrap                                  # render the bootstrap template
CONFIG_PATH=path/to/client.yaml npx cdk synth <stack-name>           # render a client's site template
CONFIG_PATH=path/to/client.yaml npx cdk synth github-deploy-role-<slug>-<repo>  # render a deploy-role template
```
