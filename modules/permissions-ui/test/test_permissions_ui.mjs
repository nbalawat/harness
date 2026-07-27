import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// Browser script: evaluate with a CJS shim (loader semantics don't apply).
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_permissions.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const { rolesToRows } = module_.exports;

const rows = rolesToRows({ bob: ["viewer"], ana: ["admin", "approver"] });
assert.deepEqual(rows.map((r) => r.user), ["ana", "bob"], "sorted by user");
assert.equal(rows[0].roles, "admin, approver");
console.log("permissions-ui logic OK");
