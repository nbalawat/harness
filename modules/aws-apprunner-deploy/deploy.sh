#!/usr/bin/env bash
# aws-apprunner-deploy: containerize a produced app -> ECR -> App Runner, and
# print a live https URL. The fast path (single command, managed HTTPS, custom
# domain optional). Config via env; the domain is OPTIONAL — with none set the
# app is reachable at its default *.awsapprunner.com URL.
#
#   APP_DIR       path to the built app artifact (contains backend/, frontend/)   [required]
#   APP_NAME      service + repo name, e.g. naveen-kycapp-v17                      [required]
#   AWS_REGION    default us-east-1
#   PORT          container port (default 8000; served by dev:app so the UI shows)
#   DOMAIN        optional vanity FQDN e.g. naveen-kycapp-v17.otaras.com
#   CPU/MEMORY    App Runner size (default 256 / 512 = cheapest)
#   AGENT_MODE    HARNESS_AGENT_MODE for the app (default stub)
set -euo pipefail
: "${APP_DIR:?set APP_DIR (the built app artifact dir)}"
: "${APP_NAME:?set APP_NAME (dns-safe service name)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
PORT="${PORT:-8000}"
CPU="${CPU:-256}"
MEMORY="${MEMORY:-512}"
AGENT_MODE="${AGENT_MODE:-stub}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO="harness-apps/${APP_NAME}"
REGISTRY="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
TAG="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)"
IMAGE="${REGISTRY}/${REPO}:${TAG}"

echo "==> [1/5] ECR repository ${REPO}"
aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null

echo "==> [2/5] build image (serves frontend via dev:app when present)"
BUILD_DIR="$(mktemp -d)"; trap 'rm -rf "$BUILD_DIR"' EXIT
cp -R "$APP_DIR"/. "$BUILD_DIR"/
# Pick the entrypoint: dev:app mounts the static frontend + API in one process;
# fall back to main:app for API-only apps. This closes the single-container
# "frontend not served" gap without editing the produced artifact.
if [ -f "$BUILD_DIR/backend/dev.py" ]; then APP_MODULE="dev:app"; else APP_MODULE="main:app"; fi
cat > "$BUILD_DIR/Dockerfile.aws" <<EOF
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && useradd --create-home appuser
COPY . .
USER appuser
ENV PYTHONUNBUFFERED=1 HARNESS_AGENT_MODE=${AGENT_MODE}
EXPOSE ${PORT}
CMD ["python","-m","uvicorn","--app-dir","backend","${APP_MODULE}","--host","0.0.0.0","--port","${PORT}"]
EOF
# --provenance=false / --sbom=false: emit a SINGLE linux/amd64 manifest. Buildkit's
# default provenance attestations create an image index that App Runner (and some
# ECR consumers) reject with "Failed to deploy your application image" and no logs.
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load \
  -f "$BUILD_DIR/Dockerfile.aws" -t "$IMAGE" "$BUILD_DIR"

echo "==> [3/5] push to ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker push "$IMAGE"


echo "==> [4/5] create/update App Runner service + optional vanity domain"
# The App Runner control-plane calls (least-privilege ECR access role, create/
# update, wait-for-RUNNING, custom-domain + Route53 records) run via the boto3
# helper — version-independent, so this works even on AWS CLIs that predate the
# `apprunner` command. DOMAIN stays optional.
export IMAGE APP_NAME AWS_REGION PORT CPU MEMORY AGENT_MODE DOMAIN
python3 "$(dirname "$0")/apprunner_deploy.py"
echo "==> [5/5] done — see LIVE_URL above"
