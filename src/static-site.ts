import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Config, Environment } from "./config";

export interface StaticSiteProps extends cdk.StackProps {
    config: Config;
    environment: Environment;
    site: NonNullable<Environment["site"]>;
}

// One stack, bucket, and distribution per environment. Construct ids and
// production's physical names (OAC, function) deliberately match V1's single
// shared stack, so a V1 production stack can be updated in place rather than
// replaced — see docs/v2-redesign.md's migration notes before renaming any.
export class StaticSite extends cdk.Stack {
    constructor(scope: Construct, id: string, props: StaticSiteProps) {
        super(scope, id, props);

        const { config, environment, site } = props;
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config.aws.hostedZoneId,
            zoneName: config.domain,
        });

        // Physical names must be unique per account; production keeps V1's.
        const namePrefix = environment.subdomain
            ? `${config.slug}-${environment.subdomain}`
            : config.slug;

        // www only ever applies to production — nobody links to
        // www.<subdomain>.<domain>, and it would still become a real record,
        // cert SAN, and alias.
        const www = config.www && !environment.subdomain;
        const domains = www
            ? [`www.${environment.domain}`, environment.domain]
            : [environment.domain];

        const bucket = new s3.Bucket(this, "SiteBucket", {
            bucketName: site.bucketName,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [
                {
                    id: "ExpireImmutableAssets",
                    prefix: "_app/immutable/",
                    expiration: cdk.Duration.days(30),
                },
                {
                    id: "ExpireNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
                {
                    id: "AbortIncompleteUploads",
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                },
            ],
        });

        const certificate = new acm.Certificate(this, "SiteCertificate", {
            domainName: environment.domain,
            subjectAlternativeNames: www ? [`www.${environment.domain}`] : [],
            validation: acm.CertificateValidation.fromDnsMultiZone(
                Object.fromEntries(domains.map((domain) => [domain, zone])),
            ),
        });

        const oac = new cloudfront.CfnOriginAccessControl(this, "CloudFrontOAC", {
            originAccessControlConfig: {
                name: `${namePrefix}-oac`,
                originAccessControlOriginType: "s3",
                signingBehavior: "always",
                signingProtocol: "sigv4",
            },
        });

        const rewriteFn = new cloudfront.Function(this, "UrlRewriteFunction", {
            functionName: `${namePrefix}-url-rewrite`,
            comment: "Rewrites clean URLs to .html",
            code: cloudfront.FunctionCode.fromInline(`
                function handler(event) {
                    var request = event.request;
                    var uri = request.uri;

                    if (uri.endsWith('/')) {
                        uri += 'index.html'
                    } else if (!uri.includes('.')) {
                        uri += '.html';
                    }

                    request.uri = uri;
                    return request;
                }
            `),
        });

        const distribution = new cloudfront.Distribution(
            this,
            "CloudFrontDistribution",
            {
                comment: `${config.slug} ${environment.name} static site`,
                domainNames: domains,
                certificate,
                defaultRootObject: "index.html",
                httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
                enableIpv6: true,
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
                defaultBehavior: {
                    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
                        originAccessControlId: oac.attrId,
                    }),
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    responseHeadersPolicy:
                        cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
                    functionAssociations: [
                        {
                            function: rewriteFn,
                            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                        },
                    ],
                },
                // Each environment's 404.html is at its own bucket's root, so the
                // error-page fetch (which skips UrlRewriteFunction) just works.
                errorResponses: [
                    {
                        httpStatus: 404,
                        responseHttpStatus: 404,
                        responsePagePath: "/404.html",
                        ttl: cdk.Duration.seconds(10),
                    },
                    {
                        httpStatus: 403,
                        responseHttpStatus: 404,
                        responsePagePath: "/404.html",
                        ttl: cdk.Duration.seconds(10),
                    },
                ],
            },
        );

        const dnsTarget = route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(distribution),
        );
        // Record ids are derived from the environment name, as in V1, so
        // production's records keep their logical ids across the migration.
        const recordId =
            environment.name.charAt(0).toUpperCase() + environment.name.slice(1);
        new route53.ARecord(this, `${recordId}Record`, {
            zone,
            recordName: environment.domain,
            target: dnsTarget,
        });
        new route53.AaaaRecord(this, `${recordId}RecordIpv6`, {
            zone,
            recordName: environment.domain,
            target: dnsTarget,
        });
        if (www) {
            new route53.ARecord(this, `${recordId}WwwRecord`, {
                zone,
                recordName: `www.${environment.domain}`,
                target: dnsTarget,
            });
            new route53.AaaaRecord(this, `${recordId}WwwRecordIpv6`, {
                zone,
                recordName: `www.${environment.domain}`,
                target: dnsTarget,
            });
        }

        new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
        new cdk.CfnOutput(this, "DistributionId", {
            value: distribution.distributionId,
        });
        new cdk.CfnOutput(this, "SiteUrl", { value: `https://${environment.domain}` });
    }
}
