// Workflow definitions verifier: structure + implementability + traceability.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const { workflows } = JSON.parse(fs.readFileSync("workflows.json", "utf8"));
const reqIds = new Set(inputs.requirements.data.requirements.map((r) => r.id));

const KINDS = new Set(["deterministic", "agent", "human", "condition"]);
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

for (const wf of workflows) {
  const ids = new Set();
  for (const reqId of wf.addresses) {
    if (!reqIds.has(reqId)) fail(`workflow '${wf.name}' addresses unknown requirement ${reqId}`);
  }
  for (const node of wf.nodes) {
    if (ids.has(node.id)) fail(`workflow '${wf.name}': duplicate node '${node.id}'`);
    ids.add(node.id);
    if (!KINDS.has(node.kind)) fail(`workflow '${wf.name}/${node.id}': unknown kind '${node.kind}'`);
    if (node.kind === "deterministic" && !/^[a-z][a-z0-9_]+$/.test(node.handler ?? "")) fail(`'${wf.name}/${node.id}': deterministic node needs a snake_case handler`);
    if (node.kind === "agent" && !node.prompt) fail(`'${wf.name}/${node.id}': agent node needs a prompt`);
    if (node.kind === "human" && !node.question) fail(`'${wf.name}/${node.id}': human node needs a question`);
    if (node.kind === "condition" && (node.path === undefined || node.equals === undefined)) fail(`'${wf.name}/${node.id}': condition needs path + equals`);
  }
  for (const node of wf.nodes) {
    if (node.on_false && node.on_false !== "end" && !ids.has(node.on_false)) fail(`'${wf.name}/${node.id}': on_false -> unknown node '${node.on_false}'`);
  }
  const kinds = new Set(wf.nodes.map((n) => n.kind));
  if (!kinds.has("human") && !kinds.has("condition")) {
    fail(`workflow '${wf.name}' has no human gate or condition — a straight agent pipe is a chat feature, not a process`);
  }
}
console.log(`${workflows.length} workflow definition(s) verified: structure, handlers, traceability`);
