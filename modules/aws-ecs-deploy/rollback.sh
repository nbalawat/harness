#!/usr/bin/env bash
# aws-ecs-deploy rollback: point the service at the previous task-definition
# revision — a config update, never a rebuild. Config via env.
#   APP_NAME / AWS_REGION / CLUSTER / PREV_REVISION (task-def revision number)
set -euo pipefail
: "${APP_NAME:?}"; : "${PREV_REVISION:?}"
AWS_REGION="${AWS_REGION:-us-east-1}"; CLUSTER="${CLUSTER:-harness-apps}"
aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" --service "$APP_NAME" \
  --task-definition "${APP_NAME}:${PREV_REVISION}" >/dev/null
echo "rolled ${APP_NAME} back to task-def revision ${PREV_REVISION}"
