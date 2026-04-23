# aquascape-infra

**Owner**: infra-agent  
**Stack**: AWS CDK v2 TypeScript  
**Account**: 063418083301 / us-east-1

## Layout

```
aquascape-infra/
├── bin/
│   └── aquascape-infra.ts   # CDK app entry, instantiates dev/stage/prod
├── lib/
│   ├── NetworkStack.ts      # VPC, subnets, NAT
│   ├── EdgeStack.ts         # CloudFront, ACM, Route53
│   └── AppStack.ts          # ECS, ALB, DDB, S3, ECR
├── cdk.json
├── cdk.context.json
└── package.json
```

## Path note

Agent definitions reference `infra/` — the actual root is `aquascape-infra/`. All CDK stacks live here.

## Key commands

```bash
npm run build                # tsc
npx cdk synth
npx cdk diff
npx cdk deploy --all --context env=dev --require-approval never
```

## Known values

- Domain: efferves.live (Route53 hosted zone already created)
- Deploy roles: GithubDeployRole-dev / -stage / -prod (OIDC)
- Stacks: AquascapeStudio-Bootstrap, -Network-{env}, -Edge-{env}, -App-{env}

## Cost guardrails

$150/mo dev budget, $600/mo prod. Flag any PR exceeding these in the description.
