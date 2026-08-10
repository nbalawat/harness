import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = fs.readFileSync(path.join(here, "..", "deploy.sh"), "utf8");
const boto = fs.readFileSync(path.join(here, "..", "apprunner_deploy.py"), "utf8");

// deploy.sh: build + push + delegate.
assert.ok(/set -euo pipefail/.test(deploy), "strict mode");
assert.ok(deploy.includes("USER appuser"), "container runs as non-root");
assert.ok(deploy.includes("scanOnPush=true"), "ECR scans images on push");
assert.ok(deploy.includes("--provenance=false"), "single-manifest image (App Runner-safe)");
assert.ok(deploy.includes("dev:app"), "serves the static frontend via dev:app when present");
assert.ok(deploy.includes("apprunner_deploy.py"), "delegates the App Runner control plane to the version-independent boto3 helper");

// apprunner_deploy.py: least-privilege role, TCP health, live URL, optional domain.
assert.ok(boto.includes("AWSAppRunnerServicePolicyForECRAccess"), "least-privilege AWS-managed ECR access policy, not a broad grant");
assert.ok(boto.includes('"Protocol": "TCP"'), "TCP health check (reliable during CREATE)");
assert.ok(boto.includes("LIVE_URL="), "prints a live URL even with no domain");
assert.ok(boto.includes('if DOMAIN'), "custom domain is optional");

const rollback = fs.readFileSync(path.join(here, "..", "rollback.sh"), "utf8");
assert.ok(rollback.includes("update-service"), "rollback is a config repoint, not a rebuild");
assert.ok(rollback.includes("PREV_TAG"), "rollback targets a specific prior image tag");
console.log("aws-apprunner-deploy OK");
