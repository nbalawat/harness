// Auto-approver: drives the live build like an engaged-but-busy user.
// Parks -> answers substantively; review windows -> approves within seconds;
// logs every decision it makes on the user's behalf.
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const WS = process.argv[2];
const CLI = "packages/cli/dist/index.js";
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

const events = () => fs.existsSync(`${WS}/journal.jsonl`)
  ? fs.readFileSync(`${WS}/journal.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const answered = new Set();

// DETACHED, never spawnSync: a synchronous resume blocks this polling loop
// for the entire remainder of the run — which is exactly how a review window
// once expired unanswered while the driver sat inside spawnSync. The resume
// runs on its own; the loop keeps watching the journal and answering windows.
let resuming = false;
function resumeWith(nodeId, answers, extraArgs = []) {
  if (resuming) { log(`resume already in flight — skipping duplicate for ${nodeId}`); return; }
  resuming = true;
  fs.writeFileSync(`.drive/ans-${nodeId}.json`, JSON.stringify({ [nodeId]: answers }));
  log(`answering ${nodeId}: ${JSON.stringify(answers).slice(0, 140)}`);
  const out = fs.openSync(`.drive/resume-${nodeId}.log`, "a");
  const child = spawn(
    process.execPath,
    [CLI, "resume", WS, ...(answers ? ["--answers", `.drive/ans-${nodeId}.json`] : []), ...extraArgs],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.on("exit", (code) => { resuming = false; log(`resume(${nodeId}) exited ${code}`); });
  child.unref();
}

function artifact(name) {
  try { return JSON.parse(fs.readFileSync(`${WS}/artifacts/${name}`, "utf8")); } catch { return null; }
}

for (let i = 0; i < 4000; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const ev = events();
  if (ev.some((e) => e.type === "run.completed")) { log("RUN COMPLETED"); break; }
  if (ev.some((e) => e.type === "run.failed")) { log("RUN FAILED"); break; }

  // open review window -> approve via ui-answers (the live process polls it)
  const win = [...ev].reverse().find((e) => e.type === "gate.window_open");
  if (win && !ev.some((e) => e.type === "gate.answered" && e.nodeId === win.nodeId)) {
    const ui = fs.existsSync(`${WS}/ui-answers.json`) ? JSON.parse(fs.readFileSync(`${WS}/ui-answers.json`, "utf8")) : {};
    if (!ui[win.nodeId]) {
      ui[win.nodeId] = { verdict: "yes" };
      fs.writeFileSync(`${WS}/ui-answers.json`, JSON.stringify(ui));
      log(`checkpoint ${win.nodeId}: approved via review window`);
    }
    continue;
  }

  // A park is only ACTIVE if it's the latest run-lifecycle event — stale
  // parks from earlier gates must not trigger duplicate resumes.
  const lastLifecycle = [...ev].reverse().find((e) => ["run.parked", "run.completed", "run.failed", "run.created"].includes(e.type));
  const running = ev.filter((e) => e.type === "node.running").length > ev.filter((e) => e.type === "node.committed" || e.type === "node.failed" || e.type === "node.parked").length;
  if (!lastLifecycle || lastLifecycle.type !== "run.parked") continue;
  // and nothing may have started since the park
  const parkIdx = ev.lastIndexOf(lastLifecycle);
  if (ev.slice(parkIdx).some((e) => e.type === "node.running" || e.type === "agent.message")) continue;
  const lastPark = [...ev].reverse().find((e) => e.type === "node.parked");
  const nodeId = lastPark?.nodeId;
  if (!nodeId || answered.has(nodeId + ":" + ev.length)) continue;
  answered.add(nodeId + ":" + ev.length);

  if (nodeId === "clarify") {
    const gaps = artifact("gap-questions/gaps.json");
    const ans = {};
    for (const q of gaps?.questions ?? []) ans[q.id] = q.default ?? "yes";
    // substantive feedback at the requirements stage:
    const keys = Object.keys(ans);
    if (keys.length) ans[keys[0]] = (ans[keys[0]] ?? "") + " — and the SLA dashboard must highlight deals aging past 5 business days in red with an escalation owner.";
    resumeWith("clarify", ans);
  } else if (nodeId === "design-select") {
    resumeWith("design-select", { chosen_option: "option-2" });
  } else if (nodeId === "design-review") {
    const qs = null;
    resumeWith("design-review", { approve_design: "yes" });
  } else if (nodeId === "uat") {
    resumeWith("uat", { approved: "yes" });
  } else if (nodeId) {
    // generic: accept defaults for anything unforeseen
    resumeWith(nodeId, null, ["--accept-defaults"]);
  }
}
