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
| `www`                   | no       | Also provision `www.<domain>` for the production environment (never for subdomain environments). Defaults to `true`. |
| `aws.region`            | yes      | AWS region the stack is deployed to.                                       |
| `aws.hosted_zone_id`    | yes      | Route53 hosted zone ID for `domain`.                                        |
| `site`                  | no       | Static-site settings. **Site stacks are synthesized only if this block is present** (use `site: {}` for all defaults) — an API repo's `client.yaml` omits it. |
| `site.stack_name`       | no       | Production's CloudFormation stack name. Defaults to `<slug>-site`.          |
| `site.bucket_name`      | no       | Production's S3 bucket name. Defaults to `<domain>-site` — which contains dots, so always set this explicitly (see CLAUDE.md). |
| `site.public_env`       | no       | Map of `PUBLIC_`-prefixed build-time env vars (e.g. for SvelteKit).         |
| `api`                   | no       | Go API settings. **API stacks are synthesized only if this block is present** — normally only in the API repo's `client.yaml`. Each enabled environment gets an API at `api.<environment domain>`. |
| `api.module`            | yes*     | Directory containing `go.mod`, relative to the repo root. Required if `api` is set. |
| `api.main`              | no       | Package to build, relative to `api.module`. Defaults to `./cmd/lambda`.     |
| `api.architecture`      | no       | `arm64` (default) or `x86_64`.                                              |
| `api.memory`            | no       | Lambda memory in MB, 128–10240. Defaults to `256`.                          |
| `api.timeout`           | no       | Lambda timeout in seconds, 1–30 (API Gateway's integration cap). Defaults to `10`. |
| `api.stack_name`        | no       | Production's API stack name. Defaults to `<slug>-api`; other environments default to `<slug>-<subdomain>-api`. |
| `api.env`               | no       | Plain env vars for the function. `AWS_`/`LAMBDA_`/`_`-prefixed keys, the Parameters and Secrets extension's `PARAMETERS_SECRETS_EXTENSION_`/`SSM_PARAMETER_STORE_`/`SECRETS_MANAGER_` prefixes, and the stack-set `ALLOWED_ORIGINS`, `ENVIRONMENT`, `API_DOMAIN` are reserved. |
| `api.secrets`           | no       | Map of env var key → SSM `SecureString` parameter **name** (e.g. `/client/api/key`), never a value. The function receives the name as `<KEY>_PARAM` and reads the value at runtime. |
| `environments`          | yes      | List of `{ name, branch, subdomain?, site?: { stack_name?, bucket_name? }, api?: { enabled?, stack_name?, env?, secrets? } }`. At most one entry may omit `subdomain`: that's the production/root site. Entries with a `subdomain` serve `<subdomain>.<domain>`. With `site` set, every environment gets its own stack, bucket, and CloudFront distribution; `environments[].site.stack_name`/`bucket_name` default to `site.stack_name`/`site.bucket_name` for production and `<slug>-<subdomain>-site` otherwise. With `api` set, `environments[].api` may set `enabled: false` (no API for that environment), `stack_name`, and `env`/`secrets` (merged over `api.env`/`api.secrets`); no environment may use the `api` subdomain. Each `branch`, `subdomain`, stack name, and bucket name must be unique — `branch` is what a deploy workflow run resolves against to pick this environment, and what scopes the GitHub OIDC deploy role's trust policy. V1's `public_env`, `aws.stack_name`, and `aws.bucket_name` are rejected with a pointer to their new location. |
| `github.org`            | no*      | GitHub org/user the client's repos live under. Required if `github` is set. |
| `github.repos`          | no       | List of repo names allowed to deploy this client's site. One `github-deploy-role-<slug>-<repo>` stack is synthesized per entry. Defaults to `[]`. |

See `example/client.yaml` for a working example.

## Request flow

Each environment has its own stack, bucket, and CloudFront distribution, so
a request only ever touches that environment's resources:

1. **Viewer request → `UrlRewriteFunction`** (CloudFront Function,
   `viewer-request`). Appends `index.html` to a trailing-slash URI or
   `.html` to an extensionless one (`/about` → `/about.html`).
2. **Cache lookup** (`CachePolicy.CACHING_OPTIMIZED`). A miss forwards to
   the origin.
3. **S3 origin (via OAC).** Found → 200. Not found → S3 returns 403
   (`BlockPublicAccess.BLOCK_ALL` + OAC).
4. **Error response.** The distribution's `errorResponses` map 403 and 404
   to `/404.html`, returned as a real 404. That internal fetch skips
   `UrlRewriteFunction`, which is fine: every environment's `404.html` sits
   at its own bucket's root.

V1 served every environment from one shared bucket under key prefixes,
which needed a host→prefix map, an `X-Env-Prefix` header, an
`OriginRequestPolicy`, and a Lambda@Edge function to get step 4 right. See
`docs/v2-redesign.md`.

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
   `<stack-name>` is the target environment's stack (see `environments` above;
   `CONFIG_PATH=... npx cdk ls` lists them all). It's required because with
   `CONFIG_PATH` set the app contains one stack per environment plus
   `github-oidc-bootstrap`, so `cdk` refuses to guess which one you mean.
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
