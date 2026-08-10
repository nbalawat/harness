# aws-apprunner-deploy — agent guide

The fast per-app AWS path. `deploy.sh` builds a single-manifest linux/amd64 image
(`docker buildx --provenance=false` — App Runner rejects buildkit attestation
indexes), serves the UI via `dev:app` when a frontend is present, pushes to ECR,
and creates/updates an App Runner service with a TCP health check (reliable during
CREATE). Config via env: APP_DIR, APP_NAME, AWS_REGION, PORT, DOMAIN (optional).

The custom domain is OPTIONAL — with none set the app is live at its default
`*.awsapprunner.com` URL; with a Route53 zone present the script associates
`DOMAIN` and writes the ACM validation + app CNAME records. Security: non-root
container, ECR scan-on-push, the AWS-managed ECR-read-only access role (least
privilege). `apprunner_deploy.py` is a boto3 fallback for AWS CLIs that predate the
`apprunner` command. `rollback.sh` repoints the service at a prior image tag.
