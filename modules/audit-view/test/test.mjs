import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_auditview.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const line = api.formatEntry({ event: "workflow.approved", at: "2026-07-27T10:00:00Z", detail: { by: "ana", reason: "looks right" } });
assert.equal(line, "2026-07-27T10:00:00Z  workflow approved by ana — looks right");
assert.equal(api.formatEntry({ event: "session.login", detail: { user: "bob" } }), "session login by bob");
console.log("audit-view OK");
