import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_admin.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const chosen = api.sections(["roles", "costs", "nonsense"]);
assert.deepEqual(chosen.map((s) => s.id), ["roles", "costs"], "only composed capabilities appear");
assert.ok(api.KNOWN.every((s) => s.endpoint.startsWith("/admin/")), "admin surfaces stay under /admin");
console.log("admin-console OK");
