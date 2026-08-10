#!/usr/bin/env bash
# aws-apprunner-deploy rollback: repoint the service at the previous ECR image
# tag — a config update, never a rebuild. Config via env.
#   APP_NAME / AWS_REGION / PREV_TAG (the image tag to roll back to)
set -euo pipefail
: "${APP_NAME:?set APP_NAME}"
: "${PREV_TAG:?set PREV_TAG (previous image tag)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/harness-apps/${APP_NAME}:${PREV_TAG}"
SERVICE_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${APP_NAME}'].ServiceArn | [0]" --output text)"
[ -n "$SERVICE_ARN" ] && [ "$SERVICE_ARN" != "None" ] || { echo "no such service ${APP_NAME}"; exit 1; }
ROLE_ARN="$(aws iam get-role --role-name AppRunnerECRAccessRole --query 'Role.Arn' --output text)"
aws apprunner update-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
  --source-configuration "{\"ImageRepository\":{\"ImageIdentifier\":\"${IMAGE}\",\"ImageRepositoryType\":\"ECR\",\"ImageConfiguration\":{\"Port\":\"8000\"}},\"AutoDeploymentsEnabled\":false,\"AuthenticationConfiguration\":{\"AccessRoleArn\":\"${ROLE_ARN}\"}}" >/dev/null
echo "rolled ${APP_NAME} back to ${PREV_TAG}"
