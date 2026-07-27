#!/usr/bin/env bash
# cloud-run-deploy: build -> deploy(no traffic) -> shift. Config via env.
set -euo pipefail
: "${GCP_PROJECT:?set GCP_PROJECT}"
: "${GCP_REGION:?set GCP_REGION}"
: "${APP_SERVICE:?set APP_SERVICE}"
IMAGE="gcr.io/${GCP_PROJECT}/${APP_SERVICE}:$(date +%Y%m%d-%H%M%S)"

gcloud builds submit --project "${GCP_PROJECT}" --tag "${IMAGE}" .
gcloud run deploy "${APP_SERVICE}" --project "${GCP_PROJECT}" --region "${GCP_REGION}" \
  --image "${IMAGE}" --no-traffic --port 8000 --allow-unauthenticated
gcloud run services update-traffic "${APP_SERVICE}" --project "${GCP_PROJECT}" --region "${GCP_REGION}" --to-latest
echo "deployed ${IMAGE}"
