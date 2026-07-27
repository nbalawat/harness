// compat-matrix: validate a module selection.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export function validate(modulesDir, picked) {
  const problems = [];
  const set = new Set(picked);
  for (const name of picked) {
    const manifestPath = path.join(modulesDir, name, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) {
      problems.push("unknown module '" + name + "'");
      continue;
    }
    const manifest = parse(fs.readFileSync(manifestPath, "utf8"));
    for (const req of manifest.requires ?? []) {
      if (typeof req === "string" && fs.existsSync(path.join(modulesDir, req)) && !set.has(req)) {
        problems.push(name + " requires " + req + " (not selected)");
      }
    }
    for (const conflict of manifest.conflicts ?? []) {
      if (set.has(conflict)) problems.push(name + " conflicts with " + conflict);
    }
  }
  return problems;
}

if (process.argv[2]) {
  const problems = validate(process.argv[2], process.argv.slice(3));
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
