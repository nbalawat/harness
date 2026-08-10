#!/usr/bin/env bash
# aws-ecs-deploy: the COST-OPTIMAL per-app path — ECS Fargate on a SHARED ALB.
# One ALB (~$16/mo) with a wildcard listener host-routes *.apps.<domain> to every
# app; each app is a Fargate service scaled to zero when idle. Reviewed script;
# the harness never applies to cloud directly. Config via env.
#
#   APP_DIR            built app artifact dir                        [required]
#   APP_NAME           dns-safe service/repo name                    [required]
#   AWS_REGION         default us-east-1
#   CLUSTER            shared ECS cluster name (default harness-apps)
#   SUBNETS            comma-separated private subnet ids            [required]
#   SECURITY_GROUP     app task security group id                    [required]
#   ALB_LISTENER_ARN   the shared ALB's HTTPS listener arn           [required]
#   VPC_ID             vpc for the target group                      [required]
#   DOMAIN             optional vanity FQDN (host-routing rule); none = ALB DNS
#   PORT               container port (default 8000)
set -euo pipefail
: "${APP_DIR:?}"; : "${APP_NAME:?}"; : "${SUBNETS:?}"; : "${SECURITY_GROUP:?}"; : "${ALB_LISTENER_ARN:?}"; : "${VPC_ID:?}"
AWS_REGION="${AWS_REGION:-us-east-1}"; CLUSTER="${CLUSTER:-harness-apps}"; PORT="${PORT:-8000}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"; REPO="harness-apps/${APP_NAME}"
TAG="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)"
IMAGE="${REGISTRY}/${REPO}:${TAG}"

echo "==> build + push single-manifest image"
aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" --image-scanning-configuration scanOnPush=true >/dev/null
BUILD_DIR="$(mktemp -d)"; trap 'rm -rf "$BUILD_DIR"' EXIT
cp -R "$APP_DIR"/. "$BUILD_DIR"/
[ -f "$BUILD_DIR/backend/dev.py" ] && APP_MODULE="dev:app" || APP_MODULE="main:app"
cat > "$BUILD_DIR/Dockerfile.aws" <<EOF
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && useradd --create-home appuser
COPY . .
USER appuser
ENV PYTHONUNBUFFERED=1 HARNESS_AGENT_MODE=stub
EXPOSE ${PORT}
CMD ["python","-m","uvicorn","--app-dir","backend","${APP_MODULE}","--host","0.0.0.0","--port","${PORT}"]
EOF
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -f "$BUILD_DIR/Dockerfile.aws" -t "$IMAGE" "$BUILD_DIR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker push "$IMAGE"

echo "==> ensure cluster + execution role + log group"
aws ecs describe-clusters --clusters "$CLUSTER" --region "$AWS_REGION" --query 'clusters[0].status' --output text 2>/dev/null | grep -q ACTIVE \
  || aws ecs create-cluster --cluster-name "$CLUSTER" --region "$AWS_REGION" >/dev/null
EXEC_ROLE="$(aws iam get-role --role-name ecsTaskExecutionRole --query 'Role.Arn' --output text 2>/dev/null || true)"
if [ -z "$EXEC_ROLE" ] || [ "$EXEC_ROLE" = "None" ]; then
  EXEC_ROLE="$(aws iam create-role --role-name ecsTaskExecutionRole \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn' --output text)"
  aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
fi
aws logs create-log-group --log-group-name "/ecs/${REPO}" --region "$AWS_REGION" 2>/dev/null || true

echo "==> register task definition"
TD_ARN="$(aws ecs register-task-definition --region "$AWS_REGION" \
  --family "$APP_NAME" --network-mode awsvpc --requires-compatibilities FARGATE --cpu 256 --memory 512 \
  --execution-role-arn "$EXEC_ROLE" \
  --container-definitions "[{\"name\":\"${APP_NAME}\",\"image\":\"${IMAGE}\",\"essential\":true,\"portMappings\":[{\"containerPort\":${PORT},\"protocol\":\"tcp\"}],\"environment\":[{\"name\":\"HARNESS_AGENT_MODE\",\"value\":\"stub\"}],\"logConfiguration\":{\"logDriver\":\"awslogs\",\"options\":{\"awslogs-group\":\"/ecs/${REPO}\",\"awslogs-region\":\"${AWS_REGION}\",\"awslogs-stream-prefix\":\"app\"}}}]" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

echo "==> target group on the shared ALB (health /health)"
TG_ARN="$(aws elbv2 create-target-group --region "$AWS_REGION" --name "tg-${APP_NAME:0:26}" \
  --protocol HTTP --port "$PORT" --vpc-id "$VPC_ID" --target-type ip \
  --health-check-path /health --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null \
  || aws elbv2 describe-target-groups --region "$AWS_REGION" --names "tg-${APP_NAME:0:26}" --query 'TargetGroups[0].TargetGroupArn' --output text)"

# Host-based rule on the wildcard listener — vanity host OPTIONAL.
if [ -n "${DOMAIN:-}" ]; then
  PRIORITY=$(( ( $(date +%s) % 40000 ) + 1 ))
  aws elbv2 create-rule --region "$AWS_REGION" --listener-arn "$ALB_LISTENER_ARN" --priority "$PRIORITY" \
    --conditions "Field=host-header,HostHeaderConfig={Values=[${DOMAIN}]}" \
    --actions "Type=forward,TargetGroupArn=${TG_ARN}" >/dev/null 2>&1 || echo "  (rule for ${DOMAIN} may already exist)"
fi

echo "==> create/update the Fargate service (desiredCount 0 = scale-to-zero; wake on request)"
NETCFG="awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUP}],assignPublicIp=DISABLED}"
if aws ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER" --services "$APP_NAME" --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
  aws ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER" --service "$APP_NAME" --task-definition "$TD_ARN" >/dev/null
else
  aws ecs create-service --region "$AWS_REGION" --cluster "$CLUSTER" --service-name "$APP_NAME" \
    --task-definition "$TD_ARN" --desired-count 0 --launch-type FARGATE --network-configuration "$NETCFG" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=${APP_NAME},containerPort=${PORT}" >/dev/null
fi
echo "DONE ${APP_NAME} on shared ALB (${DOMAIN:-ALB DNS name}); scale to 1 to serve: aws ecs update-service --desired-count 1"
