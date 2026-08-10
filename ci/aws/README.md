# Harness CI/CD on AWS

Two pipelines, both on AWS CodeBuild, provisioned by `provision.py` (idempotent).

## 1. `harness-ci` — the repo gate
Runs `harness-ci.buildspec.yml`: the **same gate as `.github/workflows/ci.yml`** —
`npm test` (full suite) + byte-deterministic re-certification of every project
type, module, and MCP server, then `npm run bundle`. Drift = red. Use this when
the firm runs CI on AWS instead of (or alongside) GitHub Actions.

## 2. `harness-deploy-app` — the app delivery pipeline
Runs `deploy-app.buildspec.yml`: builds a produced app with the harness (or takes
a prebuilt `APP_DIR`) and deploys it to **App Runner** (or ECS) via the certified
`aws-apprunner-deploy` / `aws-ecs-deploy` module. One project, many apps — every
knob is an env override:

```
aws codebuild start-build --project-name harness-deploy-app \
  --environment-variables-override \
    name=APP_NAME,value=naveen-kycapp-v18 \
    name=DOMAIN,value=naveen-kycapp-v18.otaras.com \
    name=TARGET,value=aws-apprunner
```
The build prints `LIVE_URL=` when the service is up. (This is the exact path the
in-cloud proof used: CodeBuild ran the harness → built an app → deployed it.)

## Provision
```
python3 ci/aws/provision.py                 # S3-zip source, runs immediately
python3 ci/aws/provision.py --github nbalawat/harness   # GitHub source + webhooks
```
`provision.py` creates the CodeBuild service role (`AdministratorAccess` for the
demo — scope to ECR + App Runner + PassRole + logs + S3 for production) and both
projects. With `--github`, add a CodeBuild GitHub source credential + a webhook so
pushes trigger `harness-ci` automatically; wrap both projects in a **CodePipeline**
(source → CI → deploy) for a hands-off flow.

## The three CI/CD levels
1. **Harness repo** — `harness-ci` here + `.github/workflows/ci.yml`.
2. **Engine + catalog release** — DF-5 in `docs/DEPLOYMENT-GCP.md` (certify → pack
   → sign → channel `next`→`latest`).
3. **Produced apps** — `harness-deploy-app` here; the harness emits a reviewed
   deploy plan, CI applies it (the harness never touches cloud directly).
