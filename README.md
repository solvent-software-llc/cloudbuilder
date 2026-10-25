# cloudbuilder

A CDK app (`bin/app.ts`) that defines these kinds of stacks:

- `github-oidc-bootstrap` (`src/oidc.ts`) — a one-time, account-wide GitHub
  Actions OIDC provider. Only ever one of these per AWS account.
- a per-client static site stack (`src/static-site.ts`) — S3 bucket, ACM
  certificate, CloudFront distribution (with a URL-rewrite function for
  clean URLs and subdomain routing), and Route53 records. Described by a
  `client.yaml` file and only synthesized when `CONFIG_PATH` is set.
- a per-environment API stack (`src/api.ts`) — a Go Lambda behind an API
  Gateway HTTP API at `api.<environment domain>`, with its own regional
  certificate and Route53 records, plus a maintenance function the route can
  be switched to. Only synthesized when `client.yaml` has an `api:` block
  (normally only the API repo's). See "Deploying an API" and "API maintenance
  mode" below.
- a per-environment database stack (`src/database.ts`) — a publicly
  reachable RDS Postgres instance in its own small VPC, for that
  environment's API. Only synthesized when `client.yaml` has a `database:`
  block, and deployed by hand, never by a workflow. See "API database" below
  and `docs/database.md`.
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
- The target account/region must already be CDK-bootstrapped: `make
  cdk-bootstrap` from a client repo (see "Running cloudbuilder from a client
  repo"), or from a checkout:
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
| `api.migrate`           | no       | Migration package to build, relative to `api.module` (e.g. `./cmd/migrate`). When set, every deploy runs it before updating the API. See "Database migrations". |
| `api.migrate_timeout`   | no       | Migration timeout in seconds, 1–600. Defaults to `300`. Only valid with `api.migrate`. |
| `api.architecture`      | no       | `arm64` (default) or `x86_64`.                                              |
| `api.memory`            | no       | Lambda memory in MB, 128–10240. Defaults to `256`.                          |
| `api.timeout`           | no       | Lambda timeout in seconds, 1–30 (API Gateway's integration cap). Defaults to `10`. |
| `api.stack_name`        | no       | Production's API stack name. Defaults to `<slug>-api`; other environments default to `<slug>-<subdomain>-api`. |
| `api.env`               | no       | Plain env vars for the function. `AWS_`/`LAMBDA_`/`_`-prefixed keys, the Parameters and Secrets extension's `PARAMETERS_SECRETS_EXTENSION_`/`SSM_PARAMETER_STORE_`/`SECRETS_MANAGER_` prefixes, and the stack-set `ALLOWED_ORIGINS`, `ENVIRONMENT`, `API_DOMAIN` are reserved, as are `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_SECRET_ARN` in environments with a database. |
| `api.secrets`           | no       | Map of env var key → SSM `SecureString` parameter **name** (e.g. `/client/api/key`), never a value. The function receives the name as `<KEY>_PARAM` and reads the value at runtime. |
| `database`              | no       | Postgres settings. **Database stacks are synthesized only if this block is present** (use `database: {}` for all defaults). Every environment with an API gets its own RDS instance. Requires `api` with `api.migrate`. See "API database". |
| `database.postgres_version` | no   | Major version only, e.g. `"18"` (the default); RDS picks and upgrades the minor version. |
| `database.instance_class` | no     | RDS instance class. Defaults to `db.t4g.micro`.                             |
| `database.storage`      | no       | Allocated gp3 storage in GB, 20–65536. Defaults to `20`.                    |
| `database.max_storage`  | no       | Storage autoscaling ceiling in GB, at least `storage`. Defaults to `100`.   |
| `database.backup_retention` | no   | Automated backup retention in days, 1–35. Defaults to `7`.                  |
| `database.stack_name`   | no       | Production's database stack name. Defaults to `<slug>-db`; other environments default to `<slug>-<subdomain>-db`. |
| `email`                 | no       | SES sending. **The email stack is synthesized only if this block is present** (use `email: {}` to verify just the domain). One stack per client, shared by every environment; every API function may send from its identities. Requires `api`. See "Sending email". |
| `email.identities`      | no       | List of SES identities to create: `domain` itself (verified with DKIM records added to the hosted zone; covers every address at the domain) and/or email addresses (each verified by a link AWS emails to it). Defaults to `[<domain>]`. Lowercased; no duplicates. |
| `email.stack_name`      | no       | The email stack's name. Defaults to `<slug>-email`.                         |
| `environments`          | yes      | List of `{ name, branch, subdomain?, site?: { stack_name?, bucket_name? }, api?: { enabled?, stack_name?, env?, secrets? }, database?: { enabled?, stack_name?, postgres_version?, instance_class?, storage?, max_storage?, backup_retention? } }`. At most one entry may omit `subdomain`: that's the production/root site. Entries with a `subdomain` serve `<subdomain>.<domain>`. With `site` set, every environment gets its own stack, bucket, and CloudFront distribution; `environments[].site.stack_name`/`bucket_name` default to `site.stack_name`/`site.bucket_name` for production and `<slug>-<subdomain>-site` otherwise. With `api` set, `environments[].api` may set `enabled: false` (no API for that environment), `stack_name`, and `env`/`secrets` (merged over `api.env`/`api.secrets`); no environment may use the `api` subdomain. With `database` set, `environments[].database` may set `enabled: false` (no database for that environment), `stack_name`, and any `database` setting (overriding it); it's an error on an environment without an API. Each `branch`, `subdomain`, stack name, and bucket name must be unique — `branch` is what a deploy workflow run resolves against to pick this environment, and what scopes the GitHub OIDC deploy role's trust policy. V1's `public_env`, `aws.stack_name`, and `aws.bucket_name` are rejected with a pointer to their new location. |
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

## Running cloudbuilder from a client repo

Workflows deploy the site and API stacks. The rest (CDK's bootstrap, the
GitHub OIDC provider, deploy roles, databases) are deployed by hand, from
the client repo itself, with your own AWS credentials and no cloudbuilder
checkout. Each client repo carries a copy of
[`example/Makefile`](example/Makefile) for this. Copy the file rather than
pasting from this page: recipe lines must start with a tab.

Set its variables for the repo:

| Variable | Set to |
|---|---|
| `CLOUDBUILDER_REF` | The same ref the repo's workflows pin (`@v2` / `cloudbuilder-ref: v2`), so a hand deploy runs the same CDK code as CI. |
| `DEPLOY_ROLE_STACK` | This repo's `github-deploy-role-*` stack, as `make stacks` lists it. |
| `DB` | API repo only: production's database stack (`<slug>-db`). |
| `EMAIL` | API repo only, with an `email:` block: the email stack (`<slug>-email`). |
| `AWS_REGION` | Leave as `us-east-1` (the static tier's only region). |

Then run each target with an admin profile for the client's account, e.g.
`AWS_PROFILE=acme-admin make deploy-role`:

| Target | When | What it runs |
|---|---|---|
| `make stacks` | Any time | Lists this client's stacks |
| `make cdk-bootstrap` | Once per AWS account and region | `cdk bootstrap` for the account your credentials point at |
| `make oidc-bootstrap` | Once per AWS account, from any one client repo | Deploys `github-oidc-bootstrap` (see "Account bootstrap") |
| `make deploy-role` | Once per repo, and again after changing `client.yaml`'s environments, stack names, or databases | Deploys this repo's deploy role |
| `make db-diff` / `make db-deploy` | API repo: first setup, then any database change | Diffs/deploys the database stack. `DB=<stack>` picks another environment's, e.g. `make db-deploy DB=acme-preview-db` |
| `make email-diff` / `make email-deploy` | API repo with an `email:` block: first setup, then any identity change | Diffs/deploys the email stack (see "Sending email") |

For a brand-new client account, in order:

1. `make cdk-bootstrap`
2. `make oidc-bootstrap` (skip if the account already has the provider)
3. `make deploy-role` in each client repo, then put its `RoleArn` output in
   that repo's `AWS_ROLE_ARN` variable for the workflows
4. API repo with a database: `make db-diff`, then `make db-deploy`, for each
   environment (see "API database")
5. API repo with an `email:` block: `make email-diff`, then `make email-deploy`
   (see "Sending email")
6. Push, and the workflows deploy the site and API

How it works: each target runs
`npx --allow-git=root github:solvent-software-llc/cloudbuilder#<ref> <cdk
args>`. That runs cloudbuilder's CDK app against the `client.yaml` at the
repo's git root, passing the arguments through to the CDK CLI. Things to
know:

- **`--allow-git=root`:** npm 12 refuses git dependencies by default. This
  opts in for the one package named, not its dependencies.
- **Moved refs:** npx checks the ref again on every run, so a moved `v2`
  tag is picked up next time. To force a clean reinstall, delete
  `"$(npm config get cache)/_npx"`.
- **First run** takes a couple of minutes to install the CDK; later runs
  use npm's cache. Nothing is written to the client repo (`cdk.out` lands
  in the cache).
- **Other commands:** add a target, or run the npx command directly with
  any CDK arguments. `--config <path>` points it at a different
  `client.yaml`.

From a cloudbuilder checkout, `CONFIG_PATH=path/to/client.yaml npx cdk
<command> <stack>` does the same thing.

## Account bootstrap (one-time)

Before onboarding the *first* client in a given AWS account, create the
GitHub Actions OIDC provider once, manually, with an admin-capable
credential (never from a GitHub Actions workflow itself): `make
oidc-bootstrap` from any client repo, or from a checkout:
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
   add it to `github.repos` in `client.yaml`, then deploy its role with
   `make deploy-role` from that repo, or from a checkout:
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

## Deploying an API

An API repo carries its own `client.yaml` (same `slug`, `domain`, `www`,
`aws`, and `environments[].subdomain`s as the site's, plus an `api:` block and
its own `github.repos`) and calls the reusable `api-deploy.yml` workflow:

```yaml
jobs:
  deploy:
    uses: solvent-software-llc/cloudbuilder/.github/workflows/api-deploy.yml@v2
    with:
      aws-role-arn: ${{ vars.AWS_ROLE_ARN }}
      cloudbuilder-ref: v2
```

The workflow resolves the branch to an environment (failing if it sets
`api.enabled: false`), runs `go test ./...` in `api.module` (skip with
`go-test: false`), builds `api.main` into a static `bootstrap` binary for
`api.architecture`, and `cdk deploy`s that environment's API stack with
`API_BUILD_DIR` pointing at the binary. Client repos don't choose build
flags.

Without `API_BUILD_DIR`, API stacks still appear in `cdk ls`/`synth` (using a
placeholder asset) but carry an error annotation, so they can't be deployed by
hand without a build. To deploy one manually:

```
(cd <api module> && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o /tmp/api-build/bootstrap ./cmd/lambda)
CONFIG_PATH=path/to/client.yaml API_BUILD_DIR=/tmp/api-build npx cdk deploy <slug>-api
```

With `api.migrate` set, also build the migration package into its own
directory and pass it as `API_MIGRATE_BUILD_DIR`. With a database, also pass
`API_DATABASE_PARAMETERS` (see "API database").

A hand-run deploy turns maintenance mode **off** unless you also pass
`API_MAINTENANCE=on` (check first with `STACK=<stack> bin/api-maintenance.sh
status`). See below.

## Database migrations

With `api.migrate` set, `api-deploy.yml` builds that package into a second
`bootstrap` binary, and the API stack runs it as a Lambda that CloudFormation
calls during `cdk deploy` (a CDK trigger), **before** it updates the API
function. It gets the same `env`, `secrets`, and `ENVIRONMENT` as the API, so
it reaches the same database.

The binary is an ordinary Lambda handler that applies pending migrations and
returns an error if any fail. It's invoked with an empty payload. For example,
with goose and migrations embedded in the binary:

```go
//go:embed migrations/*.sql
var migrations embed.FS

func handler(ctx context.Context) error {
    db, err := openDB(ctx) // with a cloudbuilder database, see "API database"
    if err != nil {
        return err
    }
    defer db.Close()
    goose.SetBaseFS(migrations)
    if err := goose.SetDialect("postgres"); err != nil {
        return err
    }
    return goose.UpContext(ctx, db, "migrations")
}

func main() { lambda.Start(handler) }
```

How it behaves:

- **When it runs:** on a deploy where the migration binary changed. Embedding
  the migrations means adding one changes the binary. A deploy that changes
  only API code may skip it, which is fine because there's nothing new to
  apply. Migrations must be idempotent (goose and golang-migrate skip
  versions already applied).
- **On failure:** the deploy fails and CloudFormation rolls the stack back,
  so the old API code keeps serving. The schema is **not** rolled back:
  whatever the migration already applied stays.
- **Write migrations the old code can live with:** add columns and tables
  first; drop or rename them in a later deploy, once no running code uses
  them. When a change can't be made compatible, turn on maintenance mode
  (below) before deploying, so no old code serves the new schema.
- **Environments sharing a database:** every environment with an API runs
  its migrations on deploy. If preview and production point at the same
  database, a preview deploy migrates production's schema. A cloudbuilder
  `database:` gives each environment its own instance, so this can't happen.
- **Not on hotswap:** `cdk deploy --hotswap` / `cdk watch` update code without
  going through CloudFormation, so migrations don't run.

Output goes to the stack's `MigrateLogs` log group. A failed run's error also
appears in the CloudFormation events for the `MigrateTrigger` resource.

## API database

With a `database:` block, every environment with an API gets its own RDS
Postgres instance in its own stack (`<slug>-db`, `<slug>-<subdomain>-db`).
The design and its tradeoffs are in `docs/database.md`. In short, the
instance is **publicly reachable**, so the API Lambdas need no VPC or NAT and
can still call Stripe and other outside services. TLS is forced, the API
authenticates with short-lived IAM tokens, and the master password lives in
Secrets Manager. The instance has encrypted storage, automated backups,
deletion protection, and a final snapshot on stack deletion. A `db.t4g.micro`
environment costs about $18/month.

### Setting one up

1. Add `database: {}` (or settings) to the API repo's `client.yaml`, which
   must also set `api.migrate`.
2. `make deploy-role` in the API repo, so its deploy role can read the new
   database's connection parameters.
3. Deploy the database stack **by hand**; workflows never deploy it. From
   the API repo:
   ```
   AWS_PROFILE=<client admin> make db-diff
   AWS_PROFILE=<client admin> make db-deploy
   ```
   That's production's (`DB` in the Makefile). Pass `DB=<stack>` for each
   other environment, e.g. `make db-deploy DB=<slug>-preview-db`. The stack
   publishes `host`, `port`, `resource-id`, and `secret-arn` as SSM
   parameters under `/cloudbuilder/<database stack>/`.
4. Add the first migration below, then deploy the API through
   `api-deploy.yml`. The workflow reads those SSM parameters and passes them
   to the CDK app as `API_DATABASE_PARAMETERS`; if the database stack doesn't
   exist yet, it fails before deploying and names the missing parameters.

For a hand-run API deploy, pass the same JSON yourself:
`API_DATABASE_PARAMETERS='{"stack":"<slug>-db","host":"...","port":"5432","resource-id":"db-...","secret-arn":"arn:..."}'`.

### What the API and migrations get

| | API function | Migration function |
|---|---|---|
| Env vars | `DB_HOST`, `DB_PORT`, `DB_NAME` (`app`), `DB_USER` (`app`) | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SECRET_ARN` |
| Connects as | `app`, with an IAM auth token | `postgres` (master), with the password from the secret |
| Permission | `rds-db:connect` for `app` on this instance only | `secretsmanager:GetSecretValue` on this secret only |

The API's `app` role can read and write data but not change the schema;
migrations own it. Only SQL can create that role, so **the first migration
must**:

```sql
CREATE ROLE app WITH LOGIN;
GRANT rds_iam TO app;
GRANT USAGE ON SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app;
```

`ALTER DEFAULT PRIVILEGES` covers tables the master user creates later, so
later migrations don't need their own grants.

### Connecting from Go

Every connection uses TLS, verified against the RDS CA bundle
(`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`), which
isn't in the system trust store, so embed it. The API mints an IAM token for
each new connection (tokens expire after 15 minutes; open connections stay
up), with pgx and `github.com/aws/aws-sdk-go-v2/feature/rds/auth`:

```go
//go:embed global-bundle.pem
var rdsCABundle []byte

func newPool(ctx context.Context) (*pgxpool.Pool, error) {
    awsCfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return nil, err
    }
    host, port, user := os.Getenv("DB_HOST"), os.Getenv("DB_PORT"), os.Getenv("DB_USER")
    cfg, err := pgxpool.ParseConfig(fmt.Sprintf(
        "host=%s port=%s dbname=%s user=%s sslmode=verify-full",
        host, port, os.Getenv("DB_NAME"), user))
    if err != nil {
        return nil, err
    }
    roots := x509.NewCertPool()
    roots.AppendCertsFromPEM(rdsCABundle)
    cfg.ConnConfig.TLSConfig.RootCAs = roots
    // Each Lambda instance handles one request at a time.
    cfg.MaxConns = 2
    cfg.BeforeConnect = func(ctx context.Context, cc *pgx.ConnConfig) error {
        token, err := auth.BuildAuthToken(ctx, host+":"+port, awsCfg.Region, user, awsCfg.Credentials)
        if err != nil {
            return err
        }
        cc.Password = token
        return nil
    }
    return pgxpool.NewWithConfig(ctx, cfg)
}
```

Migrations read the master password through the Parameters and Secrets
extension already attached to the function, then connect the same way
(`stdlib.OpenDB(*cfg)` gives goose its `*sql.DB`):

```go
req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
    "http://localhost:2773/secretsmanager/get?secretId="+url.QueryEscape(os.Getenv("DB_SECRET_ARN")), nil)
req.Header.Set("X-Aws-Parameters-Secrets-Token", os.Getenv("AWS_SESSION_TOKEN"))
// The response's SecretString is JSON with "username" and "password".
```

### Connecting by hand

The endpoint and secret ARN are the database stack's `Endpoint` and
`SecretArn` outputs:

```
aws secretsmanager get-secret-value --secret-id <SecretArn> --query SecretString --output text
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
psql "host=<Endpoint> port=5432 dbname=app user=postgres sslmode=verify-full sslrootcert=global-bundle.pem"
```

### Changing or removing a database

Edit `client.yaml`, then `make db-diff` and `make db-deploy` (with
`DB=<stack>` for a non-production environment). Read the diff first, since
some changes (e.g. a storage *decrease*) aren't possible in place. Deleting the stack fails until deletion protection is turned off
on the instance, and even then leaves a final snapshot.

## Sending email

With an `email:` block, the API repo gets one `<slug>-email` stack of SES
identities, and every environment's API function may send from them
(`ses:SendEmail` and `ses:SendRawEmail` on those identities only; the
migration and maintenance functions get nothing).

```yaml
email:
  identities:            # optional; defaults to [<domain>]
    - example.com        # any address @example.com can send
    - you@gmail.com      # e.g. a test recipient while in the sandbox
```

### Setting it up

1. Add the block to the API repo's `client.yaml`.
2. Deploy the email stack **by hand**; workflows never deploy it:
   ```
   AWS_PROFILE=<client admin> make email-diff
   AWS_PROFILE=<client admin> make email-deploy
   ```
3. Verify the identities. The domain verifies itself: the stack adds its
   three DKIM CNAME records to the hosted zone, and SES picks them up
   (usually within minutes, up to 72 hours). Each address gets an email from
   AWS with a link that has to be clicked. Check with
   `aws sesv2 get-email-identity --email-identity <identity>`.
4. Deploy the API (push). Its permission is built from the identity names,
   so it doesn't depend on the email stack, but sending fails until the
   identity is verified.

The API sends with the SES v2 `SendEmail` call in the stack's region. Its
From address must be at a verified domain identity (any address
`@example.com`) or be a verified address identity exactly.

### The SES sandbox

A new account starts in the SES sandbox: it can only send **to** verified
identities, at most 200 emails a day. While testing, list your own address
under `identities` so it's verified and covered by the API's permission.
Leaving the sandbox is an account-level request AWS reviews (usually within
a day), so it isn't part of any stack:

```
aws sesv2 put-account-details --production-access-enabled \
  --mail-type TRANSACTIONAL --website-url https://example.com \
  --use-case-description "Account emails (welcome, password reset) for example.com users" \
  --contact-language EN
```

### Limitations

- An identity that already exists in the account (e.g. created in the
  console) makes `email-deploy` fail; delete it there first, or leave it
  out of `identities`.
- Removing an identity from the list deletes it on the next `email-deploy`,
  and sending from it stops.
- Only the client's own `domain` can be a domain identity: its DKIM records
  go in `aws.hosted_zone_id`. Subdomains and other domains aren't supported.
- DMARC and a custom MAIL FROM domain aren't managed. Gmail and Yahoo
  require DMARC for bulk senders; add a `_dmarc.<domain>` TXT record by hand
  if you need one (cloudbuilder doesn't create it, since many domains
  already have one and a second would conflict).

## API maintenance mode

Every API stack also deploys a small maintenance function. Maintenance mode
points the API's `$default` route at it instead of the Go function, so every
request to `api.<domain>` gets the maintenance response. The site itself keeps
loading from CloudFront; only its API calls are affected.

### The maintenance response

Clients (the site, the mobile app) should treat this as "we'll be right back",
not as a generic error:

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
Cache-Control: no-store
Retry-After: 60
Access-Control-Allow-Origin: <the requesting site origin, if allowed>
Access-Control-Allow-Credentials: true
Access-Control-Expose-Headers: Retry-After

{"maintenance": true}
```

- Detect it by the `{"maintenance": true}` body, not the 503 alone: other
  failures can also be 503s.
- CORS preflights (`OPTIONS`) are answered with `204` and the usual CORS
  headers for allowed origins, so a browser's real request still goes out and
  receives the 503 instead of failing as a network error.
- While in maintenance, every route returns this, including a health
  endpoint, so a client can poll any cheap endpoint every `Retry-After`
  seconds (plus some jitter) and resume when it stops getting it.

### Switching it on and off

The API repo adds a manual workflow calling `api-maintenance.yml`:

```yaml
name: API maintenance
on:
  workflow_dispatch:
    inputs:
      state:
        type: choice
        options: ["on", "off"]
jobs:
  maintenance:
    uses: solvent-software-llc/cloudbuilder/.github/workflows/api-maintenance.yml@v2
    with:
      aws-role-arn: ${{ vars.AWS_ROLE_ARN }}
      cloudbuilder-ref: v2
      state: ${{ inputs.state }}
```

Run it from the branch of the environment to switch (e.g. `main` for
production): the branch picks the environment, the same way it does for
`api-deploy.yml`, and must be one of `environments[].branch` for the deploy
role to trust the run. The switch takes effect within seconds; no `cdk
deploy` is involved.

`api-deploy.yml` reads the current state before deploying and keeps it, so
**deploys never turn maintenance on or off** — only this workflow does. A
deploy made while maintenance is on finishes with a warning saying so.

Typical uses:

- **Shipping code and a schema change together:** turn maintenance on,
  deploy, check the new code directly (below), turn maintenance off.
- **A major bug:** turn maintenance on immediately, deploy fixes as many times
  as needed, check, turn maintenance off.

### Checking the new code while in maintenance

`api.<domain>` only returns the maintenance response while maintenance is on,
so call the function directly with your own AWS credentials. `FunctionName` is
an API stack output. Adjust the event to whatever your Go adapter requires:

```
aws lambda invoke --function-name <FunctionName> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"version":"2.0","routeKey":"$default","rawPath":"/healthz","rawQueryString":"","headers":{},"requestContext":{"http":{"method":"GET","path":"/healthz"}},"isBase64Encoded":false}' \
  /dev/stdout
```

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
CONFIG_PATH=path/to/client.yaml npx cdk synth <slug>-db              # render a database template
```
