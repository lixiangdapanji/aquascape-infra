# aquascape-infra

AWS CDK (TypeScript) that provisions all cloud infrastructure for
[aquascape-studio](https://github.com/lixiangdapanji/aquascape-studio).

## Role in the polyrepo

This is one of the leaf repos. The `aquascape-studio` meta-repo references
it as a git submodule. Other leaf repos that ship containers
(`aquascape-api`, `aquascape-sim`, `aquascape-web`) **consume** the ECR URIs
and ECS task-def / service names created here — they do not create AWS
resources themselves. They push images into ECR and update service
definitions to point at new image SHAs via GitHub Actions.

## Stacks

```
AquascapeStudio-Bootstrap           // GitHub OIDC + deploy roles (deploy ONCE)
AquascapeStudio-Network-<env>       // VPC, subnets, NAT
AquascapeStudio-Edge-<env>          // CloudFront, ACM, Route53, site bucket
AquascapeStudio-App-<env>           // ECS cluster, 3× Fargate, ALB, DDB, S3
```

Environments are `dev` / `stage` / `prod`, selected via CDK context:

```
cdk deploy --context env=dev AquascapeStudio-App-dev
```

## App tier topology

```
        ┌────────── CloudFront ──────────┐
        │   /grpc/*, /api/*, /app/*      │
        │   default  →  webTg (Next.js)  │
        └─────────────────┬──────────────┘
                          │ (HTTP :80)
                          ▼
                    ┌───────────┐
                    │    ALB    │
                    └─┬──────┬──┘
        /grpc/* etc.  │      │ default
                      ▼      ▼
                  apiSvc   webSvc         (Fargate, private subnets)
                   │
                   │ Cloud Map: aquascape-sim.aquascape.local:50052
                   ▼
                  simSvc                   (internal only; apiSg → simSg)
```

- **webService**  Next.js, port 3000, public via ALB path `/*`
- **apiService**  Rust/tonic gRPC, port 50051, public via ALB path `/grpc/*`
- **simService**  Python/grpcio, port 50052, **internal only** — reached by
  api over Cloud Map (`SIM_ADDR=http://aquascape-sim.aquascape.local:50052`)

## Storage

- `aquascape-scapes-<env>` (DDB) — scapes table with `byOwner` GSI and DDB streams
- `aquascape-species-<env>` (DDB) — read-heavy species cache
- `aquascape-uploads-<env>-<account>` (S3) — user reference photos, Glacier @ 90d

## Deploy

### One-time bootstrap (admin creds required)

```bash
AWS_PROFILE=admin npx cdk deploy AquascapeStudio-Bootstrap
```

Copy the `DeployRoleArn-dev/stage/prod` outputs into **each** consumer repo's
GitHub Secrets as `AWS_DEPLOY_ROLE_DEV`, `AWS_DEPLOY_ROLE_STAGE`,
`AWS_DEPLOY_ROLE_PROD`:

- `aquascape-infra` itself
- `aquascape-api`
- `aquascape-sim`
- `aquascape-web`
- `aquascape-mobile` (OTA publish only — still needs AWS for EAS-on-AWS optional flow)

### Per-env stack deploys

Driven by the `deploy-infra.yml` workflow in this repo, triggered on push to
`main` (dev), manual dispatch (stage), or tag `v*` (prod).

```bash
# local sanity
pnpm typecheck
pnpm synth -- --context env=dev
pnpm diff   -- --context env=dev
pnpm deploy -- --context env=dev
```

## Layout

```
bin/aquascape.ts              // CDK app entry, wires stacks by env
lib/constructs/GithubOidc.ts  // OIDC provider + per-env deploy roles
lib/stacks/BootstrapStack.ts  // one-time account bootstrap
lib/stacks/NetworkStack.ts    // VPC
lib/stacks/EdgeStack.ts       // CloudFront + Route53 + ACM + site bucket
lib/stacks/AppStack.ts        // ECS + ALB + DDB + S3 + alarms
lib/stacks/Budget.ts          // monthly cost guardrail
```

## Patent note

No part of this infra is claimed in the provisional patent — the claims sit
in `aquascape-sim`. This repo only stands up the compute that runs the
simulator service.
