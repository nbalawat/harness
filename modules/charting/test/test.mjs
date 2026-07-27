import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_chart.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const s = api.scale([5, 10], 100);
assert.equal(s.min, 0, "bar scale includes zero even when all values positive");
assert.equal(s.y(0), 100);
assert.equal(s.y(10), 0);
const pts = api.linePoints([0, 5, 10], 200, 100);
assert.deepEqual(pts[0], [0, 100]);
assert.deepEqual(pts[2], [200, 0]);
assert.deepEqual(api.ticks(97, 4), [0, 30, 60, 90], "round ticks");
console.log("charting OK");
