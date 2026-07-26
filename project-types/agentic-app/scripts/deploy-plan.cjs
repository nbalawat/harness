// Deploy stage (conditional on architecture.deploy_target == cloud-run):
// produces the deploy plan + Cloud Run service spec. Actual apply is run by
// the user (or CI) after review — the harness never touches cloud directly.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const arch = inputs.architecture.data;

fs.mkdirSync("deploy", { recursive: true });
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
fs.writeFileSync(
  "deploy/plan.md",
  [
    "# Deploy plan (Cloud Run)",
    "",
    `Modules: ${arch.modules.join(", ")}`,
    "",
    "1. Build + push backend image (Cloud Build)",
    "2. Apply service.yaml via gcloud run services replace",
    "3. Smoke test /health",
    "",
  ].join("\n"),
);
console.log("deploy plan generated");
