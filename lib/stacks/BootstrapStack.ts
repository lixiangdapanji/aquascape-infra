import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { GithubOidc } from "../constructs/GithubOidc";

export interface BootstrapStackProps extends StackProps {
  githubUser: string;
  /** All aquascape-* repos that can assume the deploy roles. */
  repoNames: string[];
  environments: Array<"dev" | "stage" | "prod">;
}

/**
 * One-time account bootstrap:
 *   - GitHub OIDC provider
 *   - Deploy roles per environment
 *
 * Deploy ONCE with admin creds:
 *   npx cdk deploy AquascapeStudio-Bootstrap
 *
 * After this, copy the output role ARNs into GitHub → Settings → Secrets →
 * Variables: AWS_DEPLOY_ROLE_DEV / _STAGE / _PROD in EACH repo that ships
 * (aquascape-infra, aquascape-api, aquascape-sim, aquascape-web).
 */
export class BootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);
    new GithubOidc(this, "Oidc", {
      githubUser: props.githubUser,
      repoNames: props.repoNames,
      environments: props.environments,
    });
  }
}
