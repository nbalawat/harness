// The improvement loop's capture step: remediation waves -> classified
// promotion candidates for the certified layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractLessons } from "../dist/lessons.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-lessons-"));
}

test("lessons: remediation waves classify into the right promotion targets", () => {
  const ws = tmp();
  const T = "2026-08-01T10:00:00.000Z";
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  fs.writeFileSync(path.join(ws, "journal.jsonl"), [
    ev({ type: "run.completed" }),
    // scan-detectable authz pattern
    ev({ type: "node.reopened", nodeId: "slice-1", reason: "user_revision", feedback: "SECURITY: _readable_deal uses opt-out 'if acting_user_email:' — anonymous callers skip scoping. Make it default-deny." }),
    ev({ type: "node.running", nodeId: "slice-1" }),
    ev({ type: "node.committed", nodeId: "slice-1" }),
    // substrate/module fix
    ev({ type: "node.reopened", nodeId: "slice-1", reason: "user_revision", feedback: "SECURITY SCAN: the composed module ext_audit.py predates the hardened catalog — bring it to the certified module standard." }),
    ev({ type: "node.running", nodeId: "slice-1" }),
    ev({ type: "node.committed", nodeId: "slice-1" }),
    // merge discipline -> skill
    ev({ type: "node.reopened", nodeId: "slice-2", reason: "user_revision", feedback: "MERGE CONFLICT: app.js must be a pure append; rebase on the current foundation first." }),
    ev({ type: "node.running", nodeId: "slice-2" }),
    ev({ type: "node.committed", nodeId: "slice-2" }),
    // grounding -> plan requirement
    ev({ type: "node.reopened", nodeId: "slice-3", reason: "user_revision", feedback: "FUNCTIONAL GAP: the agent acceptance check must prove grounding in real records, not just a 200." }),
  ].join("\n") + "\n");

  const { lessons, summary } = extractLessons(ws);
  assert.equal(lessons.length, 4);
  const byStep = Object.fromEntries(lessons.map((l) => [l.finding.slice(0, 12), l.suggested_promotion]));
  const promo = (needle) => lessons.find((l) => l.finding.includes(needle))?.suggested_promotion;
  assert.equal(promo("opt-out"), "scan-rule", "greppable authz pattern -> deterministic scan rule");
  assert.equal(promo("composed module"), "module-fix", "module surface -> fix the substrate once");
  assert.equal(promo("pure append"), "skill-convention", "build discipline -> certified skill");
  assert.equal(promo("prove grounding"), "plan-requirement", "verification obligation -> prompt + gate");
  assert.equal(summary.total, 4);
});

test("lessons: batched revisions are one wave; a clean run yields nothing", () => {
  const ws = tmp();
  const T = "2026-08-01T10:00:00.000Z";
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  // two revisions with NO engine activity between -> one wave, two lessons
  fs.writeFileSync(path.join(ws, "journal.jsonl"), [
    ev({ type: "node.reopened", nodeId: "slice-1", reason: "user_revision", feedback: "MERGE CONFLICT: rebase first." }),
    ev({ type: "node.reopened", nodeId: "slice-2", reason: "user_revision", feedback: "MERGE CONFLICT: pure append." }),
  ].join("\n") + "\n");
  const { lessons } = extractLessons(ws);
  assert.equal(new Set(lessons.map((l) => l.wave)).size, 1, "batched revisions collapse into one wave");
  assert.equal(lessons.length, 2);

  const clean = tmp();
  fs.writeFileSync(path.join(clean, "journal.jsonl"), JSON.stringify({ ts: T, type: "run.completed" }) + "\n");
  assert.equal(extractLessons(clean).lessons.length, 0, "a clean build teaches nothing");
});
