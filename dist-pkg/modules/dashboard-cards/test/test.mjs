import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_cards.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const rows = [{ usd: 2.5 }, { usd: 1.5 }, { usd: 6 }];
assert.equal(api.compute(rows, { metric: "sum", field: "usd" }), 10);
assert.equal(api.compute(rows, { metric: "avg", field: "usd" }), 10 / 3);
assert.equal(api.compute([], { metric: "avg", field: "usd" }), 0, "empty avg is 0, not NaN");
assert.equal(api.compute(rows, { metric: "latest", field: "usd" }), 6);
assert.equal(api.format(1234567, "int"), "1,234,567");
assert.equal(api.format(2.5, "money"), "$2.50");
assert.equal(api.format(null), "—");
console.log("dashboard-cards OK");
