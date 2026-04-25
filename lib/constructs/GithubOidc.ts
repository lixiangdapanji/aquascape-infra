import { Construct } from "constructs";
import {
  OpenIdConnectProvider,
  Role,
  WebIdentityPrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
} from "aws-cdk-lib/aws-iam";
import { CfnOutput } from "aws-cdk-lib";

export interface GithubOidcProps {
  githubUser: string;
  /** All repos that should be trusted to assume the deploy roles. */
  repoNames: string[];
  environments: Array<"dev" | "stage" | "prod">;
}

/**
 * Creates the GitHub OIDC provider + one deploy role per env.
 *
 * The trust policy's `sub` uses `StringLike` with an array of patterns — one
 * per repo in `repoNames`. Any of the listed repos can assume the role when
 * running in the matching Actions environment.
 */
export class GithubOidc extends Construct {
  readonly roles: Record<string, Role> = {};

  constructor(scope: Construct, id: string, props: GithubOidcProps) {
    super(scope, id);

    const provider = new OpenIdConnectProvider(this, "Provider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    for (const env of props.environments) {
      const subjectPattern = `repo:${props.githubUser}/aquascape-*:environment:${env}`;

      const principal = new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "ForAnyValue:StringLike": {
          "token.actions.githubusercontent.com:sub": [subjectPattern],
        },
      });

      const role = new Role(this, `DeployRole-${env}`, {
        roleName: `GithubDeployRole-${env}`,
        assumedBy: principal,
        description: `Assumed by GitHub Actions (aquascape-*) in environment=${env}`,
        managedPolicies:
          env === "prod"
            ? []
            : [ManagedPolicy.fromAwsManagedPolicyName("PowerUserAccess")],
      });

      // PowerUserAccess excludes iam:*, but registering an ECS task definition
      // requires iam:PassRole to hand the task/execution roles to ECS.
      if (env !== "prod") {
        role.addToPolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["iam:PassRole", "iam:GetRole"],
          resources: [`arn:aws:iam::*:role/AquascapeStudio-App-${env}-*`],
        }));
      }

      if (env === "prod") {
        role.addToPolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "cloudformation:*", "s3:*", "cloudfront:*",
            "ecs:*", "ecr:*", "dynamodb:*",
            "iam:PassRole", "iam:GetRole",
            "logs:*", "acm:*",
            "route53:ChangeResourceRecordSets", "route53:GetHostedZone",
            "route53:ListHostedZones", "route53:ListResourceRecordSets",
            "ssm:GetParameter*", "ssm:PutParameter",
            "secretsmanager:GetSecretValue",
          ],
          resources: ["*"],
        }));
      }

      new CfnOutput(this, `DeployRoleArn-${env}`, {
        value: role.roleArn,
        exportName: `GithubDeployRoleArn-${env}`,
      });

      this.roles[env] = role;
    }
  }
}
