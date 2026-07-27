#!/usr/bin/env bash
# cloud-run-deploy rollback: shift traffic to the previous revision.
set -euo pipefail
: "${GCP_PROJECT:?set GCP_PROJECT}"
: "${GCP_REGION:?set GCP_REGION}"
: "${APP_SERVICE:?set APP_SERVICE}"
PREV=$(gcloud run revisions list --service "${APP_SERVICE}" --project "${GCP_PROJECT}" --region "${GCP_REGION}" --format="value(name)" | sed -n 2p)
[ -n "${PREV}" ] || { echo "no previous revision"; exit 1; }
gcloud run services update-traffic "${APP_SERVICE}" --project "${GCP_PROJECT}" --region "${GCP_REGION}" --to-revisions "${PREV}=100"
echo "rolled back to ${PREV}"
