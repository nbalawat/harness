# CI/CD

The harness has CI/CD at **three levels**, each independent and each backed by
committed, reproducible config:

1. **Repo CI** — every change to this repo passes the full test suite *and*
   re-certifies every project type, module, and MCP server (byte-deterministic).
2. **Engine + catalog release** — a tagged version is certified, bundled (SBOM),
   signed, and promoted through registry channels (`next` → `latest`).
3. **Produced-app delivery** — an app the harness builds is containerized and
   deployed to AWS App Runner / ECS via a certified deploy module.

Levels 1 and 3 are wired on **AWS CodeBuild** under [`ci/aws/`](../ci/aws/) and can
also run as **GitHub Actions** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).
Level 2 is the release flow described in [DEPLOYMENT-GCP.md](DEPLOYMENT-GCP.md) (DF-5).

Local-first is unaffected: none of this is required to install the harness and
build/run apps on a laptop. It is the firm-scale delivery layer.

---

## Provision (one-time)

```sh
python3 ci/aws/provision.py                      # zips the repo to S3, creates both projects
python3 ci/aws/provision.py --github OWNER/REPO   # source from GitHub + enable webhook triggers
```

`provision.py` is idempotent. It:
- ensures the CodeBuild service role `codebuild-harness-role` (demo uses
  `AdministratorAccess`; **scope to ECR + App Runner + PassRole + CloudWatch Logs +
  S3 for production**),
- uploads the repo as the S3 source (or points at GitHub), and
- creates/updates two CodeBuild projects, each pointed at its buildspec:
  - `harness-ci` → `ci/aws/harness-ci.buildspec.yml`
  - `harness-deploy-app` → `ci/aws/deploy-app.buildspec.yml` (privileged: builds images)

Re-run it to refresh the S3 source after changes.

---

## Pipeline 1 — `harness-ci` (the repo gate)

**Trigger:** GitHub push/PR webhook, or `aws codebuild start-build --project-name harness-ci`.
**Image:** `aws/codebuild/standard:7.0` (Node + Python + Chrome), compute `LARGE`.

| Phase | Steps |
|---|---|
| DOWNLOAD_SOURCE | Pull the repo (S3 zip or GitHub). |
| INSTALL | Node 20, Python 3.12; install `uv`; install the Chrome channel for the UI-interactivity verifiers. |
| BUILD | `npm ci` → `npm test` (build + full 170-test suite) → `harness certify-mcp` → `harness certify-modules` (all 114 modules) → `harness certify project-types/demo` → `harness certify project-types/agentic-app` → `npm run bundle`. |
| POST_BUILD | Emit the engine bundle as the build artifact. |

**The gate's teeth — certification.** `harness certify` replays each type's golden
scenarios and compares **byte-level artifact digests**, cost envelopes, the
revision-drill, the **held-out overfitting guard** (`fixtures/answers-heldout*.json`,
re-baselined only with an explicit `--update-heldout`), and `gate-regression.cjs`
(every past failure-class must still be caught). **Any drift = red.** This is why a
change to a module or prompt cannot silently alter a produced app: the goldens
would diverge and CI would fail. Same gate as `.github/workflows/ci.yml`.

---

## Pipeline 2 — `harness-deploy-app` (build + deploy an app)

**Trigger:**
```sh
aws codebuild start-build --project-name harness-deploy-app \
  --environment-variables-override \
    name=APP_NAME,value=naveen-kycapp-v18 \
    name=TARGET,value=aws-apprunner \
    name=DOMAIN,value=naveen-kycapp-v18.otaras.com   # optional
```
**Env knobs:** `APP_NAME` (required), `PROJECT_TYPE` (default `project-types/agentic-app`),
`ANSWERS` (default the agentic-app fixture), `TARGET` (`aws-apprunner` | `aws-ecs`),
`DOMAIN` (optional vanity host), `APP_DIR` (deploy a prebuilt artifact and skip the build).
**Image:** `standard:7.0`, **privilegedMode: true** (builds container images).

| Phase | Steps |
|---|---|
| DOWNLOAD_SOURCE | Pull the repo. |
| INSTALL | Node, Python, `uv`, `boto3`, Chrome. |
| BUILD | `npm ci && npm run build`. **Build the app** with the harness (`harness run <PROJECT_TYPE> --mock-agents --answers <ANSWERS>`) — or skip if `APP_DIR` is set. Then **deploy** via the certified module. |
| POST_BUILD | Print `LIVE_URL=…`. |

**The deploy step** (`modules/aws-apprunner-deploy/deploy.sh`, or
`modules/aws-ecs-deploy/deploy.sh` when `TARGET=aws-ecs`):
1. `docker buildx build --provenance=false --sbom=false` → a **single-manifest**
   `linux/amd64` image that serves the UI via `dev:app` (App Runner rejects buildkit
   attestation indexes).
2. Create the ECR repo on demand (scan-on-push) and push the image.
3. Ensure the least-privilege **App Runner ECR access role**
   (`AWSAppRunnerServicePolicyForECRAccess`).
4. Create/update the App Runner service (TCP health check; **auto-retries** the
   occasionally-flaky CREATE by delete + recreate). For `aws-ecs`: register the
   Fargate task-def and attach a host rule on the shared ALB, scaled to zero.
5. If `DOMAIN` is set and a Route 53 zone exists: associate the custom domain and
   write the ACM validation + app CNAME records. **Domain is optional** — with none,
   the app is live at its default `*.awsapprunner.com` URL.

The harness never touches the cloud directly during a build; it emits a **reviewed
deploy plan** (`deploy-plan.cjs` → `deploy/{apprunner.json|task-def.json|plan.md}`),
and this pipeline is what applies it.

---

## Wiring it into one flow (CodePipeline)

One command wires the whole thing as an **AWS CodePipeline**:

```sh
python3 ci/aws/provision_pipeline.py
```

This creates a versioned source bucket + artifact bucket, a CodePipeline service
role, two CODEPIPELINE-flavored CodeBuild projects (`harness-ci-cp`,
`harness-deploy-cp`), and the pipeline `harness-pipeline`:

```
Source (S3 source.zip; swap for GitHub via a CodeStar connection)
   │  new source version
   ▼
Stage 1 — CI_Test_and_Certify:  CodeBuild harness-ci-cp   (tests + certification gate)
   │  on success
   ▼
Stage 2 — Approval:  Manual approval before prod
   │  approved
   ▼
Stage 3 — Deploy_App:  CodeBuild harness-deploy-cp   (APP_NAME/TARGET/DOMAIN as vars)
```

Trigger a run by re-uploading the source or
`aws codepipeline start-pipeline-execution --name harness-pipeline`. For GitHub
triggers, replace the S3 source action with a GitHub (v2) source via a CodeStar
connection (one-time OAuth in the console); pushes then start the pipeline
automatically.

---

## Level 2 — engine + catalog release (DF-5)

Independent of app delivery, keyed on a signed git tag:

```
tag agentic-app@0.17.x
  → CI: npm test + certify (goldens byte-identical)   # the same gate
  → npm run pack   (engine + certified catalog, SBOM attached)
  → sign the package digest (cosign / KMS)
  → push to registry channel "next"
  → telemetry clean for N days → promote "next" → "latest"   (one command)
```

Channels are npm dist-tags, so a bad release is held or rolled back centrally
without touching user machines. `platform/cloudbuild.yaml` separately builds the
three platform service images (gateway / collector / registry) on push to `main`
touching `platform/**`, attested for Binary Authorization.

---

## Proven

- `harness-deploy-app` built an app in the cloud and deployed it live to App Runner
  (`ci-deployed-app`). The in-cloud build path is the same one used to prove the
  harness runs entirely inside AWS CodeBuild.
- `harness-ci` runs the identical gate as GitHub Actions; the repo re-certifies
  green at `agentic-app@0.17.0`.
