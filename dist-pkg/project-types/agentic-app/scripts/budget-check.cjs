// The architecture's build-budget plan must fit inside the certified envelope.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const plan = inputs.architecture.data.build_budget_plan;

const dag = fs.readFileSync(path.join(process.env.HARNESS_PROJECT_DIR, "dag.yaml"), "utf8");
const match = dag.match(/run_budget_usd:\s*([\d.]+)/);
const envelope = match ? Number(match[1]) : Infinity;

const nodeSum = Object.values(plan.nodes).reduce((a, b) => a + b, 0);
if (Math.abs(nodeSum - plan.total_usd) > 0.001) {
  console.error(`budget plan inconsistent: nodes sum to ${nodeSum}, total says ${plan.total_usd}`);
  process.exit(1);
}
if (plan.total_usd > envelope) {
  console.error(`build budget plan $${plan.total_usd} exceeds run envelope $${envelope}`);
  process.exit(1);
}
console.log(`build budget plan $${plan.total_usd} fits envelope $${envelope}`);
