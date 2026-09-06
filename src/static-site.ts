import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Config } from "./config";

export interface StaticSiteProps extends cdk.StackProps {
    config: Config;
}

export class StaticSite extends cdk.Stack {
    constructor(scope: Construct, id: string, props: StaticSiteProps) {
        super(scope, id, props);

        const { config } = props;
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config.aws.hostedZoneId,
            zoneName: config.domain,
        });

        const domains: string[] = [];
        const nonRootDomains: string[] = [];
        for (const environment of config.environments) {
            const domain = environment.subdomain
                ? `${environment.subdomain}.${config.domain}`
                : config.domain;
            // www only ever applies to the root domain — a subdomain environment
            // (preview, staging, ...) has no reason to answer on www.<subdomain>.<domain>,
            // and the rewrite function's PREFIX_BY_HOST map only knows the bare host,
            // so an unrewritten www variant would silently fall through to production.
            if (config.www && !environment.subdomain) {
                domains.push(`www.${domain}`);
                nonRootDomains.push(`www.${domain}`);
            }
            domains.push(domain);
            if (environment.subdomain) {
                nonRootDomains.push(domain);
            }
        }

        const bucket = new s3.Bucket(this, "SiteBucket", {
            bucketName: config.aws.bucketName,
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
            domainName: config.domain,
            subjectAlternativeNames: nonRootDomains,
            validation: acm.CertificateValidation.fromDnsMultiZone(
                Object.fromEntries(domains.map((domain) => [domain, zone])),
            ),
        });

        const oac = new cloudfront.CfnOriginAccessControl(this, "CloudFrontOAC", {
            originAccessControlConfig: {
                name: `${config.slug}-oac`,
                originAccessControlOriginType: "s3",
                signingBehavior: "always",
                signingProtocol: "sigv4",
            },
        });

        const prefixByHost: Record<string, string> = {};
        for (const environment of config.environments) {
            if (!environment.subdomain) continue;
            prefixByHost[`${environment.subdomain}.${config.domain}`] =
                `/${environment.subdomain}`;
        }
        const rewriteFn = new cloudfront.Function(this, "UrlRewriteFunction", {
            functionName: `${config.slug}-url-rewrite`,
            comment:
                "Rewrites clean URLS to .html; routes subdomains to their prefix",
            code: cloudfront.FunctionCode.fromInline(`
                var PREFIX_BY_HOST = ${JSON.stringify(prefixByHost)};
                function handler(event) {
                    var request = event.request;
                    var uri = request.uri;
                    
                    if (uri.endsWith('/')) {
                        uri += 'index.html'
                    } else if (!uri.includes('.')) {
                        uri += '.html';
                    }

                    var host = request.headers.host && request.headers.host.value;
                    var prefix = PREFIX_BY_HOST[host];
                    if (prefix) {
                        uri = prefix + uri;
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
                comment: `${config.slug} static site`,
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
        for (const environment of config.environments) {
            const domain = environment.subdomain
                ? `${environment.subdomain}.${config.domain}`
                : config.domain;
            const id =
                environment.name.charAt(0).toUpperCase() + environment.name.slice(1);

            new route53.ARecord(this, `${id}Record`, {
                zone,
                recordName: domain,
                target: dnsTarget,
            });
            new route53.AaaaRecord(this, `${id}RecordIpv6`, {
                zone,
                recordName: domain,
                target: dnsTarget,
            });

            if (config.www && !environment.subdomain) {
                new route53.ARecord(this, `${id}WwwRecord`, {
                    zone,
                    recordName: `www.${domain}`,
                    target: dnsTarget,
                });
                new route53.AaaaRecord(this, `${id}WwwRecordIpv6`, {
                    zone,
                    recordName: `www.${domain}`,
                    target: dnsTarget,
                });
            }
        }

        new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
        new cdk.CfnOutput(this, "DistributionId", {
            value: distribution.distributionId,
        });
        new cdk.CfnOutput(this, "SiteUrl", { value: `https://${config.domain}` });
    }
}
