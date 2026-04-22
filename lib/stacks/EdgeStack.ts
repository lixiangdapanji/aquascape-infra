import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, BlockPublicAccess, BucketEncryption } from "aws-cdk-lib/aws-s3";
import {
  Distribution,
  ViewerProtocolPolicy,
  CachePolicy,
  PriceClass,
  HttpVersion,
  AllowedMethods,
  CachedMethods,
  OriginProtocolPolicy,
  OriginRequestPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin, LoadBalancerV2Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone, ARecord, AaaaRecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";

export interface EdgeStackProps extends StackProps {
  envName: "dev" | "stage" | "prod";
  domainName: string; // apex, e.g. efferves.live
  subdomain?: string; // "dev" | "stage" | undefined (for prod/apex)
}

/**
 * Edge layer: static assets bucket, CloudFront distribution, Route53 records,
 * ACM certificate. App-specific behaviors (ALB origin for Next.js SSR) are
 * added by AppStack via distribution.addBehavior().
 */
export class EdgeStack extends Stack {
  readonly siteBucket: Bucket;
  readonly distribution: Distribution;
  readonly hostedZone: HostedZone;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const fqdn = props.subdomain
      ? `${props.subdomain}.${props.domainName}`
      : props.domainName;

    this.hostedZone = HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    }) as HostedZone;

    const cert = new Certificate(this, "Cert", {
      domainName: fqdn,
      subjectAlternativeNames:
        props.envName === "prod" ? [`www.${props.domainName}`] : undefined,
      validation: CertificateValidation.fromDns(this.hostedZone),
    });

    this.siteBucket = new Bucket(this, "SiteBucket", {
      bucketName: `aquascape-studio-site-${props.envName}-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: props.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: props.envName !== "prod",
    });

    this.distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
      },
      domainNames: props.envName === "prod"
        ? [fqdn, `www.${props.domainName}`]
        : [fqdn],
      certificate: cert,
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultRootObject: "index.html",
      enableLogging: props.envName === "prod",
    });

    new ARecord(this, "AliasA", {
      zone: this.hostedZone,
      recordName: fqdn,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });
    new AaaaRecord(this, "AliasAAAA", {
      zone: this.hostedZone,
      recordName: fqdn,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });

    if (props.envName === "prod") {
      new ARecord(this, "WwwAliasA", {
        zone: this.hostedZone,
        recordName: `www.${props.domainName}`,
        target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      });
    }

    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "DomainName", { value: fqdn });
    new CfnOutput(this, "SiteBucketName", { value: this.siteBucket.bucketName });
  }
}
