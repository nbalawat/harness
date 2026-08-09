// Certify the runtime base structurally — no image build required. Assert the
// compose stack + Dockerfile encode the local-first, production-shaped contract.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const compose = fs.readFileSync(path.join(here, "..", "compose", "docker-compose.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(here, "..", "compose", "Dockerfile"), "utf8");

// --- the stack: app + real Postgres + Redis ---
for (const svc of ["app:", "db:", "redis:"]) {
  assert.ok(compose.includes(svc), `compose must declare service ${svc}`);
}
assert.ok(/image:\s*postgres:16\.\d/.test(compose), "db must be a pinned Postgres image");
assert.ok(/image:\s*redis:7\.\d/.test(compose), "redis must be a pinned Redis image");
assert.ok(!/image:\s*\S+:latest/.test(compose), "no :latest image tags");

// --- the store swap: DATABASE_URL points the app at the db service ---
assert.ok(/DATABASE_URL:\s*postgres:\/\/\S+@db:5432/.test(compose), "app must get DATABASE_URL -> db service");

// --- app waits for its deps to be healthy (no boot race) ---
assert.ok(/depends_on:[\s\S]*db:[\s\S]*condition:\s*service_healthy/.test(compose), "app depends on db healthy");
assert.ok(compose.includes("pg_isready"), "db must have a healthcheck");

// --- the image: pinned bases, non-root, carries Node for the MCP servers ---
assert.ok(/FROM\s+python:3\.\d/.test(dockerfile), "app image pinned to a Python version");
assert.ok(/FROM\s+node:\d/.test(dockerfile), "image must stage a pinned Node for the MCP servers");
assert.ok(/COPY --from=node .*\/node/.test(dockerfile), "the Node binary must be copied into the runtime image");
assert.ok(/USER\s+appuser/.test(dockerfile), "container must run non-root");
assert.ok(!/FROM\s+\S+:latest/.test(dockerfile), "no :latest base images");
const userIdx = dockerfile.indexOf("USER appuser");
const cmdIdx = dockerfile.indexOf("CMD");
assert.ok(userIdx > 0 && userIdx < cmdIdx, "USER must precede CMD");

console.log("runtime-compose OK");
