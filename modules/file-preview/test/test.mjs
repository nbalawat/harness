import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_preview.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

assert.equal(api.rendererFor("notes.TXT"), "text");
assert.equal(api.rendererFor("scan.png"), "image");
assert.equal(api.rendererFor("report.docx"), "download", "no iframes for unknown types");
console.log("file-preview OK");
