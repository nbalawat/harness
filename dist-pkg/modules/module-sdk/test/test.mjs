import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { scaffold } = await import(path.join(here, "..", "new-module.mjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "modsdk-"));
const dir = scaffold("my-neat-module", { modulesDir: tmp });
assert.ok(fs.existsSync(path.join(dir, "manifest.yaml")));
assert.ok(fs.existsSync(path.join(dir, "agent-guide.md")));
assert.ok(fs.existsSync(path.join(dir, "compose", "backend", "my_neat_module.py")));
assert.ok(fs.readFileSync(path.join(dir, "test", "test_my_neat_module.py"), "utf8").includes("def test_ping"));
assert.throws(() => scaffold("BadName", { modulesDir: tmp }), /lowercase-kebab/);
assert.throws(() => scaffold("my-neat-module", { modulesDir: tmp }), /already exists/);
console.log("module-sdk OK");
