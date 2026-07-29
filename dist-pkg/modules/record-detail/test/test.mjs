import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_recorddetail.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

const fields = api.fields({ user_name: "ana", note: "" }, ["user_name", "note"], { note: "Analyst note" });
assert.deepEqual(fields[0], { label: "User Name", value: "ana" });
assert.deepEqual(fields[1], { label: "Analyst note", value: "—" }, "empty shows em dash");
console.log("record-detail OK");
