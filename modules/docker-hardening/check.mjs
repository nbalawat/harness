// docker-hardening checker.
import * as fs from "node:fs";

export function checkDockerfile(text) {
  const violations = [];
  if (/^FROM [^:\n]+$/m.test(text) || /:latest\b/.test(text)) violations.push("base image must be version-pinned (no :latest, no unpinned)");
  const lines = text.split("\n");
  const userIdx = lines.findIndex((l) => /^USER /.test(l) && !/USER root/.test(l));
  const cmdIdx = lines.findIndex((l) => /^(CMD|ENTRYPOINT) /.test(l));
  if (userIdx === -1) violations.push("no non-root USER");
  else if (cmdIdx !== -1 && userIdx > cmdIdx) violations.push("USER must come before CMD/ENTRYPOINT");
  if (/^ADD /m.test(text)) violations.push("use COPY, not ADD");
  if (/curl[^\n]*\|\s*(ba)?sh/.test(text)) violations.push("no curl|sh installs");
  return violations;
}

const file = process.argv[2];
if (file) {
  const violations = checkDockerfile(fs.readFileSync(file, "utf8"));
  for (const v of violations) console.error(v);
  process.exit(violations.length ? 1 : 0);
}
