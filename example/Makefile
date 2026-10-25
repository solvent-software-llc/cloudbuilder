# The cloudbuilder stacks deployed by hand, run from this client repo with
# your own credentials for the client's AWS account:
#
#   AWS_PROFILE=<client admin> make deploy-role
#
# Workflows deploy the site and API stacks; these are the rest. See
# cloudbuilder's README, "Running cloudbuilder from a client repo".

# Keep in step with the @v2 / cloudbuilder-ref in .github/workflows.
CLOUDBUILDER_REF ?= v2
# The static tier is us-east-1 only (cloudbuilder's CLAUDE.md).
AWS_REGION ?= us-east-1
# This repo's deploy-role stack, as `make stacks` lists it.
DEPLOY_ROLE_STACK ?= github-deploy-role-solvent-software-example-site
# The database stack for db-diff/db-deploy (API repo only). Production's by
# default; pass another, e.g. `make db-deploy DB=solvent-software-preview-db`.
DB ?= solvent-software-db
# The email stack for email-diff/email-deploy (API repo only, with an email:
# block). One per client, shared by every environment.
EMAIL ?= solvent-software-email

CLOUDBUILDER ?= npx -y --allow-git=root github:solvent-software-llc/cloudbuilder\#$(CLOUDBUILDER_REF)

.PHONY: stacks cdk-bootstrap oidc-bootstrap deploy-role db-diff db-deploy email-diff email-deploy

# List this client's stacks.
stacks:
	$(CLOUDBUILDER) ls

# Once per AWS account and region: CDK's bootstrap stack, in whichever
# account your credentials point at.
cdk-bootstrap:
	$(CLOUDBUILDER) bootstrap aws://$$(aws sts get-caller-identity --query Account --output text)/$(AWS_REGION)

# Once per AWS account: GitHub Actions' OIDC provider. Check first that the
# account doesn't already have one (cloudbuilder's CLAUDE.md).
oidc-bootstrap:
	$(CLOUDBUILDER) deploy github-oidc-bootstrap

# This repo's deploy role. Rerun after changing client.yaml's environments,
# stack names, or databases.
deploy-role:
	$(CLOUDBUILDER) deploy $(DEPLOY_ROLE_STACK)

# API repo only. Always review the diff first: the stack holds the data.
db-diff:
	$(CLOUDBUILDER) diff $(DB)

db-deploy:
	$(CLOUDBUILDER) deploy $(DB)

# API repo only. Removing an identity from client.yaml deletes it, which stops
# all sending from it.
email-diff:
	$(CLOUDBUILDER) diff $(EMAIL)

email-deploy:
	$(CLOUDBUILDER) deploy $(EMAIL)
