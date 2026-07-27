import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { validate } = await import(path.join(here, "..", "check.mjs"));
const modulesDir = path.resolve(here, "..", "..");

assert.deepEqual(validate(modulesDir, ["persistence-core", "agent-runtime", "chat-shell", "audit-log"]), []);
const missing = validate(modulesDir, ["data-retention"]);
assert.ok(missing.some((p) => p.includes("requires soft-delete")), "module deps must be selected: " + missing);
assert.ok(validate(modulesDir, ["no-such-module"]).length === 1);
console.log("compat-matrix OK");
