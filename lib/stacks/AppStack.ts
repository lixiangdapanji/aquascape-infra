import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  AllowedMethods,
  CachePolicy,
  OriginRequestPolicy,
  OriginProtocolPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { LoadBalancerV2Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { IVpc, Peer, Port, SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  FargateService,
  FargateTaskDefinition,
  ContainerImage,
  LogDriver,
  Protocol as EcsProtocol,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
  ListenerAction,
  ListenerCondition,
  HttpCodeTarget,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Table, AttributeType, BillingMode, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess, BucketEncryption, HttpMethods } from "aws-cdk-lib/aws-s3";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  MathExpression,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Budget } from "./Budget";

export interface AppStackProps extends StackProps {
  envName: "dev" | "stage" | "prod";
  domainName: string;
  vpc: IVpc;
  distribution: Distribution;
}

/**
 * App-tier: ECS Fargate cluster with THREE services behind one ALB.
 *
 *   web  (Next.js, :3000)        →  /          → CloudFront default pattern
 *   api  (Rust/tonic gRPC, :50051) → /grpc/*   → CloudFront HTTP/2 through
 *   sim  (Python gRPC, :50052)    (no public path — internal only)
 *
 * Only web and api are fronted by the ALB. Sim is reached internally over
 * Cloud Map service discovery (aquascape-sim.aquascape.local:50052) so the
 * api→sim hop never leaves the VPC.
 *
 * Storage:
 *   - DynamoDB: Scapes (pk/sk + GSI byOwner), Species (cache, read-heavy).
 *   - S3: user-uploaded reference images with lifecycle to Glacier @ 90d.
 *
 * CloudFront rewrites handled in EdgeStack; this stack only adds behaviors.
 */
export class AppStack extends Stack {
  readonly cluster: Cluster;
  readonly webService: FargateService;
  readonly apiService: FargateService;
  readonly simService: FargateService;
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly opsTopic: Topic;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const isProd = props.envName === "prod";

    // ---- Cluster ----
    this.cluster = new Cluster(this, "Cluster", {
      clusterName: `aquascape-${props.envName}`,
      vpc: props.vpc,
      containerInsights: isProd,
      // Cloud Map namespace for internal service discovery (api → sim).
      defaultCloudMapNamespace: {
        name: "aquascape.local",
      },
    });

    // ---- ECR repos (one per deployable service) ----
    const mkRepo = (name: string) =>
      new Repository(this, `Repo-${name}`, {
        repositoryName: `aquascape-${name}-${props.envName}`,
        imageTagMutability: TagMutability.IMMUTABLE,
        lifecycleRules: [{ maxImageCount: 20 }],
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });
    const webRepo = mkRepo("web");
    const apiRepo = mkRepo("api");
    const simRepo = mkRepo("sim");

    // ---- DynamoDB ----
    const scapesTable = new Table(this, "ScapesTable", {
      tableName: `aquascape-scapes-${props.envName}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    scapesTable.addGlobalSecondaryIndex({
      indexName: "byOwner",
      partitionKey: { name: "owner_user_id", type: AttributeType.STRING },
      sortKey: { name: "pk", type: AttributeType.STRING },
    });

    const speciesTable = new Table(this, "SpeciesTable", {
      tableName: `aquascape-species-${props.envName}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ---- S3: uploads ----
    const uploads = new Bucket(this, "UploadsBucket", {
      bucketName: `aquascape-uploads-${props.envName}-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: "transition-archive",
          transitions: [
            { storageClass: { value: "GLACIER" } as never, transitionAfter: Duration.days(90) },
          ],
          enabled: true,
        },
      ],
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.POST],
          allowedOrigins: ["*"], // tightened in Phase 3
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ---- Cost guardrail + ops topic ----
    new Budget(this, "Budget", {
      envName: props.envName,
      monthlyLimitUsd: isProd ? 600 : 150,
      notifyEmail: "chengxiaopusuperman@gmail.com",
    });

    this.opsTopic = new Topic(this, "OpsTopic", {
      topicName: `aquascape-ops-${props.envName}`,
      displayName: `Aquascape ops alerts (${props.envName})`,
    });
    this.opsTopic.addSubscription(new EmailSubscription("chengxiaopusuperman@gmail.com"));

    // ---- ALB + SGs ----
    const albSg = new SecurityGroup(this, "AlbSg", {
      vpc: props.vpc,
      description: `aquascape ALB SG (${props.envName})`,
      allowAllOutbound: true,
    });
    albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), "HTTP from CloudFront");

    this.loadBalancer = new ApplicationLoadBalancer(this, "Alb", {
      vpc: props.vpc,
      internetFacing: true,
      loadBalancerName: `aquascape-${props.envName}`,
      securityGroup: albSg,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });

    // ---- Shared log group helper ----
    const mkLogGroup = (name: string) =>
      new LogGroup(this, `Logs-${name}`, {
        logGroupName: `/aquascape/${name}/${props.envName}`,
        retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.TWO_WEEKS,
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });

    // ---- WEB service (Next.js) ----
    const webLogs = mkLogGroup("web");
    const webTask = new FargateTaskDefinition(this, "WebTaskDef", {
      family: `aquascape-web-${props.envName}`,
      cpu: 256,
      memoryLimitMiB: 512,
    });
    webTask.addContainer("web", {
      containerName: "web",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      portMappings: [{ containerPort: 3000, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "web", logGroup: webLogs }),
      environment: {
        NODE_ENV: isProd ? "production" : "development",
        AQUASCAPE_ENV: props.envName,
        NEXT_PUBLIC_API_BASE_URL: `https://${props.envName === "prod" ? "" : `${props.envName}.`}${props.domainName}/grpc`,
      },
      essential: true,
    });

    const webSg = new SecurityGroup(this, "WebSg", {
      vpc: props.vpc,
      description: `aquascape web task SG (${props.envName})`,
      allowAllOutbound: true,
    });
    webSg.addIngressRule(albSg, Port.tcp(3000), "ALB → web");

    this.webService = new FargateService(this, "WebService", {
      serviceName: `aquascape-web-${props.envName}`,
      cluster: this.cluster,
      taskDefinition: webTask,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [webSg],
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // ---- API service (Rust gRPC) ----
    const apiLogs = mkLogGroup("api");
    const apiTask = new FargateTaskDefinition(this, "ApiTaskDef", {
      family: `aquascape-api-${props.envName}`,
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    scapesTable.grantReadWriteData(apiTask.taskRole);
    speciesTable.grantReadData(apiTask.taskRole);
    uploads.grantReadWrite(apiTask.taskRole);

    apiTask.addContainer("api", {
      containerName: "api",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      portMappings: [{ containerPort: 50051, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "api", logGroup: apiLogs }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        DDB_TABLE_SCAPES: scapesTable.tableName,
        DDB_TABLE_SPECIES: speciesTable.tableName,
        SIM_ADDR: "http://aquascape-sim.aquascape.local:50052",
        RUST_LOG: "info",
      },
      essential: true,
    });

    const apiSg = new SecurityGroup(this, "ApiSg", {
      vpc: props.vpc,
      description: `aquascape api task SG (${props.envName})`,
      allowAllOutbound: true,
    });
    apiSg.addIngressRule(albSg, Port.tcp(50051), "ALB → api");

    this.apiService = new FargateService(this, "ApiService", {
      serviceName: `aquascape-api-${props.envName}`,
      cluster: this.cluster,
      taskDefinition: apiTask,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [apiSg],
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // ---- SIM service (Python gRPC, internal only via Cloud Map) ----
    const simLogs = mkLogGroup("sim");
    const simTask = new FargateTaskDefinition(this, "SimTaskDef", {
      family: `aquascape-sim-${props.envName}`,
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    simTask.addContainer("sim", {
      containerName: "sim",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      portMappings: [{ containerPort: 50052, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "sim", logGroup: simLogs }),
      environment: {
        LOG_LEVEL: "INFO",
        PORT: "50052",
      },
      essential: true,
    });

    const simSg = new SecurityGroup(this, "SimSg", {
      vpc: props.vpc,
      description: `aquascape sim task SG (${props.envName})`,
      allowAllOutbound: true,
    });
    // Only api can reach sim.
    simSg.addIngressRule(apiSg, Port.tcp(50052), "api → sim");

    this.simService = new FargateService(this, "SimService", {
      serviceName: `aquascape-sim-${props.envName}`,
      cluster: this.cluster,
      taskDefinition: simTask,
      desiredCount: 1,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [simSg],
      enableExecuteCommand: !isProd,
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: "aquascape-sim",
        containerPort: 50052,
      },
    });

    // ---- ALB target groups + listener ----
    const webTg = new ApplicationTargetGroup(this, "WebTg", {
      vpc: props.vpc,
      port: 3000,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targets: [this.webService],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: "200-399",
      },
      deregistrationDelay: Duration.seconds(30),
    });

    const apiTg = new ApplicationTargetGroup(this, "ApiTg", {
      vpc: props.vpc,
      port: 50051,
      protocol: ApplicationProtocol.HTTP,
      protocolVersion: undefined, // HTTP/1.1 + Connect framing; gRPC-Web target type would be HTTP/2.
      targetType: TargetType.IP,
      targets: [this.apiService],
      healthCheck: {
        path: "/grpc.health.v1.Health/Check",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: "200-499",
      },
      deregistrationDelay: Duration.seconds(30),
    });

    const httpListener = this.loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.forward([webTg]),
    });
    httpListener.addAction("ApiAction", {
      priority: 10,
      conditions: [
        ListenerCondition.pathPatterns(["/grpc/*", "/aquascape.v1.*"]),
      ],
      action: ListenerAction.forward([apiTg]),
    });

    new StringParameter(this, "AlbDnsNameParam", {
      parameterName: `/aquascape/${props.envName}/alb-dns-name`,
      stringValue: this.loadBalancer.loadBalancerDnsName,
      description: "ALB DNS name for CloudFront origin",
    });

    // ---- CloudFront behaviors → ALB ----
    const albOrigin = new LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(5),
    });
    for (const pattern of ["/grpc/*", "/api/*", "/app/*"]) {
      props.distribution.addBehavior(pattern, albOrigin, {
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
        compress: true,
      });
    }

    // ---- Alarms (web 5xx, api 5xx, latency) ----
    for (const [tgName, tg] of [
      ["web", webTg] as const,
      ["api", apiTg] as const,
    ]) {
      const reqs = this.loadBalancer.metrics.requestCount({
        period: Duration.minutes(5),
      });
      const err5xx = tg.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5),
      });
      const ratio = new MathExpression({
        expression: "IF(reqs > 0, (err5xx / reqs) * 100, 0)",
        usingMetrics: { reqs, err5xx },
        period: Duration.minutes(5),
        label: `${tgName} 5xx ratio %`,
      });
      const alarm = new Alarm(this, `${tgName}5xxRatioAlarm`, {
        alarmName: `aquascape-${props.envName}-${tgName}-5xx-ratio`,
        metric: ratio,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new SnsAction(this.opsTopic));
    }

    // ---- Outputs ----
    new CfnOutput(this, "UploadsBucketName", { value: uploads.bucketName });
    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "EcrWebUri", { value: webRepo.repositoryUri });
    new CfnOutput(this, "EcrApiUri", { value: apiRepo.repositoryUri });
    new CfnOutput(this, "EcrSimUri", { value: simRepo.repositoryUri });
    new CfnOutput(this, "AlbDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "OpsTopicArn", { value: this.opsTopic.topicArn });
    new CfnOutput(this, "ScapesTableName", { value: scapesTable.tableName });
    new CfnOutput(this, "SpeciesTableName", { value: speciesTable.tableName });
  }
}
