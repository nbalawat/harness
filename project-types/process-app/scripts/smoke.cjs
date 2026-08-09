// Boot the produced app and drive a work item through the process graph:
// prove agents run, steps advance by dependency, and it parks at the human step.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const IS_WIN = process.platform === "win32";
const killTree = (child) => {
  if (!child || child.pid == null) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch { /* gone */ }
};

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
fs.cpSync(inputs.app.path, "app", { recursive: true });
const app = path.resolve("app");
const fail = (m) => { console.error(m); process.exit(1); };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

(async () => {
  const port = await freePort();
  const log = fs.openSync("smoke.log", "w");
  // stub agents so the smoke test is fast + deterministic (real agents run when booted for use)
  const child = spawn(`uv run --with fastapi --with uvicorn --with-requirements requirements.txt uvicorn main:app --host 127.0.0.1 --port ${port}`,
    { shell: true, detached: !IS_WIN, cwd: path.join(app, "backend"), env: { ...process.env, HARNESS_AGENT_MODE: "stub" }, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const kill = () => killTree(child);
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { up = true; break; } } catch {} }
    if (!up) fail("app did not boot:\n" + fs.readFileSync("smoke.log", "utf8").slice(-1200));
    const graph = await (await fetch(`http://127.0.0.1:${port}/api/process`)).json();
    if (!graph.steps || !graph.steps.length) fail("no process graph exposed");
    const agents = graph.steps.filter((s) => s.kind === "agent").length;
    const humans = graph.steps.filter((s) => s.kind === "human").length;
    // start a work item
    const run = await (await fetch(`http://127.0.0.1:${port}/api/process/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: { title: "Smoke Test Item", details: "A strong, well-referenced applicant for the smoke test." } }) })).json();
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/process/runs/${run.run_id}`)).json();
    const done = detail.steps.filter((s) => s.state === "done").length;
    if (detail.status !== "parked") fail(`expected the item to park at the human step; got '${detail.status}'. steps: ${JSON.stringify(detail.steps.map((s)=>[s.id,s.state]))}`);
    if (!detail.pending_human) fail("no human decision surfaced");
    // approve -> completes
    const after = await (await fetch(`http://127.0.0.1:${port}/api/process/runs/${run.run_id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: true }) })).json();
    if (after.status !== "completed") fail(`process did not complete after approval; got '${after.status}'`);
    fs.writeFileSync("smoke_report.json", JSON.stringify({ ok: true, steps: graph.steps.length, agent_steps: agents, human_steps: humans, ran_to: "completed", parked_at_human: detail.pending_human.step }, null, 2));
    console.log(`smoke PASS: ${graph.steps.length}-step process (${agents} AI, ${humans} human) — item ran through the graph, parked at '${detail.pending_human.step}', approved, completed`);
  } finally { kill(); }
})().catch((e) => fail(String(e)));
