import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = fs.readFileSync(path.join(here, "..", "cloud-run.sh"), "utf8");
assert.ok(deploy.includes("--no-traffic"), "deploys never take traffic directly");
assert.ok(deploy.indexOf("--no-traffic") < deploy.indexOf("update-traffic"), "traffic shift only after deploy");
assert.ok(/set -euo pipefail/.test(deploy), "strict mode");
const rollback = fs.readFileSync(path.join(here, "..", "rollback.sh"), "utf8");
assert.ok(rollback.includes("update-traffic"), "rollback is a traffic shift, not a rebuild");
console.log("cloud-run-deploy OK");
