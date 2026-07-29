import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "compose", "frontend", "mod_router.js"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", src)(module_, module_.exports);
const api = module_.exports;

assert.equal(api.resolve("#screen-history", ["screen-chat", "screen-history"]), "screen-history");
assert.equal(api.resolve("#screen-nope", ["screen-chat", "screen-history"]), "screen-chat", "unknown falls back to first");
assert.equal(api.resolve("", ["screen-chat"]), "screen-chat");
console.log("screen-router OK");
