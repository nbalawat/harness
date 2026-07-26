// Mock agent payload: deterministic stand-in for the SDK session.
// Reads inputs.json from cwd (the attempt dir), writes plan.json per contract.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const name = inputs.intake.data.project_name;

fs.writeFileSync(
  "plan.json",
  JSON.stringify(
    {
      title: `Build plan for ${name}`,
      sections: ["Overview", "Architecture", "Build Steps", "Verification"],
    },
    null,
    2,
  ),
);
