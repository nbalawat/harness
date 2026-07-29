import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { checkDockerfile } = await import(path.join(here, "..", "check.mjs"));

const bad = checkDockerfile("FROM python:latest\nADD . /app\nRUN curl x | sh\nCMD [\"app\"]\nUSER appuser\n");
assert.ok(bad.length >= 4, "latest + ADD + curl|sh + USER after CMD all flagged: " + bad);
console.log("docker-hardening OK");
