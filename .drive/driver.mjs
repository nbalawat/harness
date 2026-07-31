// Auto-approver: drives the live build like an engaged-but-busy user.
// Parks -> answers substantively; review windows -> approves within seconds;
// logs every decision it makes on the user's behalf.
import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
const WS = process.argv[2];
const CLI = "packages/cli/dist/index.js";
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

const events = () => fs.existsSync(`${WS}/journal.jsonl`)
  ? fs.readFileSync(`${WS}/journal.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const answered = new Set();

function resumeWith(nodeId, answers) {
  fs.writeFileSync(`.drive/ans-${nodeId}.json`, JSON.stringify({ [nodeId]: answers }));
  log(`answering ${nodeId}: ${JSON.stringify(answers).slice(0, 140)}`);
  const r = spawnSync(process.execPath, [CLI, "resume", WS, "--answers", `.drive/ans-${nodeId}.json`], { encoding: "utf8" });
  log(`resume(${nodeId}) exited ${r.status}`);
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

  const parked = [...ev].reverse().find((e) => e.type === "run.parked");
  if (!parked) continue;
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
    const r = spawnSync(process.execPath, [CLI, "resume", WS, "--accept-defaults"], { encoding: "utf8" });
    log(`generic resume(${nodeId}) exited ${r.status}`);
  }
}
