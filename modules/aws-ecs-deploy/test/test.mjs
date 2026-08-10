import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = fs.readFileSync(path.join(here, "..", "deploy.sh"), "utf8");

assert.ok(/set -euo pipefail/.test(deploy), "strict mode");
assert.ok(deploy.includes("USER appuser"), "non-root container");
assert.ok(deploy.includes("scanOnPush=true"), "ECR scan on push");
assert.ok(deploy.includes("--provenance=false"), "single-manifest image (App Runner/ECS-safe)");
assert.ok(deploy.includes("--desired-count 0"), "scale-to-zero by default (cheapest)");
assert.ok(deploy.includes("host-header"), "shared ALB host-based routing");
assert.ok(deploy.includes('if [ -n "${DOMAIN:-}" ]'), "vanity domain optional");
assert.ok(deploy.includes("AmazonECSTaskExecutionRolePolicy"), "least-privilege execution role");

const rollback = fs.readFileSync(path.join(here, "..", "rollback.sh"), "utf8");
assert.ok(rollback.includes("update-service") && rollback.includes("PREV_REVISION"), "rollback is a revision repoint");
console.log("aws-ecs-deploy OK");
