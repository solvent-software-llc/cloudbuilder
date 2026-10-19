# cloudbuilder — API database design notes

Decisions for adding a Postgres database behind the V2 API stacks. Read
alongside `docs/v2-redesign.md`, `README.md`, and `CLAUDE.md`. Same guiding
principle: solo-engineer project, optimize for simplicity and low fixed cost.

## Decision 1: publicly reachable RDS, Lambdas stay outside any VPC

A Lambda in a VPC loses internet access unless the VPC has NAT, and the API
will need to reach Stripe and other third-party services. A managed NAT
gateway costs about $33/month per AZ before data — more than the database.

So the database is reachable from the internet, and access is protected by
authentication and TLS instead of network isolation, the same model hosted
Postgres providers (Neon, Supabase, Crunchy Bridge) use by default:

- RDS instance in a public subnet, `publiclyAccessible: true`. Its security
  group allows 5432 from anywhere: Lambda's outbound IPs aren't predictable,
  so an allow-list isn't possible.
- TLS required (`rds.force_ssl = 1`, set explicitly even though it's the
  default from Postgres 15 on).
- The API authenticates with **IAM database authentication**: the function's
  role mints a 15-minute token per new connection, so there is no app
  password to leak or brute-force.
- The master password is generated at deploy time and kept in Secrets
  Manager. Only migrations and humans use it.
- Port stays 5432. Changing it only reduces scanner noise.

The Lambdas keep free internet egress, and the API stacks need no network
plumbing (no subnet or security group ids).

Rejected:

- **Private RDS + managed NAT gateway:** ~$33+/month per AZ.
- **Private RDS + fck-nat** (NAT on a `t4g.nano`): ~$7/month, but an instance
  to patch, a single point of failure for egress, a third-party construct, and
  all the VPC plumbing. The fallback if a public database is ever ruled out
  (e.g. a compliance requirement): `publiclyAccessible` can be turned off in
  place, and the Lambdas move into the VPC behind fck-nat or NAT.
- **VPC endpoints only:** reach AWS services but not Stripe.
- **Splitting work between a VPC and a non-VPC Lambda:** invoking one from the
  other needs a Lambda VPC endpoint (~$7/month per AZ) and awkward plumbing.
- **IPv6-only egress** (free egress-only internet gateway): only works if
  every destination supports IPv6, which can't be assumed.
- **Aurora Serverless v2 + Data API** (no VPC needed): Go would talk to
  Postgres over an HTTP API instead of a driver, so `database/sql`, pgx, and
  goose don't work.

## Decision 2: one instance per environment, in its own stack

Each environment with an API gets its own RDS instance in its own stack,
`<slug>-db` for production and `<slug>-<subdomain>-db` otherwise (mirroring the
API stacks' naming, overridable).

- **Own instance:** a preview deploy can never migrate production's schema
  (the shared-database hazard in README's "Database migrations"), and preview
  load can't slow production. Rejected: one shared instance with a logical
  database per environment — cheaper, but it needs a custom resource to create
  each database and role, and loses that isolation.
- **Own stack, separate from the API stack:** API stacks deploy on every push.
  A stateful resource shouldn't share a stack with them, where a construct
  change could force a replacement. Database stacks are deployed by hand
  (`cdk deploy <slug>-db`), like the account bootstrap, so changes to them are
  deliberate. That's a convention enforced by which workflows exist, not by
  IAM: no cloudbuilder workflow deploys a database stack, but the GitHub
  deploy role could. `cdk deploy` makes its CloudFormation calls through the
  CDK bootstrap deploy role, which the default bootstrap lets act on any
  stack, so leaving database stacks out of the GitHub role's CloudFormation
  statement doesn't stop it (see CLAUDE.md, "The deploy role's IAM scoping is
  weaker than it looks"). Enforcing it would need a narrower custom bootstrap
  per account. What protects the data if a database stack is deployed by
  mistake: deletion protection blocks deleting the instance, and a
  replacement leaves a snapshot. A forced replacement could still create a
  new, empty instance and repoint the API at it.
- **Own VPC:** RDS must live in a VPC with a subnet group spanning two AZs.
  Each database stack creates a small VPC with public subnets only (no NAT;
  VPCs and internet gateways are free). Rejected: the account's default VPC,
  which needs a synth-time `Vpc.fromLookup` and would break synthesizing
  without AWS credentials (see CLAUDE.md, "Verifying changes without touching
  AWS").

## Decision 3: single-AZ for now

No Multi-AZ, including production, for now. It roughly doubles the instance
cost and buys automatic failover. Turning it on later is an in-place
modification (a `client.yaml` setting, then a database stack deploy).

## Instance settings

- **Engine:** Postgres 18 (major version only, so RDS applies minor versions
  with `autoMinorVersionUpgrade`). Configurable.
- **Size:** `db.t4g.micro` by default, configurable per environment.
- **Storage:** gp3, 20 GB, autoscaling up to 100 GB by default; encrypted.
- **Backups:** automated, 7-day retention by default (point-in-time recovery
  within that window). These are the disaster plan for a bad migration.
- **Protection:** `deletionProtection: true` and removal policy `SNAPSHOT`, so
  deleting the stack fails until protection is turned off by hand, and even
  then leaves a final snapshot.
- **Master credentials:** a CDK-generated Secrets Manager secret
  (`Credentials.fromGeneratedSecret`), which also records host, port, and
  database name. Encrypted with the AWS-managed key, so readers need no KMS
  grant. No rotation for now.
- **Database name:** `app`. One instance per environment means it never needs
  to vary.
- **Performance Insights:** on, free 7-day tier.

Approximate cost per environment (us-east-1, on-demand): `db.t4g.micro`
~$12/month, 20 GB gp3 ~$2.30, public IPv4 ~$3.65, backups free up to the
database's size. About **$18/month**; `db.t4g.small` is about $30.

## Wiring the API stacks to the database

The database stack publishes what the API stack needs as SSM parameters
under `/cloudbuilder/<database stack name>/`: `host`, `port`, `resource-id`
(the `DbiResourceId`, for IAM auth), and `secret-arn`.

`api-deploy.yml` reads them as the GitHub deploy role (which gets
`ssm:GetParameters` on exactly those paths) and passes them into the CDK app
as `API_DATABASE_PARAMETERS`, JSON tagged with the database stack's name.
`bin/app.ts` hands them only to the API stack whose environment owns that
database. Without them, that API stack carries an error annotation, like a
missing `API_BUILD_DIR`. Synth keeps working offline, and only that stack
refuses to deploy.

Rejected:

- **Resolving the parameters in CloudFormation**
  (`ssm.StringParameter.valueForStringParameter`), the original plan.
  CloudFormation evaluates SSM parameter types as the caller, which under
  `cdk deploy` is the CDK bootstrap deploy role. The default bootstrap
  template lets that role read only CDK's own version parameter, so the
  deploy would fail. Widening it means a custom bootstrap per account.
- **`ssm.StringParameter.valueFromLookup`:** a synth-time context lookup.
  It would make synthesizing *any* stack in the API repo's config need AWS
  credentials.
- **A custom resource reading SSM:** it only re-reads when its own inputs
  change, so a changed host could be missed.
- **CloudFormation cross-stack exports:** an export can't change while
  another stack imports it, and the two stacks are deployed separately (by
  hand and by `api-deploy.yml`), so exports would make database changes
  painful.

The API function gets:

- `DB_HOST`, `DB_PORT`, `DB_NAME` (`app`), `DB_USER` (`app`).
- `rds-db:connect` on
  `arn:aws:rds-db:<region>:<account>:dbuser:<resource-id>/app`.
- It builds an IAM auth token per new connection (e.g. pgx's `BeforeConnect`
  hook with `github.com/aws/aws-sdk-go-v2/feature/rds/auth`'s
  `BuildAuthToken`) and connects with `sslmode=verify-full`.

The migration function gets `DB_HOST`, `DB_PORT`, `DB_NAME`, and
`DB_SECRET_ARN`, plus `secretsmanager:GetSecretValue` on that secret. It reads
the master credentials through the Parameters and Secrets extension the API
stack already attaches.

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_SECRET_ARN` become
reserved env keys in `client.yaml`.

### Who creates the `app` user

IAM auth needs a Postgres role granted `rds_iam`, and only SQL can create it.
The migrations do it, running as the master user. The client's first
migration:

```sql
CREATE ROLE app WITH LOGIN;
GRANT rds_iam TO app;
GRANT USAGE ON SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app;
```

This gives the API a role that can read and write data but not change the
schema, while migrations own it. Because the API can't connect without this
role, `database` requires `api.migrate`, and config validation enforces it.

Rejected: a custom resource that creates the user when the database stack
deploys. It would need a Postgres client bundled into a Lambda inside
cloudbuilder, for one statement the migration can run.

## Deploy order

1. `cdk deploy <slug>-db` (by hand). Creates the instance and SSM parameters.
2. Deploy the API through `api-deploy.yml`. Its migration creates the `app`
   role, then the API function updates.

If the database stack doesn't exist yet, `api-deploy.yml` fails before
deploying, naming the missing SSM parameters. That's the intended guard.

## `client.yaml`

One optional top-level `database:` block, with per-environment overrides
under `environments[].database`. If `database:` is present, every environment
with an API gets a database unless it sets `database.enabled: false`.
Requires `api:` with `api.migrate`.

```yaml
database:
  postgres_version: "18"         # default
  instance_class: db.t4g.micro   # default
  storage: 20                    # GB, default
  max_storage: 100               # GB, autoscaling ceiling, default
  backup_retention: 7            # days, 1–35, default
environments:
  - name: production
    branch: main
    database:
      instance_class: db.t4g.small
      backup_retention: 14
  - name: preview
    subdomain: preview
    branch: dev
```

## Getting into the database

Connect from a laptop with `psql` and the master secret
(`aws secretsmanager get-secret-value`), using `sslmode=verify-full` and the
RDS CA bundle. A public endpoint makes this simple; no bastion is needed.

## Build plan

1. `config.ts`: parse `database:`, derived stack names, validation (requires
   `api.migrate`, reserved `DB_*` keys), tests.
2. `src/database.ts` + `bin/app.ts`: the per-environment database stack (VPC,
   security group, parameter group, instance, secret, SSM parameters).
   Verify by synth.
3. `src/api.ts`: env vars, `rds-db:connect`, and secret read for migrations,
   from the SSM parameters `api-deploy.yml` reads.
4. README (schema, deploy order, connecting, Go snippet) and CLAUDE.md.

## Open questions

- **Secret rotation:** not built. Turning on Secrets Manager rotation for the
  master secret later is self-contained (only migrations use it).
- **Restore runbook:** point-in-time restore creates a *new* instance outside
  CloudFormation. Document how to cut over (or restore in place via
  snapshot plus stack changes) before relying on it.
