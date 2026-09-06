# CLAUDE.md

Guidance for working in this repo. See `README.md` first for the `client.yaml`
schema and the onboarding/update runbook — this file is about things that
aren't obvious from reading the source.

## What this replaces

Client static sites used to be provisioned from hand-written CloudFormation in
a separate `workflows` repo (`templates/static-site.yaml`, checked out into
`.solvent/` by a reusable GitHub Actions workflow). `cloudbuilder` replaces
that template with CDK (`src/static-site.ts`) for new clients.

**Migrating an *existing* client onto cloudbuilder is not an in-place
`cdk deploy` over its old stack.** CDK's logical IDs don't match the
hand-written template's, so deploying under the old stack name would try to
replace the bucket, cert, and distribution. Since S3 bucket names are
globally exclusive to one bucket, the new stack can't even reuse the old
bucket name while the old stack still owns it. The only path is a genuine
cutover: a new stack name, a new bucket name, `cdk deploy` (which also
creates the Route53 alias records immediately, so DNS flips to the new,
still-empty bucket the moment the stack finishes — sync content in the same
sitting), verify, then delete the old CFN stack. Do not attempt a resource
import as a shortcut unless you've actually diffed the synthesized template
against the existing physical resources' properties — CDK's L2 constructs
don't necessarily produce props byte-identical to the old template, and
`cdk import` will force replacement on any mismatch anyway.

## Hard-won constraints

**One GitHub OIDC provider per URL per AWS account, and it may predate this
repo.** `github-oidc-bootstrap` (`src/oidc.ts`) creates the
`token.actions.githubusercontent.com` provider and exports its ARN as
`github-actions-oidc-provider-arn`. If the target account already has this
provider from *any* stack — including the old `workflows` repo's
`bootstrap-github-oidc.yaml`, which creates the identical provider under the
identical export name — deploying `github-oidc-bootstrap` here will fail
(IAM rejects a second provider for the same URL; CloudFormation rejects a
duplicate export name). Check for an existing provider/export in the target
account before deploying this stack. `github-deploy-role.ts` imports the
export by name, so it works unmodified against either bootstrap stack.

**Stack ids/names must not contain dots, but repo names often do.**
`bin/app.ts` builds each `github-deploy-role-*` stack's id from the GitHub
repo name (e.g. `solventsoftware.com` — a very ordinary repo-naming
convention for a site). CloudFormation stack names must match
`/^[A-Za-z][A-Za-z0-9-]*$/`, so the id is sanitized (dots etc. replaced with
`-`) before being passed to the `Stack` constructor. The *unsanitized*
`repoName` still flows into the OIDC trust policy's `sub` condition and the
IAM role name (both accept dots, and the trust policy must match GitHub's
claim exactly) — don't sanitize those.

**`www` must never apply to a subdomain environment.** In
`config.environments`, only the entry with no `subdomain` is the root/production
site — entries with a `subdomain` (preview, staging, ...) get `www` treatment
too if you're not careful, e.g. `www.preview.<domain>`. Nobody links to that
host, but it still becomes a real Route53 record, an ACM cert SAN, *and* a
CloudFront alias — and the URL-rewrite function's `PREFIX_BY_HOST` map only
ever keys on the bare subdomain host, so an unrewritten `www.<subdomain>`
alias silently falls through and serves **production** content under a
preview-looking URL. `static-site.ts` guards both the domain-list
construction and the Route53-record loop with `!environment.subdomain` —
keep that guard if you touch either loop.

**Bucket names must not contain dots.** CloudFront's OAC connects to the S3
REST endpoint over HTTPS; a bucket name with dots in it can defeat the
wildcard cert matching on `*.s3.<region>.amazonaws.com`. `config.ts`'s
default bucket name (`${domain}-site`) still has this problem since domains
contain dots — always set `aws.bucket_name` explicitly to a hyphenated name
in `client.yaml` rather than relying on the default.

**The static tier is us-east-1 only.** ACM certs for CloudFront must be
requested in `us-east-1` regardless of where the rest of the client's
infrastructure lives (see README's known limitation about cross-region
certs).

## The deploy role's IAM scoping is weaker than it looks — by design, for now

`github-deploy-role.ts`'s policy is written per-service and per-resource (a
specific bucket ARN, a specific hosted zone ARN, ...), reading like real
least-privilege. It mostly isn't, for anything that goes through `cdk
deploy`: CloudFormation doesn't execute a changeset as the caller. `cdk
deploy` passes `--role-arn` pointing at the CDK bootstrap's
`cdk-<qualifier>-cfn-exec-role-<account>-<region>`, and CloudFormation
assumes *that* role to actually create/update/delete resources — and that
role carries **`AdministratorAccess`** by default (this is standard CDK
bootstrap behavior, not something this repo configured). The `PassCfnExecRole`
Sid is what makes this possible; without it, `cdk deploy` fails outright
(confirmed against a real account — see the deploy log this comment refers
to in git history).

Practical effect: everything else in this policy — `S3Site`, `CloudFront`,
`ACM`, `Route53`, `CloudFormation` — still genuinely gates this role's own
*direct* API calls (the deploy workflow's S3 sync and CloudFront invalidation
steps run as this role, no PassRole involved). But it does **not** gate what
`cdk deploy` itself can create or change — that runs as the admin exec role,
account-wide. The real security boundary for infrastructure changes is "which
GitHub repo/branch can assume this deploy role at all" (the OIDC trust
policy's `sub` condition), not the resource-scoped Sids.

This was a deliberate, explicit tradeoff (see the repo's commit history around
the first live deploy) to unblock shipping now rather than build a narrower
alternative first. That alternative, if it's ever worth the cost: bootstrap
the account/region with a custom `--cloudformation-execution-policies` (a
purpose-built managed policy scoped to S3/CloudFront/ACM/Route53/
CloudFormation, no admin) instead of accepting CDK's default. That's a
different bootstrap per account, more to maintain, and hasn't been built —
don't assume it exists.

## Verifying changes without touching AWS

`CONFIG_PATH=path/to/client.yaml npx cdk synth <stack-name> --no-staging`
works with **no AWS credentials** — `HostedZone.fromHostedZoneAttributes`
and `Certificate.fromDnsMultiZone` both take explicit attributes rather than
doing a lookup. This is the fast way to catch exactly the kind of bugs
described above (stray domains/SANs/aliases, invalid stack names) before
ever running `cdk deploy` or `cdk diff` against a real account — diff the
synthesized template's `Aliases`, `SubjectAlternativeNames`, and Route53
`Name` fields against what you expect. `npm test` only covers `config.ts`'s
YAML parsing (`config.test.ts`) — there's no test coverage of what
`static-site.ts` actually synthesizes, which is exactly how the `www`/
subdomain bug above went unnoticed. Prefer a synth-and-grep check like this
over just reading the construct code when changing `static-site.ts`.

## GitHub Actions integration

This repo hosts the reusable deploy pipeline as
`.github/workflows/static-site-deploy.yml` (`workflow_call`), mirroring the
old `workflows` repo's consumer model: a client repo's own workflow is a thin
wrapper —
```yaml
jobs:
  deploy:
    uses: solvent-software-llc/cloudbuilder/.github/workflows/static-site-deploy.yml@v1
    with:
      aws-role-arn: ${{ vars.AWS_ROLE_ARN }}
```
The called workflow resolves `GITHUB_JOB_WORKFLOW_REF` to see which ref the
caller pinned, then checks this repo out again at that same ref into
`.cloudbuilder/` — so the CDK code that actually runs `cdk deploy` is always
the version the caller asked for, not whatever `main` happens to be. It then
builds the client's site, resolves a `branch` input (defaulting to the
triggering branch) against `client.yaml`'s `environments[].branch` — via
`bin/resolve-env.ts`, calling straight into `config.ts`'s `resolveEnvironment`
rather than re-parsing the YAML with `yq` — to pick the stack name/region and
the target environment's key prefix/domain, failing fast if no environment
declares that branch. It then runs `cdk deploy` with `--outputs-file`, and
does a two-pass S3 sync (immutable assets first, no `--delete`; then
everything else, with `--delete`, scoped to the resolved environment's key
prefix) plus a CloudFront invalidation. One workflow file covers every
environment now — a client repo no longer needs a separate `preview.yml`
wrapper with a hardcoded `deploy-target: preview`; adding a new environment
is a `client.yaml` edit, not a new workflow.

Changing this workflow's inputs/behavior is a breaking-change concern for
every client repo that pins a ref to it, same as the old `workflows` repo —
tag deliberately, don't silently retag `v1` under a contract change.

There is currently no equivalent `static-site-validate.yml` (a no-AWS-writes
version for PR checks) — client repos still relying on the old
`workflows`-repo validator will find it rejects `client.yaml`'s current
schema (no `tier`, restructured `environments`) the first time it's actually
exercised.
