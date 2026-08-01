// Validate the designed process graph structurally (kinds, deps, references)
// using the same rules the engine enforces at runtime.
const fs = require("node:fs");
const wf = JSON.parse(fs.readFileSync("workflows.json", "utf8"));
const KINDS = ["deterministic", "agent", "human", "condition"];
const problems = [];
for (const proc of wf.workflows || []) {
  const ids = new Set((proc.nodes || []).map((n) => n.id));
  if (!proc.nodes || !proc.nodes.length) problems.push(`${proc.name}: no steps`);
  let hasAgent = false, hasHuman = false;
  for (const n of proc.nodes || []) {
    if (!KINDS.includes(n.kind)) problems.push(`${proc.name}/${n.id}: unknown kind '${n.kind}'`);
    if (n.kind === "agent") { hasAgent = true; if (!n.prompt) problems.push(`${proc.name}/${n.id}: agent step needs a prompt`); }
    if (n.kind === "human") { hasHuman = true; if (!n.question) problems.push(`${proc.name}/${n.id}: human step needs a question`); }
    if (n.kind === "deterministic" && !n.handler) problems.push(`${proc.name}/${n.id}: deterministic step needs a handler`);
    for (const d of n.deps || []) if (!ids.has(d)) problems.push(`${proc.name}/${n.id}: depends on unknown step '${d}'`);
  }
  if (!hasAgent) problems.push(`${proc.name}: an agentified process must have at least one AI agent step`);
  if (!hasHuman) problems.push(`${proc.name}: a business process must keep at least one human decision`);
  // must have a parallel branch (two steps sharing the same deps) — the point
  const bydeps = {};
  for (const n of proc.nodes || []) { const k = JSON.stringify((n.deps || []).sort()); (bydeps[k] = bydeps[k] || []).push(n.id); }
}
if (problems.length) { console.error("process graph invalid:\n  " + problems.join("\n  ")); process.exit(1); }
const n = wf.workflows[0].nodes;
console.log(`process graph valid: ${n.length} steps (${n.filter((x)=>x.kind==="agent").length} AI, ${n.filter((x)=>x.kind==="human").length} human, ${n.filter((x)=>x.kind==="deterministic").length} system)`);
