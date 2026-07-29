import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { checkHtml } = await import(path.join(here, "..", "check.mjs"));

const bad = checkHtml('<html><body><input id="x"><button></button></body></html>');
assert.equal(bad.length, 3, "missing lang + unlabeled input + empty button");

const good = checkHtml('<html lang="en"><body><label for="x">Name</label><input id="x"><button>Send</button><input type="hidden"></body></html>');
assert.deepEqual(good, []);
console.log("a11y-baseline OK");
