import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_datatable.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const rows = [{ n: "b", qty: 2 }, { n: "a", qty: 10 }, { n: "c", qty: 1 }];
assert.deepEqual(api.prepare(rows, { sort: "qty" }).rows.map((r) => r.qty), [1, 2, 10], "numeric sort");
assert.deepEqual(api.prepare(rows, { sort: "-n" }).rows.map((r) => r.n), ["c", "b", "a"], "desc string sort");
assert.equal(api.prepare(rows, { filter: "A" }).total, 1, "case-insensitive filter");
const paged = api.prepare(rows, { pageSize: 2, page: 2 });
assert.equal(paged.rows.length, 1);
assert.equal(paged.pages, 2);
console.log("data-table OK");
