import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import { Config } from "./config";

export interface EmailProps extends cdk.StackProps {
    config: Config;
    email: NonNullable<Config["email"]>;
}

// The ARN IAM uses for an SES identity. Built from the name rather than
// imported from this stack, so an API stack can grant sending without
// depending on the email stack (sends just fail until it's deployed and the
// identity verified).
export function emailIdentityArn(stack: cdk.Stack, name: string): string {
    return stack.formatArn({ service: "ses", resource: "identity", resourceName: name });
}

// One per client: the SES identities its API functions send from. Identities
// are account-wide, so per-environment stacks would collide on the same
// domain. Deployed by hand, like the database stacks, because identities
// rarely change and deleting one stops all sending from it. See README's
// "Sending email".
export class Email extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EmailProps) {
        super(scope, id, props);

        const { config, email } = props;
        const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config.aws.hostedZoneId,
            zoneName: config.domain,
        });

        for (const identity of email.identities) {
            // The name, not the list position, is the construct id, so
            // reordering identities never replaces one.
            new ses.EmailIdentity(this, `Identity ${identity.name}`, {
                identity:
                    identity.kind === "domain"
                        ? // Easy DKIM: CDK adds the three DKIM CNAMEs to the
                          // zone, and SES verifies the domain once they resolve.
                          ses.Identity.publicHostedZone(zone)
                        : // SES emails the address a link; it's verified once
                          // someone clicks it.
                          ses.Identity.email(identity.name),
            });
        }

        new cdk.CfnOutput(this, "Identities", {
            value: email.identities.map((identity) => identity.name).join(","),
        });
    }
}
