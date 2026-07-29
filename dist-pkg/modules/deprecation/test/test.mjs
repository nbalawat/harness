import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { survey } = await import(path.join(here, "..", "check.mjs"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "depr-"));
for (const [name, manifest] of [
  ["old-thing", "name: old-thing\ndeprecated: true\nsuccessor: new-thing\n"],
  ["new-thing", "name: new-thing\n"],
  ["orphan", "name: orphan\ndeprecated: true\n"],
]) {
  fs.mkdirSync(path.join(tmp, name), { recursive: true });
  fs.writeFileSync(path.join(tmp, name, "manifest.yaml"), manifest);
}
const { deprecated, problems } = survey(tmp);
assert.deepEqual(deprecated, [{ name: "old-thing", successor: "new-thing" }]);
assert.ok(problems[0].includes("orphan"), "deprecation without successor is invalid");
console.log("deprecation OK");
