import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Config, EmailSuppressionReason, SES_REVIEW_PERCENT } from "./config";

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

// The ARN IAM uses for a configuration set, built from its name for the same
// reason as emailIdentityArn.
export function emailConfigurationSetArn(stack: cdk.Stack, name: string): string {
    return stack.formatArn({ service: "ses", resource: "configuration-set", resourceName: name });
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

        // The identities' default, so apps get suppression without naming it
        // in each send.
        const configurationSet =
            email.configurationSet &&
            new ses.ConfigurationSet(this, "ConfigurationSet", {
                configurationSetName: email.configurationSet.name,
                suppressionReasons: suppressionReasons(email.configurationSet.suppress),
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
                configurationSet,
            });
        }

        if (email.alarms) {
            // SNS emails each address a confirmation link; nothing reaches it
            // until someone clicks it.
            const topic = new sns.Topic(this, "Alarms", {
                displayName: `${config.name ?? config.slug} email alarms`,
            });
            for (const address of email.alarms.notify) {
                topic.addSubscription(new snsSubscriptions.EmailSubscription(address));
            }
            const action = new cloudwatchActions.SnsAction(topic);

            // Account-wide rates SES publishes once the account sends. No data
            // means nothing was sent, which isn't a problem.
            const reputationAlarm = (id: string, metricName: string, percent: number, what: "bounce" | "complaint") => {
                const alarm = new cloudwatch.Alarm(this, id, {
                    alarmName: `${this.stackName}-${what}-rate`,
                    alarmDescription: `The SES ${what} rate is at least ${percent}% (SES reviews accounts at ${SES_REVIEW_PERCENT[what]}%). See cloudbuilder's README, "Bounces and complaints".`,
                    metric: new cloudwatch.Metric({
                        namespace: "AWS/SES",
                        metricName,
                        statistic: cloudwatch.Stats.MAXIMUM,
                        period: cdk.Duration.hours(1),
                    }),
                    threshold: percent / 100,
                    evaluationPeriods: 1,
                    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
                });
                alarm.addAlarmAction(action);
                alarm.addOkAction(action);
            };
            reputationAlarm("BounceRateAlarm", "Reputation.BounceRate", email.alarms.bouncePercent, "bounce");
            reputationAlarm("ComplaintRateAlarm", "Reputation.ComplaintRate", email.alarms.complaintPercent, "complaint");
        }

        new cdk.CfnOutput(this, "Identities", {
            value: email.identities.map((identity) => identity.name).join(","),
        });
    }
}

function suppressionReasons(reasons: EmailSuppressionReason[]): ses.SuppressionReasons {
    if (reasons.length === 2) return ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS;
    return reasons[0] === "bounce" ? ses.SuppressionReasons.BOUNCES_ONLY : ses.SuppressionReasons.COMPLAINTS_ONLY;
}
