import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(here, "..", "tls-local.sh"), "utf8");
assert.ok(script.includes("subjectAltName=DNS:localhost,IP:127.0.0.1"), "SANs present — bare CN certs are rejected by modern clients");
assert.ok(script.includes("-nodes") && script.includes("set -euo pipefail"));
console.log("tls-local OK");
