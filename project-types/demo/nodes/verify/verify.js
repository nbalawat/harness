// Verifier node: executable exit criteria. Exit 0 = the node upstream is done.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const plan = inputs.plan.data;
const readme = fs.readFileSync(inputs.readme.path, "utf8");

if (!readme.includes(plan.title)) {
  console.error(`README does not contain plan title: "${plan.title}"`);
  process.exit(1);
}
if (plan.sections.some((s) => !readme.includes(s))) {
  console.error("README is missing one or more plan sections");
  process.exit(1);
}
console.log("verified: README matches plan");
