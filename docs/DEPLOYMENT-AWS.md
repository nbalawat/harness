# AWS Deployment Architecture

Concrete deployment design for hosting the harness on **AWS** for a large firm
(~60k users), the AWS counterpart to [DEPLOYMENT-GCP.md](DEPLOYMENT-GCP.md). Same
certified engine; the four planes (distribution, execution, evidence, showcase)
map to mostly-serverless AWS footprints.

**Cloud is optional.** Everything here is opt-in. A user can `npm install` the
harness and build + run apps **entirely locally** with no AWS, no gateway, no
account — local `harness run` uses `ANTHROPIC_API_KEY` directly. The pieces below
add the *hosted, multi-tenant* experience on top; they never become mandatory.

Three ways an app reaches production, from ONE artifact (no rebuild):

1. **Local only** — `docker-compose up` (app + Postgres + Redis) on a laptop.
2. **Local → AWS (promote)** — `harness deploy <ws> --target aws-apprunner|aws-ecs`
   runs the reviewed plan against the finished app and ships the same image.
3. **Direct to AWS** — intake `deploy_target: aws-apprunner|aws-ecs`; the pipeline
   emits the reviewed AWS plan as a build artifact before sign-off.

Parity is guaranteed by the `DATABASE_URL` contract
(`modules/persistence-core/compose/backend/db.py`): unset → in-memory (local);
set → Postgres/RDS (AWS). Same container, only env differs.

- [1. Account & environment topology](#1-account--environment-topology)
- [2. Component architecture](#2-component-architecture)
- [3. BYO Claude credentials](#3-byo-claude-credentials)
- [4. App deployment & vanity URLs](#4-app-deployment--vanity-urls)
- [5. Ownership, teams & sharing](#5-ownership-teams--sharing)
- [6. Business intelligence & app popularity](#6-business-intelligence--app-popularity)
- [7. Identity & access](#7-identity--access)
- [8. Security controls](#8-security-controls)
- [9. Infra inventory & IaC](#9-infra-inventory--iac)
- [10. Cost](#10-cost)
- [11. Implementation status](#11-implementation-status)

---

## 1. Account & environment topology

One AWS Organization; an OU per concern, blast radius following account lines,
`dev` / `staging` / `prod` per account.

```
org: firm
└── OU: harness/
    ├── acct: harness-dist-{env}     ECR (images), CodeBuild release pipeline
    ├── acct: harness-gateway-{env}  llm-gateway (ECS/Fargate) -> Bedrock/Anthropic, BYO keys
    ├── acct: harness-exec-{env}     Tier-2 hosted builders: ECS/Fargate or EKS, EFS workspaces
    ├── acct: harness-obs-{env}      Telemetry collector, S3 + Athena + QuickSight (BI)
    ├── acct: harness-apps-{env}     App runtime: App Runner / ECS-on-shared-ALB, Route53, ACM
    └── acct: harness-sec            Org security: KMS, GuardDuty, CloudTrail, Config
```

**Regions:** primary `us-east-1`, DR `us-west-2`. Model traffic via **Amazon
Bedrock** (Anthropic models) keeps prompts in the firm's account, or via the
public Anthropic API through the gateway when a user brings their own key.

## 2. Component architecture

| Plane | AWS service | Repo artifact |
|---|---|---|
| **Distribution** | CodeArtifact (npm) + ECR (containers), CodeBuild release | `platform/*/Dockerfile`, release pipeline |
| **Gateway** (model choke point, BYO keys, quota, metering) | ECS/Fargate behind an internal ALB; Secrets Manager for keys | `platform/gateway/server.mjs` |
| **Execution** (Tier-2 builders) | ECS/Fargate task or EKS pod, one per active build; **EFS** workspace (park/resume) | `platform/builder/Dockerfile` |
| **Evidence / BI** | telemetry-collector (Fargate) → S3 (partitioned) → **Athena / QuickSight** | `platform/collector/server.mjs` |
| **Showcase** (registry + gallery + sharing) | app-registry (Fargate) + **S3 (Object Lock)** evidence + **DynamoDB** metadata | `platform/registry/server.mjs` |
| **App runtime** (produced apps) | **App Runner** (fast) or **ECS Fargate on a shared ALB** (cheap at scale) | `modules/aws-apprunner-deploy`, `modules/aws-ecs-deploy` |

Every service reads the caller identity from the same header convention —
`x-amzn-oidc-identity` (ALB OIDC) / `x-firm-identity` — so the local→hosted seam
is a header, not a rewrite.

## 3. BYO Claude credentials

Users **bring their own Claude key or subscription**; the gateway forwards *their*
credential so builds bill to their account. Build pods never hold a key.

- One-time `harness login --gateway <url> --key sk-...` (or `--oauth <token>` for
  subscription users) → the gateway stores it in **Secrets Manager**, keyed by SSO
  identity. Secrets are write-only over the API and **never logged or echoed**
  (registration returns only the last 4 chars).
- On each build, the gateway resolves `identity → credential`
  (`resolveAuthHeaders`), enforces the model allow-list and a per-identity daily
  quota, forwards, and meters spend joinable to run-ids. A caller with no key gets
  **402** — never someone else's key.
- Build pods get only `ANTHROPIC_BASE_URL=<gateway>` + their identity header.

## 4. App deployment & vanity URLs

Two certified adapters (both emit reviewed plans; the harness never touches cloud
directly — CI/`deploy.sh` applies):

- **`modules/aws-apprunner-deploy`** (fast path): single-manifest `linux/amd64`
  image (`docker buildx --provenance=false`) → ECR → App Runner service (TCP
  health check, 0.25 vCPU/0.5 GB = cheapest tier), serving the UI via `dev:app`.
  Optional custom domain association.
- **`modules/aws-ecs-deploy`** (cost-optimal at fleet scale): one **shared ALB**
  (~$16/mo) with host-based routing on a **wildcard listener** (`*.apps.<domain>`,
  one wildcard ACM cert), per-app Fargate service scaled to **zero** when idle and
  woken on first request. No per-app ingress cost.

**Vanity URLs** follow `<owner>-<app>-v<ver>.apps.<domain>` (e.g.
`naveen-kycapp-v17.deloitte.com`). **The domain is OPTIONAL** — with none set, an
app is reachable at its default App Runner URL (`*.awsapprunner.com`) or the shared
ALB DNS name. When a Route53 zone is present, the adapter associates the domain and
writes the ACM validation + app CNAME records automatically.

*Proven live:* the `kyc-v17` app deployed to App Runner and served at both its
default URL and the vanity host `naveen-kycapp-v17.otaras.com` (Route53 + ACM).

## 5. Ownership, teams & sharing

- Every run is stamped with `owner` (SSO identity) and optional `team` in
  `run.json` (individual **or team** building; a teammate can view/drive a
  team-owned run).
- The registry enforces **visibility scopes** (`private` | `team` | `firm`), not
  labels: `private` → owner only; `team` → team members (identity→team via the
  IdP group sync); `firm` → everyone (the gallery itself is SSO-gated). Enforced on
  list, detail, evidence, and deploy.
- **App lifecycle:** after building, a user (or team) **promotes** an app (deploy
  to AWS + publish) or **abandons** it (discard/archive) — an explicit action.
- Running-app access is separately gated by the app's own SSO/RBAC
  (`modules/sso-oidc`, `modules/rbac`).

## 6. Business intelligence & app popularity

Two mined planes, both zero-config for builders:

- **Build BI** — every completed run emits a rollup to the collector: *who* (owner,
  team), *what* (project type, app name), *cost & tokens*, *quality* (rework %,
  audit rounds, loop detections), and *experience* (questions answered, revisions).
  `GET /v1/bi?groupBy=owner|team|projectType` returns adoption, spend, quality, and
  experience leaderboards. Rows land in S3 → **Athena/QuickSight** for firm-wide
  dashboards.
- **Usage BI (popularity)** — the `usage-beacon` module auto-mounts in each
  deployed app and reports **who uses it** (SSO identity **hashed** before it leaves
  the app) → `GET /v1/apps/usage` yields per-app **unique users, DAU/MAU, request
  volume**, ranked most-popular-first. ALB access logs (S3 → Athena) are the
  tamper-resistant backstop so popularity can't be self-reported.

## 7. Identity & access

- **Zero access administration.** ALB OIDC → **IAM Identity Center** federated to
  the corp IdP: any authenticated firm identity can install, build, deploy,
  publish, and browse from day one — no tickets, joiners in / leavers out
  automatically. Narrow IAM only for the platform team, audit, and service roles.
- Quota/chargeback: the gateway resolves identity → HR team/cost-center (nightly
  sync) and stamps it on every usage + telemetry row.

## 8. Security controls (top-notch, "not hackable")

- **Least privilege everywhere** — App Runner pulls ECR via the AWS-managed
  `AWSAppRunnerServicePolicyForECRAccess` (ECR-read only), not a broad grant;
  per-service task roles scoped to exactly their arrows.
- **Secrets** in Secrets Manager (BYO keys), **never logged**, never on build pods;
  KMS CMEK on ECR, S3 evidence, DynamoDB, EFS, Secrets Manager (90-day rotation).
- **Containers run non-root** (`appuser`), **ECR scan-on-push**, single-manifest
  images only.
- **Evidence immutability** via S3 Object Lock; **CloudTrail** org trail → SIEM;
  **GuardDuty** + **Security Hub** org-wide.
- **Network**: services private behind ALB + **AWS WAF** (rate + managed rules);
  builder egress restricted to the gateway + package mirrors; deployed apps gated
  by their own auth/RBAC, with production behind ALB-OIDC / private ingress and no
  unauthenticated data endpoints.
- **Model choke point**: all model traffic through the gateway — allow-list,
  per-identity quota, metering reconciled against journals (drift = tamper signal).

## 9. Infra inventory & IaC

`infra/aws/` mirrors the GCP Terraform: modules `network`, `dns-cert` (Route53 +
wildcard ACM), `alb-router` (shared ALB + OIDC listener), `ecs-app` (per-app
Fargate service + target group + host rule), `builder-cluster`, `gateway`,
`registry`, `telemetry` (collector + S3 + Athena), `secrets`; env dirs under
`infra/aws/envs/`. Promotion via CI plan/apply with a manual prod gate.

## 10. Cost

Steady state at 60k seats, ~20% monthly-active builders. Model spend (Bedrock/BYO)
dominates; everything else is noise. The cheapest app-runtime is the **shared-ALB +
Fargate scale-to-zero** design (one ALB ~$16/mo + Fargate only while a task runs);
App Runner is the fast/low-volume adapter. Cost guardrails are wired in: certified
per-build budget envelopes, gateway per-identity/team quotas, and daily
gateway-vs-journal reconciliation.

## 11. Implementation status

Deployed and verified on AWS (account `613112965612`, `us-east-1`):

- **App on AWS, live:** `kyc-v17` containerized → ECR → App Runner, serving at its
  default URL **and** the vanity host `naveen-kycapp-v17.otaras.com` (Route53 + ACM
  active). Adapter: `modules/aws-apprunner-deploy` (`deploy.sh` + boto3 fallback for
  older AWS CLIs).
- **Control plane, proven end-to-end** (`scripts/e2e-multiuser-aws.mjs`, all
  assertions green): BYO keys (402 → register → forward, secret never echoed); **3
  users building in parallel** with isolated workspaces + owner/team attribution;
  seamless local→AWS promotion (`harness deploy --target aws-*`, no rebuild);
  enforced private/team/firm sharing; app-usage popularity; BI by owner and team.
- Covered by `npm test` (`platform/test/platform.test.mjs`): gateway BYO, collector
  BI + app-usage, registry visibility enforcement.

Still architectural (next phases): the shared-ALB scale-to-zero wake controller,
EKS Tier-2 builders, Athena/QuickSight dashboards, IAM Identity Center wiring, and
the full `infra/aws/` Terraform apply.
