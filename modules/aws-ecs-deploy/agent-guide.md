# aws-ecs-deploy — agent guide

The cost-optimal per-app path at fleet scale: ECS Fargate on ONE shared ALB.
`deploy.sh` builds + pushes a single-manifest image to ECR, registers a Fargate
task definition (256 CPU / 512 MB — cheapest), creates a target group, adds a
host-based rule (`DOMAIN`) to the shared ALB's wildcard listener, and creates the
service with `desiredCount 0` (scale-to-zero; wake by setting desired-count to 1
on first request). One ALB + one wildcard ACM cert covers every app, so there is no
per-app ingress cost.

Config via env: APP_DIR, APP_NAME, SUBNETS, SECURITY_GROUP, ALB_LISTENER_ARN,
VPC_ID, plus optional DOMAIN (vanity host; without it the app is reached via the
ALB DNS name). Security: non-root container, ECR scan-on-push, the AWS-managed ECS
task-execution role (least privilege). `rollback.sh` repoints the service at a
previous task-definition revision — a config change, never a rebuild.
