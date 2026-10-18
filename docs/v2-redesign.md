# cloudbuilder V2 — design notes

Decisions from a design discussion about adding a Lambda API alongside the
static sites cloudbuilder deploys, and about reworking the static-site stack.
Read alongside `README.md` and `CLAUDE.md`. Solo-engineer project: optimize
for simplicity over team decoupling.

## Decision 1: one bucket + one CloudFront distribution per environment

V1 serves every environment (production, preview, ...) from one bucket and one
distribution, routing subdomains to key prefixes. That requires
`UrlRewriteFunction`'s `PREFIX_BY_HOST` map, the `X-Env-Prefix` header, the
`ForwardEnvPrefixHeader` origin request policy, and the
`ErrorPagePrefixFunction` Lambda@Edge (see CLAUDE.md for why each exists).

V2 gives each environment its own bucket and distribution, and its own stack.
Consequences:

- Remove: `PREFIX_BY_HOST` / prefix logic, `X-Env-Prefix`,
  `ForwardEnvPrefixHeader`, `ErrorPagePrefixFunction` (Lambda@Edge).
- Keep: the clean-URL part of `UrlRewriteFunction` (`/` → `index.html`,
  extensionless → `.html`).
- Keep: `errorResponses` mapping 403 and 404 → `/404.html` with a 404 status.
  Each bucket's `404.html` is at its root, so this now just works. A branded
  404 page with a real 404 status is a hard requirement.
- The deploy workflow's S3 sync no longer needs a key prefix; it targets the
  environment's own bucket.
- The `www`-on-subdomain hazard largely goes away (no host→prefix map to fall
  through), but `www` should still only apply to production.

## Decision 2: the API gets its own hostname, NOT a `/api/*` behavior

Considered and rejected: putting the API behind each site distribution at
`/api/*` for same-origin cookies. Problem: CloudFront `errorResponses` are
distribution-wide, so the API's own 403/404 responses would be replaced by the
site's HTML 404 page. Workarounds were an origin-response Lambda@Edge on the S3
behavior only, or a public S3 website endpoint — both rejected.

Deciding factor: a mobile app is planned, and it needs a direct API hostname
regardless. So:

- API is served at `api.<env-domain>` per environment, e.g. `api.example.com`,
  `api.preview.example.com`, via an API Gateway (HTTP API) custom domain.
- Site distributions stay API-agnostic; the static-site stack doesn't know an
  API exists.
- New per-environment API stack (e.g. `src/api.ts`): Lambda, HTTP API, regional
  ACM cert, API Gateway custom domain, Route53 alias record in the existing
  hosted zone. Everything is in `us-east-1` already.
- Wire `api` settings through `client.yaml` (optional section), following the
  existing config pattern in `src/config.ts` with tests in `config.test.ts`.

## Decision 3: auth across web and mobile

Existing API auth: short-TTL stateless access token in a header; longer-lived
stateful refresh token in an HttpOnly cookie.

Web (browser, cross-origin to the API host):

- CORS on the API: allow exact site origins (no wildcard), `allowCredentials:
  true`, set `maxAge` so preflights are cached. Implement CORS **in the Lambda,
  not API Gateway's CORS config**: HTTP API CORS applies to the whole API and
  can't exclude routes, which would contradict keeping mobile routes off the
  allow-list (below). The API stack derives the allowed origins (the
  environment's site domain, plus `www.` for production) and passes them in
  as an `ALLOWED_ORIGINS` env var. They never appear in `client.yaml`.
- Refresh cookie: host-only (NO `Domain` attribute) so it's scoped to
  `api.<env-domain>` exactly. Do not use `Domain=example.com` — that would share
  production sessions with preview and every other subdomain. Site and API are
  same-site, so this is not a third-party cookie and `SameSite=Lax` works.
- Scope the cookie's `Path` to the web refresh route.

Mobile: same token system, different transport for the refresh token.

- Mobile login returns the refresh token in the JSON body; the app stores it in
  iOS Keychain / Android Keystore-backed storage.
- Separate routes: `/auth/web/refresh` reads the refresh token ONLY from the
  cookie; `/auth/mobile/refresh` reads it ONLY from the request body and returns
  a rotated refresh token in the body. The mobile route must never fall back to
  the cookie, or XSS could convert an unreadable cookie into a readable
  long-lived token.
- Leave mobile endpoints out of the CORS allow-list (native apps ignore CORS;
  browsers then can't read responses from them).
- Don't gate mobile endpoints on `User-Agent` or a hardcoded client ID —
  spoofable. Possession of a valid token is the boundary. Platform attestation
  (App Attest / Play Integrity) only if abuse ever demands it.
- Refresh-token rotation with reuse detection (reuse → revoke the session).
- Record client type (web / ios / android) on the session.
- If social or hosted login is added later, native apps use the system browser
  with OAuth + PKCE (RFC 8252), not an embedded webview.

## Deploy role and workflows

- `github-deploy-role.ts` scopes its `CloudFormation` statement to
  `config.aws.stackName`; V2's per-environment site stacks and the API stacks
  need to be covered. Per CLAUDE.md, actual resource creation runs as the CDK
  cfn-exec role, so this plus existing asset publishing should be sufficient.
- Add an API deploy reusable workflow alongside `static-site-deploy.yml` so the
  API deploys independently of the site. Treat workflow input changes as
  breaking for pinned client repos (tag deliberately).
- For fast dev iteration on Lambda code: `cdk watch` / `cdk deploy --hotswap`
  (dev only — it intentionally drifts from the template).

## Migration

- Changing construct logical IDs forces replacement (see CLAUDE.md's cutover
  notes). Production content already sits at the bucket root, so if V2 keeps
  production's stack name and construct IDs identical to V1, production may be
  an in-place update that just removes the prefix/edge machinery. Confirm with
  `cdk diff` against the live stack first.
- Subdomain environments (preview, ...) get new stacks and new buckets — a real
  cutover: deploy, sync content in the same sitting, verify, then clean up.
- Order matters: update production's stack **first**. It still owns the
  preview hostname's Route53 records and CloudFront alias, and a second
  distribution can't claim an alias another one holds (`CNAMEAlreadyExists`),
  nor can a second stack create the same record. Preview is down between the
  production update and the preview stack's first deploy.
- Production's ACM cert loses its subdomain SANs, which is a cert replacement.
  CloudFormation creates and validates the new cert before swapping it onto
  the distribution, so this shouldn't cause downtime, but expect it in
  `cdk diff`.
- Old preview content under `preview/` in production's bucket is orphaned
  after cutover. Delete it manually once the new preview stack is verified.
- Lambda@Edge replicas take hours to clear after detaching; removing
  `ErrorPagePrefixFunction` may make a stack update/delete fail the first time.
  Wait and retry.

## Carried-over constraints

- Bucket names must not contain dots (OAC + HTTPS wildcard cert matching).
  Per-environment bucket names need an explicit hyphenated naming scheme.
- ACM certs for CloudFront must be in `us-east-1`.
- Verify with `CONFIG_PATH=... npx cdk synth <stack> --no-staging` (no AWS
  credentials needed) and grep the template's `Aliases`,
  `SubjectAlternativeNames`, and Route53 `Name` fields.

## Resolved

- **Coexistence:** main becomes V2. The existing `v1` tag stays frozen for
  pinned client repos (cut a `release/v1` branch from it only if a V1 fix is
  ever needed). Tag `v2` once V2 is ready.
- **Site is explicit:** site stacks are synthesized only when `client.yaml`
  has a top-level `site:` block (`site: {}` for all defaults). Site-only
  settings live under it: `site.stack_name`, `site.bucket_name`,
  `site.public_env`, and per-environment `environments[].site.*`. V1's
  `public_env` / `aws.stack_name` / `aws.bucket_name` are rejected with a
  "moved to" error, so a stale config fails loudly instead of deploying with
  default names. `www` stays top-level because the API's CORS origins need it
  too. The `api:` block will gate API stacks the same way.
- **Per-environment names:** derived, with optional overrides.
  `environments[].site.stack_name` / `bucket_name` win if set. Otherwise
  production falls back to `site.stack_name` / `site.bucket_name` (V1's
  `aws.*` values, moved, with the same V1 defaults), so it can be updated in
  place. Every other environment defaults
  to `<slug>-<subdomain>-site` for both. Names derive from `subdomain`, not
  `name`, because `name` may contain spaces. Production's OAC and
  URL-rewrite function keep V1's physical names (`<slug>-oac`,
  `<slug>-url-rewrite`); other environments get `<slug>-<subdomain>-...`.

- **API language/runtime:** Go on `provided.al2023`, `arm64` by default. The
  deployed artifact is a static binary named `bootstrap`.
- **Bundling:** the API deploy workflow builds the binary. It runs
  `actions/setup-go` with `go-version-file: <module>/go.mod`, then
  `CGO_ENABLED=0 GOOS=linux GOARCH=<arch> go build -tags lambda.norpc -o
  <staging>/bootstrap <main>`. The API stack uses
  `lambda.Code.fromAsset(<staging>)`. cloudbuilder owns the build flags, so
  client repos can't get them wrong. Rejected: `GoFunction`
  (`@aws-cdk/aws-lambda-go-alpha`), which is an alpha module and would make
  every `cdk synth` need Go or Docker. Also rejected: client-owned builds,
  where every client would reimplement the flags and `bootstrap` naming. One
  binary serves every environment; environments differ only in env vars and
  secrets.
- **API settings in `client.yaml`:** one optional top-level `api:` block, with
  optional per-environment overrides under `environments[].api`. If `api:` is
  present, every environment gets an API unless it sets `api.enabled: false`.
  Per-environment `env`/`secrets` merge over the shared ones. Hostname
  (`api.<env-domain>`), stack name (`<slug>-api` for production,
  `<slug>-<subdomain>-api` otherwise, overridable), and CORS origins are
  derived. Runtime and handler are fixed, so they aren't settings.

  ```yaml
  api:
    module: api               # dir containing go.mod, relative to the repo root
    main: ./cmd/lambda        # package to build, relative to module (default)
    architecture: arm64       # default; x86_64 allowed
    memory: 256
    timeout: 10
    env:
      LOG_LEVEL: info
    secrets:                  # SSM parameter names, never values
      TOKEN_SIGNING_KEY: /solvent/api/token-key
  environments:
    - name: production
      branch: main
      api:
        env: { LOG_LEVEL: warn }
    - name: preview
      subdomain: preview
      branch: dev
      api:
        enabled: false
  ```

- **API repo:** the API lives in its own repo, separate from the site. It
  has more consumers than the site (the mobile app, possibly others) and its
  own release cadence. That repo carries its own `client.yaml` with `slug`,
  `domain`, `www`, `aws`, `environments`, and `api`, and its `github.repos`
  lists the API repo, which gives it its own deploy role. Rejected: a monorepo
  with path-filtered workflows (couples the API to one consumer's repo), and a
  third shared-config repo (one more moving part).
  - The site and API domains always match, so the API repo's `environments[]`
    declares the same `subdomain`s, and the same `www`, as the site's. CORS
    origins stay derived from them, and there's no `allowed_origins` setting.
  - `environments[].branch` is the API repo's own branch and may differ from
    the site's. Only the hostnames must match.
  - The cost is duplication between the two `client.yaml`s (`slug`, `domain`,
    `www`, `aws.*`, `environments[].subdomain`). If they drift, the API's
    CORS allow-list silently stops matching a real site host. A drift check
    (e.g. the API workflow comparing against the site repo's `client.yaml`)
    is a possible later addition, not built.

- **Secrets:** read at runtime, not resolved at deploy time. `api.secrets`
  holds SSM parameter names; the function gets each as `<KEY>_PARAM` and
  fetches the value through the AWS Parameters and Secrets Lambda Extension
  (5-minute cache). Values never appear in the CloudFormation template or the
  Lambda console. The function's role gets `ssm:GetParameter` on exactly those
  parameters; `aws/ssm`-encrypted SecureStrings need no extra KMS grant.

## Open questions

- None currently.
