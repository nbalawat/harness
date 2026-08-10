// Deploy stage (conditional on architecture.deploy_target != local): produces a
// REVIEWED deploy plan + the concrete service spec for the chosen target. The
// harness never touches cloud directly — apply is a separate, reviewed step
// (harness deploy / CI). Targets: cloud-run | aws-apprunner | aws-ecs. Cloud is
// entirely optional; "local" produces no plan.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const arch = inputs.architecture.data;
const target = arch.deploy_target || "cloud-run";
const modules = Array.isArray(arch.modules) ? arch.modules : [];
const PORT = 8000;
const NAME = "agentic-app";

fs.mkdirSync("deploy", { recursive: true });

function writePlan(title, steps) {
  fs.writeFileSync(
    "deploy/plan.md",
    [`# Deploy plan (${title})`, "", modules.length ? `Modules: ${modules.join(", ")}` : "", "", ...steps.map((s, i) => `${i + 1}. ${s}`), ""].join("\n"),
  );
}

if (target === "aws-apprunner") {
  // App Runner: the fast per-app vanity path. Domain OPTIONAL (default *.awsapprunner.com).
  fs.writeFileSync(
    "deploy/apprunner.json",
    JSON.stringify(
      {
        ServiceName: NAME,
        SourceConfiguration: {
          ImageRepository: {
            ImageIdentifier: "<ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/harness-apps/<APP_NAME>:<TAG>",
            ImageRepositoryType: "ECR",
            ImageConfiguration: { Port: String(PORT), RuntimeEnvironmentVariables: { HARNESS_AGENT_MODE: "stub" } },
          },
          AutoDeploymentsEnabled: false,
        },
        InstanceConfiguration: { Cpu: "256", Memory: "512" },
        HealthCheckConfiguration: { Protocol: "TCP", Interval: 20, Timeout: 15, HealthyThreshold: 1, UnhealthyThreshold: 10 },
      },
      null,
      2,
    ),
  );
  writePlan("AWS App Runner", [
    "Build single-manifest linux/amd64 image (docker buildx --provenance=false) — serves the UI via dev:app",
    "Push to ECR repo harness-apps/<APP_NAME>",
    "Create/update the App Runner service from apprunner.json (least-privilege ECR access role)",
    "Optional: associate the vanity domain <owner>-<app>-v<ver>.apps.<domain> (skipped when no domain)",
    "Smoke test /health",
    "One-command apply: modules/aws-apprunner-deploy/deploy.sh (APP_DIR, APP_NAME[, DOMAIN])",
  ]);
} else if (target === "aws-ecs") {
  // ECS Fargate on a SHARED ALB — the cost-optimal path at fleet scale (one ALB,
  // wildcard cert, host-based routing; task scaled to zero when idle).
  fs.writeFileSync(
    "deploy/task-def.json",
    JSON.stringify(
      {
        family: NAME,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        executionRoleArn: "arn:aws:iam::<ACCOUNT>:role/ecsTaskExecutionRole",
        containerDefinitions: [
          {
            name: NAME,
            image: "<ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/harness-apps/<APP_NAME>:<TAG>",
            essential: true,
            portMappings: [{ containerPort: PORT, protocol: "tcp" }],
            environment: [{ name: "HARNESS_AGENT_MODE", value: "stub" }],
            healthCheck: { command: ["CMD-SHELL", `python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${PORT}/health').status==200 else 1)"`], interval: 30, timeout: 5, retries: 3, startPeriod: 20 },
            logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": `/ecs/harness-apps/${NAME}`, "awslogs-region": "<REGION>", "awslogs-stream-prefix": "app" } },
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    "deploy/alb-rule.json",
    JSON.stringify(
      {
        note: "Host-based rule added to the ONE shared ALB listener (wildcard *.apps.<domain>). Vanity host is OPTIONAL — without a domain the app is reached via the ALB DNS name + path.",
        Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["<owner>-<app>-v<ver>.apps.<domain>"] } }],
        Actions: [{ Type: "forward", TargetGroupArn: "<TARGET_GROUP_ARN>" }],
      },
      null,
      2,
    ),
  );
  writePlan("AWS ECS Fargate (shared ALB, scale-to-zero)", [
    "Build + push single-manifest linux/amd64 image to ECR harness-apps/<APP_NAME>",
    "Register task-def.json (Fargate, 256/512 — cheapest)",
    "Create/update the ECS service (desiredCount 0 → wake on first request) on the shared cluster",
    "Attach the target group to the shared ALB via alb-rule.json (wildcard listener; vanity host optional)",
    "Smoke test /health through the ALB",
  ]);
} else if (target === "cloud-run") {
  fs.writeFileSync(
    "deploy/service.yaml",
    [
      "apiVersion: serving.knative.dev/v1",
      "kind: Service",
      "metadata:",
      "  name: agentic-app",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - image: REGION-docker.pkg.dev/PROJECT/agentic-app/backend:latest",
      "          ports:",
      "            - containerPort: 8000",
      "",
    ].join("\n"),
  );
  writePlan("Cloud Run", [
    "Build + push backend image (Cloud Build)",
    "Apply service.yaml via gcloud run services replace",
    "Smoke test /health",
  ]);
} else {
  // local (or unknown): no cloud plan — the app runs from docker-compose / the dashboard preview.
  writePlan("Local", ["Run locally: docker-compose up (app + Postgres + Redis), or the dashboard app preview", "No cloud resources created — cloud is optional"]);
}

console.log(`deploy plan generated (${target})`);
