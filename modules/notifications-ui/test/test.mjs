import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_notify.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const q = [];
api.push(q, { text: "SLA at risk", severity: "warn" });
api.push(q, { text: "SLA at risk", severity: "warn" });
api.push(q, { text: "saved", severity: "info" });
assert.equal(q.length, 2, "consecutive duplicates collapse");
assert.equal(api.summarize(q[0]), "SLA at risk (\u00d72)");
for (let i = 0; i < 60; i++) api.push(q, { text: "n" + i });
assert.equal(q.length, 50, "queue capped");
console.log("notifications-ui OK");
